// pm-reminders — Supabase Edge Function
//
// Once a day: remind customers about preventive maintenance due within the
// next 7 days, one push notification per customer account. Scheduled by
// supabase/setup/pm_reminders_cron.sql (pg_cron + pg_net).
//
// Deploy:   supabase functions deploy pm-reminders --no-verify-jwt
// Secrets:  VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (same as send-push)
//           PM_REMINDERS_SECRET  — any long random string; the cron job sends
//                                  it in the x-cron-secret header
//
// Each unit is reminded once per PM date (pm_reminder_log). A unit that
// already has an open service request is skipped — the customer has
// already booked it.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

webpush.setVapidDetails(
  Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@example.com',
  Deno.env.get('VAPID_PUBLIC_KEY')!,
  Deno.env.get('VAPID_PRIVATE_KEY')!
);
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

const WINDOW_DAYS = 7;
const OPEN_REQUEST = ['new', 'acknowledged', 'fee_proposed', 'fee_accepted', 'schedule_proposed',
  'schedule_confirmed', 'preparing', 'dispatched', 'en_route', 'in_progress'];

// Dates in Philippine time — the PM date is a local calendar date.
function manilaDate(offsetDays = 0): string {
  const d = new Date(Date.now() + 8 * 3600e3 + offsetDays * 86400e3);
  return d.toISOString().slice(0, 10);
}
function fmt(iso: string): string {
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-PH', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

Deno.serve(async (req) => {
  const secret = Deno.env.get('PM_REMINDERS_SECRET');
  if (!secret || req.headers.get('x-cron-secret') !== secret) {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
  }
  try {
    const today = manilaDate(0), until = manilaDate(WINDOW_DAYS);

    const { data: units, error } = await admin.from('customer_equipment')
      .select('id, customer_id, label, equip_location, next_pm_date')
      .gte('next_pm_date', today).lte('next_pm_date', until);
    if (error) throw error;
    if (!units?.length) return json({ due: 0, sent: 0 });

    const ids = units.map((u) => String(u.id));
    const { data: logged } = await admin.from('pm_reminder_log').select('equipment_id, pm_date').in('equipment_id', ids);
    const done = new Set((logged ?? []).map((l) => l.equipment_id + '|' + l.pm_date));

    const { data: openReqs } = await admin.from('service_requests')
      .select('equipment_id, status').in('equipment_id', units.map((u) => u.id)).in('status', OPEN_REQUEST);
    const booked = new Set((openReqs ?? []).map((r) => String(r.equipment_id)));

    const todo = units.filter((u) => !done.has(String(u.id) + '|' + u.next_pm_date) && !booked.has(String(u.id)));
    if (!todo.length) return json({ due: units.length, sent: 0 });

    // One notification per customer account.
    const byCustomer = new Map<string, typeof todo>();
    todo.forEach((u) => {
      const k = String(u.customer_id);
      if (!byCustomer.has(k)) byCustomer.set(k, []);
      byCustomer.get(k)!.push(u);
    });

    let sent = 0;
    const dead: string[] = [];
    for (const [customerId, list] of byCustomer) {
      const first = list.map((u) => u.next_pm_date).sort()[0];
      const name = (u: any) => (u.label || u.equip_location || 'Your unit').trim();
      const title = 'Maintenance due soon';
      const body = list.length === 1
        ? name(list[0]) + ' is due for preventive maintenance on ' + fmt(list[0].next_pm_date) + '. Open the app to book a visit.'
        : list.length + ' units are due for preventive maintenance from ' + fmt(first) + '. Open the app to book a visit.';
      const payload = JSON.stringify({ title, body, url: '/', tag: 'pm-due-' + customerId });

      const { data: subs } = await admin.from('push_subscriptions').select('*')
        .eq('role', 'customer').eq('customer_id', customerId);
      await Promise.all((subs ?? []).map(async (s) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
          sent++;
        } catch (e: any) {
          if (e?.statusCode === 404 || e?.statusCode === 410) dead.push(s.endpoint);
          else console.error('pm push failed', e?.statusCode, e?.body ?? e?.message);
        }
      }));
      // Logged even with no subscribed device, so a customer who turns on
      // notifications later isn't flooded with old reminders.
      await admin.from('pm_reminder_log').upsert(
        list.map((u) => ({ equipment_id: String(u.id), pm_date: u.next_pm_date, customer_id: String(u.customer_id) })),
        { onConflict: 'equipment_id,pm_date', ignoreDuplicates: true }
      );
    }
    if (dead.length) await admin.from('push_subscriptions').delete().in('endpoint', dead);
    return json({ due: units.length, customers: byCustomer.size, sent, pruned: dead.length });
  } catch (e) {
    console.error('pm-reminders error', e);
    return json({ error: String(e) }, 500);
  }
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

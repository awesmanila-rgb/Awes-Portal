// inbox-escalations — Supabase Edge Function (Round 3)
//
// Every 15 minutes: find inbox items that have waited past their
// escalation time and notify, once each:
//   level 1  the department's Heads (or the Super Admin if it has none)
//   level 2  the Super Admin, at twice the escalation time
// Response times are in inbox_sla (Super Admin: Inbox → Response times).
// Scheduled by supabase/setup/inbox_escalations_cron.sql (pg_cron + pg_net).
//
// Deploy:   supabase functions deploy inbox-escalations --no-verify-jwt
// Secrets:  VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (same as send-push)
//           INBOX_ESCALATIONS_SECRET — any long random string; the cron job
//                                      sends it in the x-cron-secret header
//
// Each notification is recorded in inbox_escalation_log whether or not the
// person has a device registered, so someone who turns notifications on
// later isn't flooded with old ones. Several items for one person in the
// same run become a single "N items need attention" notification.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

webpush.setVapidDetails(
  Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@example.com',
  Deno.env.get('VAPID_PUBLIC_KEY')!,
  Deno.env.get('VAPID_PRIVATE_KEY')!
);
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

type Due = { key: string; kind: string; ref_id: string; ref_label: string; title: string; label: string;
             level: number; age_hours: number; module: string; recipients: string[] };

function waited(h: number): string {
  if (h < 48) return Math.round(h) + ' h';
  return Math.round(h / 24) + ' days';
}

Deno.serve(async (req) => {
  const secret = Deno.env.get('INBOX_ESCALATIONS_SECRET');
  if (!secret || req.headers.get('x-cron-secret') !== secret) {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
  }
  try {
    const { data, error } = await admin.rpc('inbox_escalations_due');
    if (error) throw error;
    const due = (data ?? []) as Due[];
    if (!due.length) return json({ due: 0, sent: 0 });

    // group by recipient
    const byUser = new Map<string, Due[]>();
    for (const d of due) for (const u of d.recipients ?? []) {
      if (!byUser.has(u)) byUser.set(u, []);
      byUser.get(u)!.push(d);
    }

    let sent = 0;
    const dead: string[] = [];
    for (const [userId, list] of byUser) {
      const top = list.slice().sort((a, b) => b.level - a.level || b.age_hours - a.age_hours)[0];
      const payload = JSON.stringify(list.length === 1
        ? { title: (top.level === 2 ? 'Still waiting: ' : 'Overdue: ') + top.label,
            body: [top.ref_label, top.title].filter(Boolean).join(' · ') + ' — waiting ' + waited(top.age_hours) + '. Open your Inbox.',
            url: '/?inbox=1', tag: 'inbox-' + top.key }
        : { title: list.length + ' items need attention',
            body: 'Oldest: ' + top.label + ' (' + waited(top.age_hours) + '). Open your Inbox.',
            url: '/?inbox=1', tag: 'inbox-batch-' + userId });
      const { data: subs } = await admin.from('push_subscriptions').select('*').eq('user_id', userId);
      await Promise.all((subs ?? []).map(async (s) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
          sent++;
        } catch (e: any) {
          if (e?.statusCode === 404 || e?.statusCode === 410) dead.push(s.endpoint);
          else console.error('inbox push failed', e?.statusCode, e?.body ?? e?.message);
        }
      }));
    }
    if (dead.length) await admin.from('push_subscriptions').delete().in('endpoint', dead);
    const { data: logged, error: mErr } = await admin.rpc('inbox_mark_sent', { p_rows: due });
    if (mErr) throw mErr;
    return json({ due: due.length, people: byUser.size, sent, logged, pruned: dead.length });
  } catch (e) {
    console.error('inbox-escalations error', e);
    return json({ error: String(e) }, 500);
  }
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

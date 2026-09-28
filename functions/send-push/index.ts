// send-push — Supabase Edge Function
//
// Sends a Web Push notification to one of a few fixed audiences. Deployed
// with:  supabase functions deploy send-push
// Secrets required (supabase secrets set ...):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (a mailto: URL)
//
// Design notes:
//   - The caller sends an AUDIENCE, never a raw list of endpoints or user
//     ids. Recipients are resolved here, under the service role. A client
//     that could name arbitrary recipients could spam any user in the
//     system, so that decision stays server-side.
//   - The caller's JWT is verified first. Anonymous callers get 401.
//   - A 404/410 from a push service means the browser threw the
//     subscription away (app uninstalled, permission revoked). That row is
//     deleted rather than retried forever.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

webpush.setVapidDetails(
  Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@example.com',
  Deno.env.get('VAPID_PUBLIC_KEY')!,
  Deno.env.get('VAPID_PRIVATE_KEY')!
);

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    // ---- 1. Authenticate the caller ----------------------------------
    const authHeader = req.headers.get('Authorization') ?? '';
    const jwt = authHeader.replace(/^Bearer\s+/i, '');
    if (!jwt) return json({ error: 'missing token' }, 401);

    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: 'invalid token' }, 401);
    const callerId = userData.user.id;

    // ---- 2. Read the request ----------------------------------------
    const body = await req.json();
    const { audience, customerId, userId, title, message, url, tag } = body ?? {};
    if (!audience || !title) return json({ error: 'audience and title are required' }, 400);

    // ---- 3. Resolve recipients (service role — bypasses RLS) ---------
    let q = admin.from('push_subscriptions').select('*');
    if (audience === 'admins') {
      q = q.eq('role', 'admin');
    } else if (audience === 'customer') {
      if (!customerId) return json({ error: 'customerId required' }, 400);
      q = q.eq('role', 'customer').eq('customer_id', customerId);
    } else if (audience === 'user') {
      if (!userId) return json({ error: 'userId required' }, 400);
      q = q.eq('user_id', userId);
    } else if (audience === 'technicians') {
      q = q.eq('role', 'tech');
    } else {
      return json({ error: 'unknown audience' }, 400);
    }

    const { data: subs, error: subErr } = await q;
    if (subErr) throw subErr;
    if (!subs?.length) return json({ sent: 0, note: 'no subscriptions for that audience' });

    // Never notify the person who triggered the event — they already know.
    const targets = subs.filter((s) => s.user_id !== callerId);

    const payload = JSON.stringify({
      title,
      body: message ?? '',
      url: url ?? '/',
      tag: tag ?? 'awes'
    });

    // ---- 4. Send, pruning dead endpoints -----------------------------
    let sent = 0;
    const dead: string[] = [];
    await Promise.all(
      targets.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            payload
          );
          sent++;
        } catch (e: any) {
          const code = e?.statusCode;
          if (code === 404 || code === 410) dead.push(s.endpoint);
          else console.error('push failed', code, e?.body ?? e?.message);
        }
      })
    );

    if (dead.length) {
      await admin.from('push_subscriptions').delete().in('endpoint', dead);
    }

    return json({ sent, pruned: dead.length });
  } catch (e) {
    console.error('send-push error', e);
    return json({ error: String(e) }, 500);
  }
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' }
  });
}

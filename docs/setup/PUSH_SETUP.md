# Push Notifications — Setup

Three things must be done in your Supabase project before notifications work.
The app files are already in place and will simply no-op until then.

---

## 1. Run the migration

`supabase/migrations/20260916_03_push_subscriptions.sql`

Creates the `push_subscriptions` table (one row per device per user) with RLS.
It ends with the schema reload, so no separate `NOTIFY` step.

---

## 2. Set the VAPID secrets

Generate a keypair on your own computer — never commit the private key to
this repo, and never paste it into chat, docs or code:

```bash
npx web-push generate-vapid-keys
```

Store both keys in Supabase only, plus a contact address (push services
require one — it just has to be a real `mailto:`):

```bash
supabase secrets set \
  VAPID_PUBLIC_KEY=<your public key> \
  VAPID_PRIVATE_KEY=<your private key> \
  VAPID_SUBJECT=mailto:you@yourdomain.com
supabase functions deploy send-push
```

Then put the PUBLIC key (and only the public key) into `PUSH_PUBLIC_KEY` in
`js/modules-src/push.js` and rebuild. The public key is safe to ship; the
private key must never leave Supabase.

**Rotating keys:** repeat the steps above with a new pair. Devices that
subscribed under the old key re-subscribe automatically the next time the
app opens (see `pushSubscribe` in push.js), so nobody has to turn
notifications off and on again.

The **public** key is also hard-coded in `js/modules-src/push.js` as
`PUSH_PUBLIC_KEY`. That is correct and safe — it only lets a browser create a
subscription addressed to your server. **If you ever regenerate the keypair,
you must update it in both places**, or existing devices will fail to
subscribe.

---

## 3. Deploy the Edge Function

```bash
supabase functions deploy send-push
```

The function verifies the caller's JWT, resolves recipients itself from an
*audience* (`admins`, `technicians`, `customer`, `user`), and prunes dead
endpoints. Clients never send a recipient list — that decision stays
server-side so a client can't address arbitrary users.

---

## Turning it on, per person

Notifications are **off until each person opts in on each device**. The
prompt is deliberately not shown on load: a permission dialog that appears
before someone knows what it's for usually gets dismissed, and a dismissal is
sticky — the browser won't ask again.

- **Admin** — sidebar cloud button → *Shared Cloud Setup* → *Turn on notifications*
- **Technician** — More → Profile → *Turn on notifications*
- **Customer** — Profile → *Turn on notifications*

---

## What triggers a notification

| Event | Who gets it |
|---|---|
| Customer submits a service request | Admins |
| Fee proposed | That customer |
| Schedule proposed | That customer |
| Customer confirms schedule | Admins |
| Customer requests cancellation of a dispatched job | Admins |
| Job order created | Each assigned technician + the customer |
| Technician taps On My Way | That customer |
| Technician acknowledges on site | That customer + admins |
| Job order closed | Admins (+ the customer if fully complete) |

The person who triggered an event is never notified about their own action.

---

## Platform notes

- **Android / Chrome** — works installed or in the browser. Sound and
  vibration are left to the OS: `silent` is false, so Android plays the
  user's own notification sound and honours Do Not Disturb. Forcing a
  custom sound would override settings people chose deliberately.
- **iOS / Safari** — requires iOS **16.4+** *and* the PWA must be installed
  to the Home Screen. Web Push does not work in a normal Safari tab. If your
  technicians are on iPhones, they must "Add to Home Screen" first.
- **Desktop Chrome/Edge/Firefox** — works.

---

## Testing

1. Turn notifications on for two different accounts on two devices (or two
   browser profiles).
2. As the customer, submit a service request → the admin device should get
   "New service request" with the app closed.
3. As admin, create a dispatch ticket assigned to that technician → the
   technician device should get "New job order assigned".

If nothing arrives, check the Edge Function logs in the Supabase dashboard —
a missing or mismatched VAPID key shows up there immediately.

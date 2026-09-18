# Job Order Lifecycle Rework — Passes 1–3

## Deploy order

Run the four migrations **before** serving the new bundle. Two of them are
not optional-if-you-skip-them — they change what the database accepts, and
the new client writes values the old constraints reject:

1. `20260918_01_dispatch_realtime_and_reassign.sql`
2. `20260918_02_server_time.sql`
3. `20260918_03_service_request_lifecycle.sql`
4. `20260918_04_dispatch_mark_completed.sql`

Migration 3 migrates existing `service_requests` rows from `dispatched` to
`preparing` and narrows the status constraint. An old client left running
against the new schema will fail when it tries to dispatch a job order.

## The lifecycle

```
(booked)     Scheduled          computed — date is in the future, no label in the tracker
   ↓         the scheduled date arrives
  1.         Preparing          computed — no midnight job, derives from the business date
   ↓         every assigned technician taps Acknowledge
  2.         En Route           customer's card activates
   ↓         ANY one technician taps Arrived at Site
  3.         Work in Progress   stamps arrivedAt → fills Time In on the Service Report
   ↓         every equipment unit resolved (report filed OR flagged Not Yet Done)
  4.         Completed          automatic; admin sees this queue labelled "Review"
   ↓         admin reads the reports and taps Close Job Order
  5.         Closed             terminal
```

Off-ramps: **Expired** (scheduled day ended with nobody acknowledging),
**Cancelled** (admin, only before anyone arrives on site), **Replaced**
(per-viewer — the ticket stays live for the crew still on it).

Removed: `open`, "On My Way" (`dtMarkEnRoute` / `enRouteBy`), "Mark
Completed" (`dtComplete` / `completedBy`), technician-initiated closing.

## Pass 1 — reassignment, list progress, realtime

- **`dtReassignWorker`** — admin replaces an absent technician. Strips the
  outgoing person's acknowledgement so the "everyone acknowledged" gate
  re-evaluates honestly, moves report permission with the slot, notifies
  both parties, keeps a `removedWorkers` audit trail. If the crew is no
  longer fully acknowledged the ticket steps **backwards** out of En Route.
  `arrivedAt` deliberately survives a swap: it records a fact about the
  visit (and is the Service Report's Time In source), not about a person.
- **Replacement closes the job order on the replaced technician's side.**
  RLS keyed on `assignedWorkerIds` alone meant removing someone revoked
  their read access instantly and the ticket simply vanished — no record,
  no reason. A parallel `removedWorkerIds` array restores **read-only**
  access; `dispatch_update_assigned` is untouched, so they can see their
  closed record and cannot write to it. They see a frozen snapshot of the
  ticket as it stood at handover, not how it went on without them.
- **Ticket-wide progress in the admin list** — always visible in the card
  head. Counts appear only where actionable ("2 of 3 acknowledged"); "3 of
  3" is noise and is suppressed.
- **Realtime on `dispatch_tickets`** — patches the changed row from the
  payload rather than re-paging every ticket; the cache updates
  immediately and only the repaint is debounced.

### Bugs found
- `dispatch_ticket_messages` was **never in the `supabase_realtime`
  publication**, so the chat subscription had always been silently dead —
  messages only ever appeared to the sender. Live bug, not a new gap.
- `dtSendMessage` push-notified nobody, so admin's message to a technician
  who wasn't looking at the app went unseen.
- The guard trigger normalised any non-admin status outside
  `open|acknowledged|completed` back to the old value **with no error** —
  the Arrival tap would have silently done nothing.

## Pass 2 — the lifecycle itself

- **Server-anchored business date.** `Preparing`, `Scheduled` and expiry
  are computed from the date, so that date has to be trustworthy. Device
  time fails two ways — a skewed clock (an offset fixes it) and a wrong
  timezone (an offset does **not**). `todayISO()` stays synchronous but
  derives from `Date.now() + offset` rendered in a fixed `BUSINESS_TZ`
  (`Asia/Manila`), which covers both. Syncs on entry, on focus, and every
  10 minutes — the periodic one matters because a device left open across
  midnight would otherwise compute yesterday all morning.
- **Acknowledge is locked to the scheduled day**, in both directions. The
  upper bound existed; the lower bound is new — a technician could
  previously acknowledge next week's ticket, telling the customer someone
  was en route days early and unlocking the Service Report before the visit.
- **Arrived at Site** — one tap from any assigned technician, gated on the
  crew being fully acknowledged so the customer never skips En Route.
  Stamped from server time.
- **Completion is derived, not tapped.** A job order completes when every
  unit has a report or a Not Yet Done reason. The old "Mark Completed"
  checked acknowledgement and nothing else, so a ticket could be closed out
  with every unit silently unreported.
- **Not Yet Done moved ahead of completion**, with an undo while the visit
  is still in progress. Left in the close checklist it would have
  deadlocked: an unreportable unit stops the ticket reaching Completed, and
  Close is gated behind Completed.
- **Expiry is acknowledgement-based.** Only a job order nobody
  acknowledged dies at end of day; multi-day work survives midnight.
- **Closing is admin-only**, enforced in three places — button hidden,
  function refuses, database trigger normalises the write back. A hidden
  button is not a permission.

### Bugs found
- The client still **wrote `'dispatched'`** in two places after the
  migration removed it from the constraint — dispatching any job order
  would have failed outright.
- `customer-portal.js` has a **second, separate tracker** (`cpHeroTrackHtml`)
  from the one in `service-requests.js`, plus five places keying the
  active-service card off `'dispatched'` — the card would never have appeared.
- Auto-complete had a **lost-update race**: two technicians filing the last
  two reports at once each wrote the whole `data` blob, and the slower write
  erased the other's `reportSrNo`. Moved to `dispatch_mark_completed` with
  row locking, writing only status fields.
- The **report picker** let a future-dated job order appear (file next
  week's report today), let a Preparing ticket be reported with no arrival
  time, and kept offering reports for units already flagged Not Yet Done.
- **Cancel Dispatch would have vanished** — gated on `status==='open'`,
  which no longer exists.
- The calendar had **no colours** for the new stages; every new ticket
  rendered as an identical grey dot.

## Pass 3 — review, reminders, inbox

- **Review section** — admin's overlay lists every Service Report filed
  against the job order, opening through the same path Report History uses.
  Not Yet Done units are called out separately with their reasons, since
  they're what admin has to act on. Closing is a review step, and admin
  cannot review what they cannot see.
- **Review reminder** — a dashboard card, hidden at zero, deep-linking
  into the Review filter. The **only** automated reminder in the system:
  technicians aren't nagged, because they can't close a job order
  themselves. Admin reaches them through the ticket's thread instead.
- **Central chat inbox** — a Messages tab in both views, unread first.
- **Customer card merged** — one card for the whole life of a service
  instead of a Scheduled card that vanished and was replaced by a different
  card on the day.

### Bugs found
- **The customer's card vanished at Completed.** `completed` was in neither
  the active nor the scheduled filter, so a finished-but-not-closed service
  fell through to "No active service right now" — during exactly the window
  a customer would check on it. The tracker's Completed and Closed steps
  could never render.
- **The inbox never updated live.** `dtMsgChannel` is per-ticket and only
  exists while that overlay is open; the inbox exists to show messages on
  tickets you're *not* looking at.
- Realtime repainted the job order list while the Messages tab was showing;
  returning to the view rendered a stale inbox; the dashboard deep-link
  raced an async render; read threads kept their unread badge.

## Known remaining

- The Review section's **Open** button closes the job order overlay, since
  opening a report switches the whole view. Reviewing several reports on one
  job order means reopening the ticket each time.
- `dispatch_ticket_messages` still has **no `CREATE TABLE` migration** — it
  was created outside version control, so its RLS policies are unversioned
  and a rebuilt-from-scratch database has the chat code but not its table.
  Migration 1 guards against this with `to_regclass`, but the table deserves
  its own migration.
- `push.js` has 8 pre-existing lint errors (`Notification` missing from the
  eslint globals). Untouched by this work.

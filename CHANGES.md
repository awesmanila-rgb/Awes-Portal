# AWES App — corrections applied

Companion to the code review. Every item below is implemented in this package.
Source of truth is `js/modules-src/`; `js/app.bundle.js` is generated — run
`python3 build.py` after editing any module.

## Apply in this order

1. **Run the database migration first:** `supabase/migrations/20260822_security_and_schema.sql`
   (via `supabase db push`, or paste it into the SQL editor). It adds columns the
   new bundle expects and turns on Row Level Security.
2. **Deploy the new Edge Function:** `supabase functions deploy list-technicians --no-verify-jwt`
   and set `ALLOWED_ORIGINS` inside it to your real hosting origin.
3. **Then deploy the web files.** The service worker cache name changed, so
   installed phones pick up the new shell automatically.
4. **Work through the post-migration checklist** at the bottom of the SQL file —
   it includes backfilling `technician_id` and rotating the EmailJS keys.

## Critical

- **Reports were saving blank fields.** `reportToRow()` read `data.recs`,
  `data.install`, `data.sigCustomer` etc. under the wrong names, so
  recommendations, the installation checklist, both signatures and both printed
  names were written to the database as null. Field names now match
  `gatherData()`, verified against the full field list.
- **History PDF crashed** on any report missing a section. Reports are now
  normalised before rendering, and a failed save aborts PDF generation with a
  message instead of producing a PDF of an unsaved report.
- **Admin password check hijacked the session.** `verifyAdminPassword()` signed
  in as the admin on the technician's own client, silently replacing their
  session. It now uses a throwaway client with `persistSession:false`.

## Security

- Row Level Security on all ten tables. Previously every rule lived in the
  browser, and the anon key in the page source let anyone read every employee's
  reports, time records, leave and cash advances — or approve their own request.
- Approval/disbursement fields are admin-only, enforced by triggers that cover
  both the promoted columns and the copies nested in the JSONB blob.
- Anonymous read access to `profiles` revoked; the login screen now calls the
  `list-technicians` function, which returns only `{id, name}`.
- EmailJS credentials in `app_settings` are no longer world-readable. **Treat the
  existing keys as compromised and rotate them.**
- Technicians can no longer promote themselves to admin or clear their own DTR
  device lock.
- Escaped every HTML sink that renders a name, customer or remark.

## Offline correctness

- **Offline work no longer disappears.** Saves made without signal were written
  to the phone only, and History switches to cloud data the moment signal
  returns — so the work vanished from view. There is now a pending-sync outbox
  with a banner, automatic retry on reconnect and foreground, and a Sync now
  button. Saves report honestly: synced, queued, or failed.
- Offline reports get a provisional SR number and are assigned a real sequential
  one when they reach the cloud.

## Reliability

- **The service worker cached nothing at all.** `APP_SHELL` listed two icon files
  that did not exist; `cache.addAll()` is atomic, so the whole precache rejected
  and the failure was swallowed. Icons are now generated and present, entries are
  cached individually, failures are logged, and API traffic is never cached.
- List views were hard-capped (150 reports, 200 leave/CA rows) with no indication
  anything was hidden — older records were simply invisible. All paginate now.
- Admin actions use targeted, guarded updates instead of read-modify-write of the
  whole row, which could silently overwrite a concurrent change.
- Dispatch tickets track acknowledgement and completion per worker; a shared
  ticket only closes once every assigned worker has finished.
- Cash-advance receipts have enforced size limits and open via blob URLs, since
  browsers block `window.open()` on a data URL.

## Usability

- Password entry is a proper masked in-app dialog. `prompt()` shows the password
  in clear text on iOS and is blocked outright in several in-app browsers, which
  made the admin gate unusable there.
- Pinch-to-zoom re-enabled (`user-scalable=no` was blocking it entirely).
- Cloud status indicator added to the header — the code had always written to an
  element that was never in the markup.
- Reverse geocoding identifies itself and caches results, so Nominatim does not
  block the app for policy violations.
- Minimum admin password raised to 8 characters.
- "Ask your Claude chat for the EmailJS guide" now opens the real EmailJS docs.
- Removed the duplicated inline logo (~44KB of base64 in the HTML) and deleted
  the dead `js/app.js`.

## Known limitations

- The Supabase anon key is still in the page. That is normal and unavoidable for
  a browser app; the migration is what makes it safe.
- `technician_id` needs backfilling on pre-existing rows or RLS will hide them
  from everyone but the admin. See the checklist in the SQL file.
- The migration was validated against the PostgreSQL grammar but not executed
  against your live database — apply it to a branch or backup first.

---

## Correction and verification — 22 Aug 2026

I connected to the live Supabase project, read the real schema and the real
policy set, then rebuilt that schema in a throwaway PostgreSQL database and ran
the migration against it. Several claims in my original review were wrong, and
the first draft of the migration was written against a database that does not
exist. Both are corrected below.

### What I got wrong

My review said access control "lived only in the browser." That is not true.
**Row-level security is already enabled on all twelve public tables**, `is_admin()`
already exists, and most policies are sensible. Specifically, these were already
blocked before any of my changes, verified by attempting each one as a technician:

| Claim in my review | Reality |
| --- | --- |
| Technician can approve their own leave | Already blocked by `leave_update_admin_only` |
| Technician can approve/disburse their own cash advance | Already blocked by `cash_update_admin_only` |
| Technician can promote themselves to admin | Already blocked by `profiles_admin_write` |
| Technician can read other technicians' reports/DTR | Already blocked by the `*_own_or_admin` policies |
| Technician can delete another technician's device lock | Already blocked by `locks_delete_own_or_admin` |
| EmailJS credentials exposed in `app_settings`; rotate keys | `app_settings` holds exactly one row, `settings/fieldLists`. **No credentials are stored there. No key rotation is needed.** |
| Technician emails exposed via `profiles` | `profiles` has no email column. Names and flags were exposed; email addresses were not. |

The first migration draft also assumed a `restrictions` jsonb column on
`profiles` (it does not exist — restrictions are three boolean columns), assumed
the signature columns were `text` (they are `jsonb`), and dropped policies using
only the new names, which would have left the dangerous existing policies in
place. Because PostgreSQL OR's permissive policies together, applying that draft
would have changed almost nothing while appearing to succeed.

### What is genuinely broken, reproduced against the replica

| # | Finding | Evidence |
| --- | --- | --- |
| 1 | `dispatch_tickets` carries a policy named **"anon full access"** (`FOR ALL`, `USING true`, `WITH CHECK true`). The anon key ships in the client bundle, so anyone can read, edit and delete every job order. | As `anon`: read 5 of 5 tickets, then **successfully deleted one**. |
| 2 | `jo_counters` has the same "anon full access" policy. | As `anon`: read and wrote it. |
| 3 | `profiles_select_technicians_public` lets **anonymous** callers list every technician's id, name and restriction flags. | As `anon`: read all 7 technician rows. |
| 4 | **`next_sr_no()` is SECURITY INVOKER while `sr_counters` is admin-only, so technicians cannot get a service report number at all.** This is a live outage, not a hardening issue. | As technician: `42501 new row violates row-level security policy for table "sr_counters"`. |
| 5 | **`cash_update_admin_only` blocks every technician UPDATE, so submitting a liquidation silently fails.** The feature is dead in production. | As technician: liquidation write affected 0 rows. |
| 6 | A technician cannot correct their own still-pending leave request. | No technician UPDATE policy on `leave_requests`. |

### Migration rewritten

The migration was rewritten from 621 lines of guesswork into a targeted migration,
now split into two stages because of an ordering dependency:

- **`20260822_01_fixes_and_hardening.sql`** — safe to run against production
  *right now, with the current app bundle still live*. Closes the anon
  read/write/delete hole on `dispatch_tickets`, locks down both counter tables,
  and fixes SR numbering and liquidation submission.
- **`20260822_02_close_anon_roster.sql`** — closes the anonymous roster read.
  Must wait until the `list-technicians` Edge Function is deployed *and* the new
  bundle is being served, because the sign-in screen builds its technician
  dropdown while still anonymous. Contains an inline rollback.

Verified on the replica: with Part 1 applied alone, an anonymous visitor still
reads the 7-technician roster (so the old sign-in screen keeps working) but reads
0 dispatch tickets. After Part 2, the roster read is denied. Both files were
re-run back-to-back with no errors, confirming they are idempotent.

The migration that only changes the six items above.
It drops the dangerous policies **by their real names**, makes both counter RPCs
`SECURITY DEFINER` with a pinned `search_path`, replaces the admin-only update
policies with ownership rules backed by `BEFORE` triggers that *normalise*
privileged fields rather than raising (so a hostile write is neutralised without
ever breaking a legitimate one), adds the missing `is_install` column, and adds
the indexes the app's query patterns need — including a GIN index on
`data->'assignedWorkerIds'`, which `dispatch.js` filters on with `.contains()`.

It deliberately does **not** add `FORCE ROW LEVEL SECURITY`: `is_admin()` is
`SECURITY DEFINER` and reads `profiles`, while the `profiles` policies call
`is_admin()`. Forcing RLS on the owner would make that pair recurse and would
also break the counter RPCs.

### Pre-existing `technician_id` rows — audited, no backfill needed

Run read-only against production:

| Table | Rows | `technician_id` NULL | Orphaned (no matching profile) |
| --- | --- | --- | --- |
| `service_reports` | 1 | 0 | 0 |
| `dtr_records` | 18 | 0 | 0 |
| `leave_requests` | 0 | 0 | 0 |
| `cash_advance_requests` | 0 | 0 | 0 |
| `device_locks` | 4 | 0 | 0 |
| `dispatch_tickets` | 5 | n/a | 0 missing `assignedWorkerIds` |

All 8 profiles are active with a matching `auth.users` row: 1 admin, 7
technicians, no restriction flags set. Every `technician_id` already points at a
valid profile, so the new ownership policies will not orphan any existing row and
**no data migration is required.**

### Before / after, same probe suite

| Probe | Before | After |
| --- | --- | --- |
| anon reads dispatch tickets | 5 | 0 |
| anon deletes a dispatch ticket | **succeeded** | blocked |
| anon reads technician roster | 7 rows | permission denied |
| anon reads `jo_counters` | 3 rows | permission denied |
| technician draws an SR number | **fails, 42501** | `SR-20260821-001` |
| technician submits a liquidation | **fails silently** | saved |
| technician self-approves that liquidation | n/a | neutralised, stays `pending` |
| technician inserts a pre-approved leave request | n/a | forced to `pending`, `decidedBy` cleared |
| technician edits their own pending leave dates | blocked | works |
| technician reassigns a ticket they are on | n/a | neutralised, assignment preserved |
| technician sets a bogus ticket status | n/a | reverted |
| technician acknowledges their own ticket | works | works |
| technician sees only assigned tickets | 4 of 5 | 1 of 5 |
| admin: decisions, disbursement, liquidation, settings, SR number | works | works |

### Still outstanding — needs you

Section 7 of the migration (closing the anonymous roster read) **must be applied
together with deploying the `list-technicians` Edge Function**, because the
sign-in screen builds its technician dropdown while still anonymous. Apply
section 7 without deploying that function and the dropdown comes up empty. The
migration contains a copy-paste rollback for just that section.

I have **not** applied anything to your production database. Everything above was
rehearsed on a local replica.


---

## Deployment status — 22 Aug 2026, 01:45 PST

**Part 1 has been applied to production** (`ugxrrgocjpkzumhghzat`), recorded in
Supabase migration history as `awes_security_fixes_part1`.

Verified against the live database afterwards: 35 policies (up from 32), no
`anon full access` policy remaining anywhere, four correct `dispatch_*` policies,
both counter RPCs now `SECURITY DEFINER`, all four guard triggers present,
`is_install` column added, 7 new indexes created. Row counts unchanged —
5 dispatch tickets, 18 DTR, 1 report, 8 profiles, 3 customers, 4 device locks.

End-to-end check over HTTPS using the anon key that ships in the client bundle:

| Request as `anon` | Result |
| --- | --- |
| `GET /dispatch_tickets` | `200 []` — closed (was returning all 5) |
| `DELETE /dispatch_tickets?id=eq...` | 0 rows affected — closed |
| `GET /jo_counters` | `401` / `42501` |
| `GET /sr_counters` | `401` / `42501` |
| `GET /app_settings` | `401` / `42501` |
| `GET /profiles` | still readable — **expected, this is Part 2** |

A tested rollback for Part 1 is at
`supabase/migrations/ROLLBACK_20260822_01.sql`. On the replica it restored the
original 32-policy set byte-for-byte (32 -> 35 -> 32).

**Still to do (needs your hands):** publish the new bundle to GitHub Pages, deploy
the `list-technicians` Edge Function, then apply Part 2.
`ALLOWED_ORIGINS` in the function is now set to `https://awesmanila-rgb.github.io`.

## Technician homepage — "Need to do now" (2026-09-24)
- Replaced the swipeable Overview carousel with **Need to do now**: every action waiting on the technician as its own card (step tag, icon, large title, one plain sentence, full-width button), ranked so Step 1 is always what to do first.
- Ranking: Time in → finish service reports (Work in Progress) → Arrived at Site (En Route) → Acknowledge (late first) → report drafts → material request to fix/submit → sign tool / material slips → return overdue tools → liquidation → unread messages → Time out.
- Acknowledge and Arrived at Site run directly from the homepage after a confirm, using the same dtAcknowledge / dtMarkArrived as My Job Order (same customer/admin notifications). Time In is ranked first but does not block other actions.
- Job-order tasks show a 3-step tracker: Accept → Arrive at site → Report.
- New sections: **Waiting for approval** (pending cash advances, reimbursements, liquidations, leaves, material requests), **Coming up** (next 3 scheduled job orders), and **Request or check** (10 labelled tiles incl. Attendance, Messages, Cash advance, Reimbursement, Leave; Finance & HR tile removed — each item has its own tile).
- Greeting rebuilt: large greeting, date, and an attendance strip (Time in / Time out) that opens DTR. Fixed instruction paragraph removed.
- Larger type throughout (greeting 26px, section titles 21px, task titles 18–20px), single centered 760px column for the technician home. No migration needed.

## Customer portal homepage redesign (2026-09-24)
- New layout: white header with company mark, greeting and account chip (switch accounts from the chip); **Action needed** (fee to approve, schedule to confirm, issue found on a visit, PM overdue with no request); **Next / Current visit** (date and time, assigned technician, 5-step tracker Booked → Confirmed → On the way → Working → Done); three main actions (Book a service, Report a problem, Message us); **Your units** (status summary + units needing maintenance); **Upcoming maintenance** (next 90 days, grouped by date, one-tap Book); **Recent service reports** (with PDF download); **Support** card. Two columns on desktop.
- Honest wording: removed "Your AC units are being monitored", "Operating well / Good health", "Filter check needed", and the "Quotes and invoices" tile. Unit status now describes the PM date only. "On the way" lights up only at En Route (after the crew acknowledges).
- Tabs: Home, Units, Requests, History, Account. Tools moved to Account → Tools and calculators.
- Report a problem: opens the request form preset to Urgent with guidance.
- Units screen: status filter chips (PM overdue / Due soon / Up to date / No PM date) with counts; Home summary opens it pre-filtered.
- Arrival notice: the "on the way" push now names the technician(s), the job order, and the expected arrival time.
- PM reminders: new pm-reminders Edge Function + migration 20260924_05_pm_reminders.sql + setup/pm_reminders_cron.sql (daily 8:00 AM). One push per account for units due within 7 days, once per PM date, skipped when a request is already open.
- Fix (in the same migration): push_subscriptions.customer_id was bigint while customer ids are uuid, which blocked customer devices from registering for push. Converted to uuid, only if still bigint.
- Support card: set CP_SUPPORT.phone / hours in customer-portal.js; a Call button shows only when a phone number is set.

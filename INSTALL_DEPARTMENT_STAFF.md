# AWES — Department Staff Accounts: install guide

Office staff accounts for **Purchasing, Accounting & Finance, Human
Resources, Administration and Operations**. The Super Admin creates staff,
chooses their departments and a View / Edit / Approve level per page;
department Heads create sub-users under them (one level), never with more
access than their own. Includes role templates, delegation while away,
department dashboards, and a cross-department Inbox with overdue escalation.

This folder holds **every file added or changed** for the feature. Copy it
over your existing `AWES Portal` folder (it only overwrites these files).

---

## 1. Database — run in the Supabase SQL Editor, in this order

| # | File | What it does |
|---|------|--------------|
| 1 | `supabase/migrations/20260926_01_departments_access.sql` | Staff role, departments, page catalog, access levels, ceiling rule, activity log |
| 2 | `supabase/migrations/20260926_02_purchasing_staff_access.sql` | Purchasing pages + approval rules (limit, own record, password re-entry) |
| 3 | `supabase/migrations/20260926_03_inventory_staff_access.sql` | Inventory pages (all warehouses; peso values only with "See peso values") |
| 4 | `supabase/migrations/20260926_04_finance_staff_access.sql` | Cash Advance, Liquidation, Reimbursement |
| 5 | `supabase/migrations/20260926_05_hr_staff_access.sql` | Attendance, Leave Requests, Technician Profiles |
| 6 | `supabase/migrations/20260926_06_administration_staff_access.sql` | Customers, Equipment, Announcements, Dropdown Lists |
| 7 | `supabase/migrations/20260926_07_operations_staff_access.sql` | Dispatch, Service Requests, Service Reports, Record Past Service |
| 8 | `supabase/migrations/20260926_08_operations_tools_staff_access.sql` | Live Tracker, Projects, Tools & Equipment |
| 9 | `supabase/migrations/20260927_01_round2_templates_delegation_dashboards.sql` | Role templates, delegation while away, dashboards |
| 10 | `supabase/migrations/20260928_01_round3_inbox_escalation.sql` | Inbox, response times, escalation queue, staff push |
| 11 | `supabase/migrations/20260929_01_user_guide.sql` | In-app guide: saves each person's language, tours and tips (optional — without it the guide still works, saved on the device only) |
| 12 | `supabase/migrations/20260930_01_restricted_reads.sql` | **Security fix:** customers see only their own company's data; internal data (announcements, materials, warehouses, suppliers, settings) only for the company's own people; customers / equipment only for staff whose pages use them |
| 13 | `supabase/migrations/20261001_01_staff_self_service.sql` | **My HR for office staff:** attendance, leave, cash advance, liquidation, reimbursement; a sub-user's leave / cash request is endorsed by their Head before HR / Finance decides; Heads see their team's attendance and leave (read only) |

Each one is safe to re-run, at any time, in any order after the others.

## 2. Edge Functions

```sh
supabase functions deploy admin-create-staff
supabase functions deploy inbox-escalations --no-verify-jwt
supabase secrets set INBOX_ESCALATIONS_SECRET=<any long random string>
```

(`inbox-escalations` uses the same `VAPID_*` secrets as `send-push`.)

## 3. Schedule the escalations (every 15 minutes)

Open `supabase/setup/inbox_escalations_cron.sql`, replace `<PROJECT_REF>`
and `<INBOX_ESCALATIONS_SECRET>`, and run it in the SQL Editor.
Tip: look over Inbox → **Response times** first — anything already long
overdue escalates on the first run (grouped into one message per person).

## 4. Web app

Upload the web files (`index.html`, `css/app.css`, `js/app.bundle.js`,
`sw.js`; `js/modules-src/` and `build.py` are the source). The service
worker cache is **v171**, so installed phones update on their own.

## 5. After installing

1. Sign in as Admin → Management → **Department Staff** → **+ Add Staff**.
2. Create each department Head (tick the department, "Head of this
   department", choose pages and levels).
3. PO Settings → Signatories: link each staff member who will issue POs to
   their signatory (**Staff login**). Until then they can draft but not issue.
4. Optional: Department Staff → **Role Templates** for common access sets.
5. Staff sign in from Staff Access → **Office Staff** with their username
   and the temporary password; they choose their own on first sign-in.

## My HR for office staff

Every staff member (Heads and sub-users) has a **My HR** section: My
Attendance (time in / out with a registered device and location, like
technicians — office staff are not shown on the field Live Tracker), My
Leave, My Cash Advance, My Liquidation and My Reimbursement.

A sub-user's leave, cash advance and reimbursement go to their **Head
first** (My Team → *My team today*, and the Inbox). Once endorsed, HR or
Finance decides as usual; a Head who declines closes the request with their
reason. **Department Heads' own** leave, cash advances, reimbursements and
liquidations are decided by the **Super Admin** only (Finance still records
the cash given once approved). Heads also see, read only, who in their team
is in or on leave.
HR's attendance page has a **Technicians / Office staff** switch. The Super
Admin can **Reset DTR device** on a staff account when someone changes
phones.

## In-app guide (every account type)

Every page has an **About this page** card (what it's for, what to do,
where it fits in the workflow), a **?** button to show it again, a
**Help & Guide** screen (searchable, only pages that person can open),
a first-run **tour** and a **Getting started** checklist per role —
Super Admin, department staff, technicians and customers — in English
with a **Tagalog** switch. Wording lives in one file:
`js/modules-src/guide-content.js` (then run `python3 build.py`).

## Verify (optional)

`supabase/verify/` has a probe script per migration (each runs in one
transaction and rolls back). See `supabase/verify/README.md`.
Last full run: 325 database checks and 270 browser checks, all passing.

## Still Super Admin only

Users & Roles (technician accounts, storekeepers, customer portal logins,
DTR device resets), app settings / e-mail secrets, PO Settings and
Signatories, deleting job orders and service reports, and response times.

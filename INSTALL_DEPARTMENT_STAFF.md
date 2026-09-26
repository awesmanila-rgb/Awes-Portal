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
worker cache is **v165**, so installed phones update on their own.

## 5. After installing

1. Sign in as Admin → Management → **Department Staff** → **+ Add Staff**.
2. Create each department Head (tick the department, "Head of this
   department", choose pages and levels).
3. PO Settings → Signatories: link each staff member who will issue POs to
   their signatory (**Staff login**). Until then they can draft but not issue.
4. Optional: Department Staff → **Role Templates** for common access sets.
5. Staff sign in from Staff Access → **Office Staff** with their username
   and the temporary password; they choose their own on first sign-in.

## Verify (optional)

`supabase/verify/` has a probe script per migration (each runs in one
transaction and rolls back). See `supabase/verify/README.md`.
Last full run: 264 database checks and 223 browser checks, all passing.

## Still Super Admin only

Users & Roles (technician accounts, storekeepers, customer portal logins,
DTR device resets), app settings / e-mail secrets, PO Settings and
Signatories, deleting job orders and service reports, and response times.

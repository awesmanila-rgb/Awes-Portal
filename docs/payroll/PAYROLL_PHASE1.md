# Payroll — Phase 1 (foundation)

Copy these files over your AWES folder. Only added or changed files are included.

## 1. Run the migration in Supabase

In the SQL Editor, run `supabase/migrations/20261004_01_payroll_foundation.sql`.
It requires 20260926_01 … 20261003_01 and is safe to run again.

## 2. Deploy the app

Push the files to GitHub Pages as usual. `js/app.bundle.js` is already built.

## 3. First-time setup (Super Admin)

1. **Finance › Payroll Rules.** The five rules (SSS, PhilHealth, Pag-IBIG, BIR,
   Labor Premiums) arrive as **drafts** filled in from the 2026 rates. Have your
   accountant check every figure. Then open each one, tap **Check**, and **Publish**,
   naming the circular or wage order.
2. **Human Resources › Payroll Setup › Company Settings.** Set the defaults
   (pay frequency, working days a year, contribution timing, grace period).
3. **Payroll Setup › Holidays.** Tap **Add fixed-date holidays** for the year,
   then add Holy Week, National Heroes Day, the Eids, Chinese New Year and any
   moved dates from the proclamation.
4. **Payroll Setup › Employees.** Set up pay for each technician and office staff member.

## Staff access (Department Staff)

| Page | View | Edit | Approve |
|---|---|---|---|
| HR › Payroll Setup | See everyone's pay setup and holidays | Change them; see and edit government IDs | – |
| Finance › Payroll Rules | See rules and change history | Start and edit drafts | Publish (never their own draft; password re-entry) |

Everyone can read their own pay setup and government IDs. These are for My HR ›
My Payslips, which comes in Phase 3.

## Rules that the database enforces

- Published rule versions can never be edited or deleted. A correction is a new
  version, and the old version ends the day before the new one starts.
- A new version must start after the latest published one.
- Every draft, edit, delete and publish is kept in an append-only audit trail,
  with who did it and why.
- Rate changes are kept in an append-only rate history.
- Government IDs are left out of the activity log.

## Verify (optional)

`supabase/verify/payroll_foundation_probe.sql` expects 63 × PASS.

## Engine

`supabase/functions/_shared/payroll/` holds your engine (`engine.ts`,
`snapshot-adapter.ts`), the rebuilt `types.ts`, and your 21 tests (all pass).
Nothing deploys yet. The Phase 3 Edge Function will use these files.

## Next: Phase 2 — Timesheets from DTR

Next comes building each pay period's timesheet from DTR, approved leave and
holidays, with HR review and OT approval.

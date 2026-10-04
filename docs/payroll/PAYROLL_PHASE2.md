# Payroll — Phase 2 (timesheets from DTR)

This zip includes all payroll files so far. Phase 1 files that changed are
included too, so copy everything over your AWES folder.

## 1. Run the migration in Supabase

Run `supabase/migrations/20261005_01_payroll_timesheets.sql`. It needs Phase 1
(20261004_01) first and is safe to run again.

## 2. Deploy the app

`js/app.bundle.js` is already built.

## 3. Before the first period

- **Payroll Setup › Company Settings.** Check the **leave types** (ticked = paid)
  and the **grace period**. If you use local holidays, set the **company location**.
- **Payroll Setup › Employees.** Each person's shift, break and rest days
  decide lates, undertime and rest-day pay. Check them.
- **Payroll Rules › Labor Premiums.** The night differential window
  (22:00–06:00) is read from here.

## How it works (HR › Timesheets)

1. **Open a pay period.** The next dates are suggested from the last period.
2. **Build timesheets.** One row is made per person per day from DTR (time in/out,
   OT in/out), approved leave, holidays and rest days. Older DTR records saved
   as "HH:MM" are read too.
3. **Open each person** and handle their days:
   - Days in red block locking: no time-out, or OT not approved.
   - **Approve OT.** OT is paid only once approved. You can approve all of it
     or part of it.
   - **Correct** wrong days. Times, "count as" (absent / paid leave / unpaid
     leave / rest-day swap) and a required reason. Every correction goes to the
     Activity Log.
   - **Mark reviewed.** Any later correction clears the review.
4. **Lock the period.** This needs Approve access and your password. The period
   must be over, everyone reviewed, and nothing in red. A locked period can't
   change; **Unlock** needs a reason.
5. **Rebuild** keeps HR's corrections, and keeps OT approvals whose OT didn't
   change. **Start over** throws both away.

## How each day is worked out (all in the database)

| Situation | Result |
|---|---|
| Ordinary day | Regular minutes are the time inside the shift, less the break if more than 5 hours were worked, capped at hours a day. Late (after the grace period) and undertime are counted against the shift. |
| Rest day or holiday worked | Up to a full day is premium time for that day type. Anything beyond a full day counts as OT. |
| Night differential | Minutes inside the night window, for regular time and for approved OT. |
| Totals | Keyed by the same premium codes as Payroll Rules (`OT_REGULAR`, `REST_DAY`, `HOLIDAY_REGULAR_WORKED`, …), ready for the payroll engine in Phase 3. |

## Access (Department Staff › Timesheets)

| Level | Can do |
|---|---|
| View | Read everything. Rates are never shown here. |
| Edit | Open, build and delete periods, correct days, approve OT, mark reviewed. |
| Approve | Lock and unlock periods. |

Employees can see their own days once a period is locked.

## Verify (optional)

`supabase/verify/payroll_timesheets_probe.sql` expects 54 × PASS.

## Next: Phase 3 — pay runs

Phase 3 computes pay from the locked totals with the engine, handles approval,
and produces payslips in My HR.

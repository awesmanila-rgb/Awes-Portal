# Payroll — Phase 3 (pay runs and payslips)

This zip holds every payroll file (Phases 1–3). Copy all of it over your
AWES folder.

## 1. Run the migrations in Supabase, in order

Skip any you already ran. All three are safe to run again.

1. `20261004_01_payroll_foundation.sql`
2. `20261005_01_payroll_timesheets.sql`
3. `20261006_01_payroll_runs.sql`

## 2. Deploy the Edge Function

    supabase functions deploy payroll-compute

It uses `supabase/functions/_shared/payroll/` (engine, adapter, types,
compute). Keep verify_jwt ON (the default). It needs no new secrets:
`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are
already provided to Edge Functions.

## 3. Deploy the app

`js/app.bundle.js` is already built.

## The full payroll flow

| Step | Where | Who (Department Staff access) |
|---|---|---|
| Rates, schedules, allowances & loans, holidays | HR › Payroll Setup | Payroll Setup › Edit |
| Rule versions (SSS, PhilHealth, Pag-IBIG, BIR, premiums) | Finance › Payroll Rules | Edit drafts; Approve to publish |
| Hours from DTR, OT approval, lock | HR › Timesheets | Edit; Approve to lock |
| Start pay run, one-off items, **Compute**, **Submit** | HR › Pay Runs | Pay Runs › Edit |
| **Approve** or **Send back** | Finance › Payroll Approval | Payroll Approval › Approve (peso limit on total net) |
| **Release** once salaries are paid | Finance › Payroll Approval | Payroll Approval › Edit |
| Payslips | Technicians: Payslips · Office staff: My HR › My Payslips | everyone, their own |

Pay Runs and Payroll Approval open the same page, and the buttons shown follow
each person's access.

## What happens when

- **Starting a pay run** pulls in unsettled cash-advance balances. An excess
  the technician must return becomes a deduction; an amount owed to the
  technician becomes a non-taxable reimbursement.
- **Compute** runs your engine for each person, using the rules in force on the
  pay date:
  - Hours come from the locked timesheet.
  - Allowances and loans come from Payroll Setup.
  - Month-to-date tax, the ₱90k 13th-month/benefits cap and de minimis
    limits use that person's earlier approved pay this year.
  - If anyone fails, nothing is saved, and the reason is shown per person.
- **Any change** after computing (adding or removing an item) sends the run back
  to draft, so the numbers Finance approves are always current.
- **Approve** needs the password re-entered, stays within the approver's peso
  limit on total net pay, and can't be done by the person who computed the run.
  The Super Admin is exempt.
- **Release**:
  - Payslips appear for each person.
  - Cash advances that were fully deducted or paid are marked settled
    ("Payroll — <period>").
  - Loan balances go down, and a loan stops once it's paid off.
  - The run is final after this.
- **Timesheets that have a pay run** can't be unlocked. While the run is still a
  draft, delete it first.

## Documents

- **Payslip PDF:** tap a person in the register, or View payslip in My Payslips.
- **Payroll register:** PDF (with Prepared / Approved / Released signature lines)
  and Excel.

## Verify (optional)

| Probe | Expected |
|---|---|
| `supabase/verify/payroll_foundation_probe.sql` | 63 × PASS |
| `supabase/verify/payroll_timesheets_probe.sql` | 54 × PASS |
| `supabase/verify/payroll_runs_probe.sql` | 39 × PASS |

## Before the first real payroll

1. Have your accountant check the published rules. Then run one pay period in
   parallel with your current payroll and compare every payslip.
2. In Payroll Setup, set the working days per year to match each person's
   rest days: **261** for Monday–Friday, **313** for Monday–Saturday. The
   screen now warns when they don't match.

## Not included

These are left for later:

- Government remittance files (SSS R3, PhilHealth RF-1, Pag-IBIG)
- BIR 1601-C / 2316 / alphalist
- Year-end 13th-month computation (add it as a one-off 13th-month item for now)
- Bank payout files

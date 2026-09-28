# Migration rehearsal harness

These three files let you re-run the exact verification I did, on a throwaway
PostgreSQL database, without touching production.

- `replica_baseline.sql` — the live AWES schema, functions, grants, RLS state and
  all 32 existing policies, reconstructed from the production catalogs. Includes
  minimal stand-ins for Supabase's `auth` schema (`auth.users`, `auth.uid()`,
  `auth.role()`) that read the same request GUCs PostgREST sets.
- `replica_seed.sql` — rows matching production's shape and counts
  (1 admin + 7 technicians, 18 DTR, 1 report, 5 dispatch tickets, 4 device locks,
  3 customers, 1 pending leave, 1 pending cash advance).
- `rls_probe.sql` — the probe suite. Runs as `anon`, then as a technician, then
  as admin, and reports what each can read and write.

```sh
createdb awes_backup
psql -d awes_backup -f replica_baseline.sql
psql -d awes_backup -f replica_seed.sql
psql -d awes_backup -f rls_probe.sql            # before
psql -d awes_backup -f ../migrations/20260822_security_and_schema.sql
psql -d awes_backup -f rls_probe.sql            # after
```

Note: `rls_probe.sql` mutates data, so reseed between runs if you want a clean
comparison. It uses session-scoped `set_config(..., false)` on purpose —
transaction-scoped settings are discarded by psql's autocommit and every check
silently returns zero rows.

## Staff access (20260926_01_departments_access.sql)

`staff_access_probe.sql` checks the department-staff rules — one level of
supervision, the ceiling rule and its cascades, approval checks (limit,
own-record, password re-entry), expiry, RLS on the staff tables and the
append-only activity log. It runs in one transaction and rolls back.

```sh
psql -d awes_backup -f ../migrations/20260926_01_departments_access.sql
psql -d awes_backup -f staff_access_probe.sql     # expect 43 × PASS
```

## Purchasing staff access (20260926_02_purchasing_staff_access.sql)

`purchasing_staff_probe.sql` checks View / Edit / Approve on suppliers,
materials, requisitions and purchase orders; approval rules (own record,
peso limit, password re-entry); the issuing staff member's signatory being
printed; and that technicians and the Super Admin behave exactly as before.

```sh
psql -d awes_backup -f ../migrations/20260926_02_purchasing_staff_access.sql
psql -d awes_backup -f purchasing_staff_probe.sql   # expect 29 × PASS
```

## Inventory staff access (20260926_03_inventory_staff_access.sql)

`inventory_staff_probe.sql` checks per-page posting (receive / issue /
transfer), all-warehouse access for staff, quantities-only without
"See peso values", reports, warehouses, and that storekeepers and
technicians behave exactly as before.

```sh
psql -d awes_backup -f ../migrations/20260926_03_inventory_staff_access.sql
psql -d awes_backup -f inventory_staff_probe.sql   # expect 25 × PASS
```

## Finance staff access (20260926_04_finance_staff_access.sql)

`finance_staff_probe.sql` checks visibility by page (advances vs
reimbursements), approval rules (Approve level, peso limit, password
re-entry), that staff can't change what a technician filed, the payment
and settlement records, the database-computed liquidation balance, and
that technicians and the Super Admin behave exactly as before.

```sh
psql -d awes_backup -f ../migrations/20260926_04_finance_staff_access.sql
psql -d awes_backup -f finance_staff_probe.sql   # expect 18 × PASS
```

## HR staff access (20260926_05_hr_staff_access.sql)

`hr_staff_probe.sql` checks DTR read-only access, leave visibility and
decisions (Approve level, password re-entry, no self-approval, no changing
dates), violations and documents by level, and that technician accounts
stay Super Admin–only.

```sh
psql -d awes_backup -f ../migrations/20260926_05_hr_staff_access.sql
psql -d awes_backup -f hr_staff_probe.sql   # expect 21 × PASS
```

## Administration staff access (20260926_06_administration_staff_access.sql)

`administration_staff_probe.sql` checks customers (add / change / remove,
rename carried onto reports), equipment and photos, read-only service
history, announcements, and that Dropdown Lists staff can change only the
report form lists — no other setting.

```sh
psql -d awes_backup -f ../migrations/20260926_06_administration_staff_access.sql
psql -d awes_backup -f administration_staff_probe.sql   # expect 22 × PASS
```

## Operations staff access, part 1 (20260926_07_operations_staff_access.sql)

`operations_staff_probe.sql` checks job orders (create / reassign / chat /
close by Edit, read-only by View, technicians unchanged), service requests
and replies (never posing as the customer), service report reading and
correcting (deleting stays Super Admin), and Record Past Service.

```sh
psql -d awes_backup -f ../migrations/20260926_07_operations_staff_access.sql
psql -d awes_backup -f operations_staff_probe.sql   # expect 22 × PASS
```

## Operations staff access, part 2 (20260926_08_operations_tools_staff_access.sql)

`operations_tools_staff_probe.sql` checks the tool register (staff save
through tl_staff_save_tools; purchase cost only with "See peso values" and
never blanked by an edit), issue / return per page across all warehouses,
slips, projects, the read-only Live Tracker, and that storekeepers and
technicians behave exactly as before.

```sh
psql -d awes_backup -f ../migrations/20260926_08_operations_tools_staff_access.sql
psql -d awes_backup -f operations_tools_staff_probe.sql   # expect 22 × PASS
```

Note: `rls_probe.sql` changes data as it runs — compare before/after on two
separate fresh copies, never twice on the same database.

## Round 2 (20260927_01_round2_templates_delegation_dashboards.sql)

`round2_probe.sql` checks role templates (Super Admin only; sub-users get
them cut to their Head's access; editing a template updates linked people;
deleting keeps access), delegation (own sub-users only, Approve pages only,
90-day cap, date window, Head's limit, never own records, stops when the
Head loses the access or it's ended), and that dashboards only show
figures for pages the person can see.

This migration replaces has_perm(), so re-run every earlier probe too.

```sh
psql -d awes_backup -f ../migrations/20260927_01_round2_templates_delegation_dashboards.sql
psql -d awes_backup -f round2_probe.sql   # expect 37 × PASS
```

## Round 3 (20260928_01_round3_inbox_escalation.sql)

`round3_probe.sql` checks who sees which inbox items (only pages they can
act on, at that level; Heads also see escalated items in their department),
waiting → overdue → escalated by response time, items leaving the inbox
once acted on, the Super Admin–only response-time editor, and the
escalation queue (Heads at level 1, the Super Admin at twice the time,
each sent once, not readable by app users).

```sh
psql -d awes_backup -f ../migrations/20260928_01_round3_inbox_escalation.sql
psql -d awes_backup -f round3_probe.sql   # expect 25 × PASS
```

## Re-running migrations

Every department migration (20260926_01 … 20260928_01) can be re-run at any
time, in any order, after the others: nothing a later one installed is put
back to an older version. `20260926_01` / `_02` skip their older copies of
has_perm / staff_approval_check / my_access / staff_approval_assert when
Round 2 is installed, and the "who may read technician rows" rule is one
shared function (staff_sees_workers) defined identically in _03, _05, _07
and _08. Checked by re-running each one on a full install and running all
ten probes after each.

## In-app guide (20260929_01_user_guide.sql)

`user_guide_probe.sql` checks that each person reads and writes only their
own guide progress (language, tours, closed tips, checklist) — not other
users, not even the Super Admin, and nothing for signed-out visitors.

```sh
psql -d awes_backup -f ../migrations/20260929_01_user_guide.sql
psql -d awes_backup -f user_guide_probe.sql   # expect 7 × PASS
```

## Role isolation (20260930_01_restricted_reads.sql)

`role_isolation_probe.sql` builds data owned by different people and reads
every sensitive table as each kind of account — signed out, technician,
storekeeper, customer, staff with one page, finance staff, a Head and a
deactivated staff member — checking nobody reads beyond their role
(e.g. a customer sees only their own company, units and requests, and no
internal data at all). Run it after any change to access rules.

```sh
psql -d awes_backup -f ../migrations/20260930_01_restricted_reads.sql
psql -d awes_backup -f role_isolation_probe.sql   # expect 19 × PASS
```

## My HR for office staff (20261001_01_staff_self_service.sql)

`staff_self_service_probe.sql` checks office staff filing attendance, leave
and cash advances; a sub-user's request waiting for their Head (HR / Finance
refused until endorsed; only the Super Admin can override); who may endorse
(that person's Head only — not another Head, not themselves, never written
directly); declining with a reason; the Inbox (endorse items for the Head,
approvals for HR / Finance only once endorsed); the Head's read-only team
view; HR seeing office staff; department Heads' own requests decided by the
Super Admin only (HR / Finance refused, Inbox and escalations to the Super
Admin, Finance still records cash given).

```sh
psql -d awes_backup -f ../migrations/20261001_01_staff_self_service.sql
psql -d awes_backup -f staff_self_service_probe.sql   # expect 35 × PASS
```

## Inventory → Administration (20261002_01_inventory_to_administration.sql)

`inventory_to_administration_probe.sql` sets up a company the old way
(Inventory pages under Purchasing), runs the move, and checks that nobody
gained or lost a page; that Purchasing Heads (and anyone whose sub-users hold
Inventory pages) now head Administration, stock sub-users follow them, and
view-only people join as members; templates and the Inbox item move; and a
second run changes nothing.

```sh
psql -d awes_backup -f ../migrations/20261002_01_inventory_to_administration.sql
psql -d awes_backup -f inventory_to_administration_probe.sql   # expect 14 × PASS
```

## Attendance split (20261003_01_staff_attendance_split.sql)

`attendance_split_probe.sql` checks the two pages: Technician Attendance
reads technicians' time records (and names) only; Office Staff Attendance
reads office staff's only; both / own / Super Admin see as before; upgrading
gives everyone who had Attendance the new page (and templates) once — and a
later re-run doesn't give it back to someone you've set to technicians only.

```sh
psql -d awes_backup -f ../migrations/20261003_01_staff_attendance_split.sql
psql -d awes_backup -f attendance_split_probe.sql   # expect 16 × PASS
```

-- =====================================================================
-- Probe for 20261006_01_payroll_runs.sql — pay runs: create from locked
-- timesheets, cash advances, adjustments, engine inputs, storing results
-- (service role only), submit / send back / approve (limit, four-eyes,
-- password), release (cash advances settled, loan balances), payslip
-- visibility. One transaction, rolled back.
--   psql -d awes_backup -f payroll_runs_probe.sql
-- =====================================================================
\set ON_ERROR_STOP 1
begin;
create function pg_temp.ok(p_cond boolean, p_name text) returns void language plpgsql as $$
begin if p_cond then raise notice 'PASS  %', p_name; else raise exception 'FAIL  %', p_name; end if; end $$;
create function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p::text, ''), true);
  perform set_config('request.jwt.claim.role', case when p is null then 'service_role' else 'authenticated' end, true);
end $$;
create function pg_temp.seen(p_user uuid, p_sql text) returns bigint language plpgsql as $$
declare n bigint; begin
  perform pg_temp.as_user(p_user); set local role authenticated;
  execute 'select count(*) from (' || p_sql || ') x' into n; reset role; return n; end $$;
create function pg_temp.run(p_user uuid, p_sql text) returns void language plpgsql as $$
begin perform pg_temp.as_user(p_user); set local role authenticated; execute p_sql; reset role; end $$;
create function pg_temp.fails_as(p_user uuid, p_sql text, p_like text, p_name text) returns void language plpgsql as $$
begin
  perform pg_temp.as_user(p_user); set local role authenticated;
  begin execute p_sql;
  exception when others then
    reset role;
    if sqlerrm ilike '%' || p_like || '%' then raise notice 'PASS  % (%)', p_name, sqlerrm; return; end if;
    raise exception 'FAIL  % — wrong error: %', p_name, sqlerrm;
  end;
  reset role;
  raise exception 'FAIL  % — succeeded but should have failed', p_name;
end $$;
-- one day of the test period, as the database sees it
create function pg_temp.day(p_who uuid, p_date date) returns public.payroll_timesheet_days language sql as $$
  select * from public.payroll_timesheet_days where profile_id = p_who and work_date = p_date $$;

\set A  '''00000000-0000-0000-0000-0000000000a1'''
\set T  '''00000000-0000-0000-0000-0000000000b1'''
\set T2 '''00000000-0000-0000-0000-0000000000b2'''
\set HV '''ae000000-0000-0000-0000-00000000000a'''
\set HE '''ae000000-0000-0000-0000-00000000000b'''
\set HA '''ae000000-0000-0000-0000-00000000000c'''

insert into auth.users (id, email) values (:HV, 'tv@s'), (:HE, 'te@s'), (:HA, 'ta@s');
insert into public.profiles (id, name, role, username) values
  (:HV, 'Tess View', 'staff', 'ts_v'), (:HE, 'Ted Edit', 'staff', 'ts_e'), (:HA, 'Tina Approve', 'staff', 'ts_a');
select pg_temp.as_user(null);
select public.staff_apply_access(:HV::uuid, '[{"id":"hr"}]', '[{"module":"hr.timesheets","level":"view"}]', :A::uuid);
select public.staff_apply_access(:HE::uuid, '[{"id":"hr"}]', '[{"module":"hr.timesheets","level":"edit"}]', :A::uuid);
select public.staff_apply_access(:HA::uuid, '[{"id":"hr"}]', '[{"module":"hr.timesheets","level":"approve"}]', :A::uuid);

-- pay setup (as the Super Admin), grace 10 minutes
select pg_temp.run(:A::uuid, $q$
  insert into public.payroll_employees (profile_id, employee_no, rate_type, base_rate, pay_frequency, rest_days, shift_start, shift_end, break_minutes)
  values ('00000000-0000-0000-0000-0000000000b1', 'T-1', 'DAILY', 695, 'SEMI_MONTHLY', '{0}', '08:00', '17:00', 60),
         ('00000000-0000-0000-0000-0000000000b2', 'T-2', 'MONTHLY', 30000, 'SEMI_MONTHLY', '{0,6}', '08:00', '17:00', 60),
         ('00000000-0000-0000-0000-0000000000b3', 'T-3', 'DAILY', 695, 'WEEKLY', '{0}', '08:00', '17:00', 60)$q$);
update public.payroll_settings set grace_minutes = 10 where id = 1;
insert into public.payroll_holidays (holiday_date, name, kind) values
  ('2026-09-12', 'Probe Regular Holiday', 'REGULAR'), ('2026-09-14', 'Probe Special Day', 'SPECIAL_NON_WORKING');

-- DTR for Bryan (T); 2026-09-01 is a Tuesday
delete from public.dtr_records where technician_id = :T::uuid and date between '2026-09-01' and '2026-09-15';
insert into public.dtr_records (technician_id, date, data) values
  (:T, '2026-09-01', '{"timeIn":"2026-09-01T00:00:00Z","timeOut":"2026-09-01T09:00:00Z"}'),
  (:T, '2026-09-02', '{"timeIn":"2026-09-02T00:20:00Z","timeOut":"2026-09-02T09:00:00Z"}'),
  (:T, '2026-09-03', '{"timeIn":"2026-09-03T00:05:00Z","timeOut":"2026-09-03T09:00:00Z"}'),
  (:T, '2026-09-04', '{"timeIn":"2026-09-04T00:00:00Z","timeOut":"2026-09-04T08:00:00Z"}'),
  (:T, '2026-09-05', '{"timeIn":"2026-09-05T00:00:00Z","timeOut":"2026-09-05T09:00:00Z","otTimeIn":"2026-09-05T10:00:00Z","otTimeOut":"2026-09-05T14:30:00Z"}'),
  (:T, '2026-09-06', '{"timeIn":"2026-09-06T00:00:00Z","timeOut":"2026-09-06T09:00:00Z"}'),
  (:T, '2026-09-08', '{"status":"present","timeIn":"08:00","timeOut":"17:00"}'),
  (:T, '2026-09-09', '{"timeIn":"2026-09-09T00:00:00Z"}'),
  (:T, '2026-09-14', '{"timeIn":"2026-09-14T00:00:00Z","timeOut":"2026-09-14T09:00:00Z"}');
insert into public.leave_requests (technician_id, status, data) values
  (:T, 'approved', '{"leaveType":"Vacation Leave","dateFrom":"2026-09-10","dateTo":"2026-09-11"}'),
  (:T, 'approved', '{"leaveType":"Unpaid Leave","dateFrom":"2026-09-15","dateTo":"2026-09-15"}'),
  (:T, 'pending',  '{"leaveType":"Sick Leave","dateFrom":"2026-09-07","dateTo":"2026-09-07"}');

create function pg_temp.fails(p_sql text, p_like text, p_name text) returns void language plpgsql as $$
begin
  begin execute p_sql;
  exception when others then
    if sqlerrm ilike '%' || p_like || '%' then raise notice 'PASS  % (%)', p_name, sqlerrm; return; end if;
    raise exception 'FAIL  % — wrong error: %', p_name, sqlerrm;
  end;
  raise exception 'FAIL  % — succeeded but should have failed', p_name;
end $$;

-- publish the seeded rules (as the Super Admin)
select pg_temp.run(:A::uuid, $q$select public.payroll_rule_publish(id, 'probe') from public.payroll_rules where published_at is null$q$);

\set RE '''af000000-0000-0000-0000-00000000000a'''
\set RV '''af000000-0000-0000-0000-00000000000b'''
\set FA '''af000000-0000-0000-0000-00000000000c'''
\set FS '''af000000-0000-0000-0000-00000000000d'''
insert into auth.users (id, email) values (:RE, 're@s'), (:RV, 'rv@s'), (:FA, 'fa@s'), (:FS, 'fs@s');
insert into public.profiles (id, name, role, username) values
  (:RE, 'Rita Runs', 'staff', 'pr_re'), (:RV, 'Ray View', 'staff', 'pr_rv'), (:FA, 'Fay Approver', 'staff', 'pr_fa'), (:FS, 'Fil Small Limit', 'staff', 'pr_fs');
select pg_temp.as_user(null);
select public.staff_apply_access(:RE::uuid, '[{"id":"hr"}]', '[{"module":"hr.payroll_runs","level":"edit"}]', :A::uuid);
select public.staff_apply_access(:RV::uuid, '[{"id":"hr"}]', '[{"module":"hr.payroll_runs","level":"view"}]', :A::uuid);
select public.staff_apply_access(:FA::uuid, '[{"id":"finance"}]', '[{"module":"fin.payroll_approve","level":"approve","approve_limit":100000}]', :A::uuid);
select public.staff_apply_access(:FS::uuid, '[{"id":"finance"}]', '[{"module":"fin.payroll_approve","level":"approve","approve_limit":1000}]', :A::uuid);

-- a locked timesheet period
select pg_temp.run(:HE::uuid, $q$select public.payroll_period_create('SEMI_MONTHLY','2026-09-01','2026-09-15','2026-09-20')$q$);
\set P '(select id from public.payroll_periods where pay_frequency = ''SEMI_MONTHLY'' and period_start = ''2026-09-01'')'
select pg_temp.run(:HE::uuid, 'select public.payroll_period_build(' || :'P' || ')');

select pg_temp.fails_as(:RE::uuid, 'select public.payroll_run_create(' || :'P' || ')', 'Lock the timesheets', 'a pay run needs locked timesheets');

select pg_temp.run(:HE::uuid, $q$update public.payroll_timesheet_days set time_out = '2026-09-09T09:00:00Z', adjust_note = 'fix' where profile_id = '00000000-0000-0000-0000-0000000000b1' and work_date = '2026-09-09'$q$);
select pg_temp.run(:HE::uuid, 'select public.payroll_ts_approve_ot(' || :'P' || ')');
select pg_temp.run(:HE::uuid, 'select public.payroll_ts_set_reviewed(' || :'P' || ', profile_id, true) from public.payroll_timesheets where period_id = ' || :'P');
select public.staff_record_reauth(:HA::uuid);
select pg_temp.run(:HA::uuid, 'select public.payroll_period_lock(' || :'P' || ')');

-- a loan and a cash advance for Bryan (T)
select pg_temp.run(:A::uuid, $q$insert into public.payroll_recurring_items (profile_id, kind, code, name, category, amount, balance)
  values ('00000000-0000-0000-0000-0000000000b1','deduction','sss loan','SSS salary loan','LOAN', 800, 1200)$q$);
select pg_temp.ok((select code = 'SSS_LOAN' from public.payroll_recurring_items), 'recurring item codes are tidied');
set local session_replication_role = replica;
insert into public.cash_advance_requests (id, technician_id, status, data) values
 ('cafe0000-0000-0000-0000-000000000001', :T, 'approved', '{"amount":3000,"amountGiven":3000,"liquidation":{"status":"approved","totalAmount":2500,"settlement":{"type":"return","amount":500,"settled":false}}}'),
 ('cafe0000-0000-0000-0000-000000000002', :T, 'approved', '{"amount":1000,"amountGiven":1000,"liquidation":{"status":"approved","totalAmount":1000,"settlement":{"type":"none","amount":0}}}');
set local session_replication_role = origin;

-- ---- create -------------------------------------------------------------
select pg_temp.fails_as(:RV::uuid, 'select public.payroll_run_create(' || :'P' || ')', 'Edit access', 'Pay Runs (view) can''t start a run');
select pg_temp.run(:RE::uuid, 'select public.payroll_run_create(' || :'P' || ')');
\set R '(select id from public.payroll_runs where period_id = (select id from public.payroll_periods where pay_frequency = ''SEMI_MONTHLY'' and period_start = ''2026-09-01''))'
select pg_temp.fails_as(:RE::uuid, 'select public.payroll_run_create(' || :'P' || ')', 'already a pay run', 'one pay run per period');
select pg_temp.fails_as(:HA::uuid, 'select public.payroll_period_unlock(' || :'P' || ', ''x'')', 'delete the pay run first', 'timesheets with a pay run can''t be unlocked');

-- ---- adjustments & cash advances -------------------------------------------
select pg_temp.run(:RE::uuid, 'select public.payroll_run_add_cash_advances(' || :'R' || ')');
select pg_temp.ok((select count(*) = 1 and max(amount) = 500 and bool_and(kind = 'deduction') from public.payroll_run_adjustments where source = 'cash_advance'),
  'the unsettled cash-advance excess comes in as a deduction (settled / zero ones don''t)');
select pg_temp.run(:RE::uuid, 'select public.payroll_run_add_cash_advances(' || :'R' || ')');
select pg_temp.ok((select count(*) = 1 from public.payroll_run_adjustments where source = 'cash_advance'), 'pulling cash advances twice adds nothing');
select pg_temp.run(:RE::uuid, $q$insert into public.payroll_run_adjustments (run_id, profile_id, kind, name, category, amount)
  values ((select id from public.payroll_runs), '00000000-0000-0000-0000-0000000000b2', 'earning', 'Performance bonus', 'BONUS', 5000)$q$);
select pg_temp.fails_as(:RE::uuid, $q$insert into public.payroll_run_adjustments (run_id, profile_id, kind, name, amount)
  values ((select id from public.payroll_runs), '00000000-0000-0000-0000-0000000000b3', 'earning', 'x', 1)$q$, 'isn''t in this pay run', 'adjustments only for people in the run');
select pg_temp.fails_as(:RV::uuid, $q$insert into public.payroll_run_adjustments (run_id, profile_id, kind, name, amount)
  values ((select id from public.payroll_runs), '00000000-0000-0000-0000-0000000000b2', 'earning', 'x', 1)$q$, 'row-level security', 'Pay Runs (view) can''t add adjustments');

-- ---- inputs & store ----------------------------------------------------------
select pg_temp.fails_as(:RV::uuid, 'select public.payroll_run_inputs(' || :'R' || ')', 'Edit access', 'Pay Runs (view) can''t read the engine inputs');
create temp table probe_inputs (j jsonb);
grant all on probe_inputs to authenticated;
do $$ begin perform set_config('request.jwt.claim.sub', 'af000000-0000-0000-0000-00000000000a', true); perform set_config('request.jwt.claim.role','authenticated', true); end $$;
set local role authenticated;
insert into probe_inputs select public.payroll_run_inputs((select id from public.payroll_runs));
reset role;
select pg_temp.ok((select jsonb_array_length(j->'employees') = 2 and (j->'rules') ?& array['sss','philhealth','pagibig','bir','labor'] from probe_inputs), 'inputs: both people and all five rules');
select pg_temp.ok((select (e->'totals'->>'days_paid_leave')::numeric = 2 and jsonb_array_length(e->'recurring') = 1 and jsonb_array_length(e->'adjustments') = 1
                     from probe_inputs, jsonb_array_elements(j->'employees') e where e->>'profile_id' = '00000000-0000-0000-0000-0000000000b1'),
  'inputs carry the locked totals, the loan and the cash advance');
select pg_temp.ok((select e->'employee'->>'base_rate' = '695.00' from probe_inputs, jsonb_array_elements(j->'employees') e where e->>'profile_id' = '00000000-0000-0000-0000-0000000000b1'),
  'inputs carry the pay setup');
select pg_temp.fails_as(:RE::uuid, $q$select public.payroll_run_store((select id from public.payroll_runs), '[]', '{}', null)$q$, 'permission denied', 'no app user can store pay lines');

-- what the Edge Function would save (shape of engine results)
create temp table probe_lines as select jsonb_build_array(
  jsonb_build_object('profile_id', '00000000-0000-0000-0000-0000000000b1', 'input', '{}'::jsonb, 'result', jsonb_build_object(
    'totals', jsonb_build_object('grossPay', 10127.74, 'taxableIncome', 8351.14, 'withholdingTax', 0, 'employeeMandatoryContributions', 776.6,
                                 'employerContributions', 1241.6, 'totalDeductions', 2076.6, 'netPay', 8051.14),
    'voluntaryDeductions', jsonb_build_array(
       jsonb_build_object('code', (select code from public.payroll_run_adjustments where source = 'cash_advance'), 'appliedAmount', 500),
       jsonb_build_object('code', 'SSS_LOAN', 'appliedAmount', 800)),
    'carryForward', jsonb_build_object('otherBenefitsAdded', 0, 'deMinimisUsage', '{}'::jsonb), 'warnings', '[]'::jsonb)),
  jsonb_build_object('profile_id', '00000000-0000-0000-0000-0000000000b2', 'input', '{}'::jsonb, 'result', jsonb_build_object(
    'totals', jsonb_build_object('grossPay', 8498.40, 'taxableIncome', 2273.40, 'withholdingTax', 0, 'employeeMandatoryContributions', 1225,
                                 'employerContributions', 1990, 'totalDeductions', 1225, 'netPay', 7273.40),
    'voluntaryDeductions', '[]'::jsonb, 'carryForward', jsonb_build_object('otherBenefitsAdded', 5000), 'warnings', '[{"code":"X","message":"y"}]'::jsonb))) l;
select pg_temp.as_user(null);
select pg_temp.fails($q$select public.payroll_run_store((select id from public.payroll_runs), (select l->0 || '[]' from probe_lines), '{}', null)$q$, 'Expected 2', 'a partial result is refused');
select public.payroll_run_store(:R, (select l from probe_lines), '{"sss":{"id":"x","label":"SSS-2026"}}', :RE::uuid);
select pg_temp.ok((select status = 'computed' and headcount = 2 and total_net = 15324.54 and total_gross = 18626.14 and total_employer = 3231.60
                     and warnings = 1 and computed_by = :RE::uuid and rule_labels = 'SSS-2026' from public.payroll_runs), 'stored: status, totals, who computed');

-- a change after computing clears the numbers
select pg_temp.run(:RE::uuid, $q$update public.payroll_run_adjustments set amount = 6000 where name = 'Performance bonus'$q$);
select pg_temp.ok((select status = 'draft' and total_net = 0 from public.payroll_runs) and not exists (select 1 from public.payroll_lines), 'changing an adjustment sends the run back to draft');
select pg_temp.fails_as(:RE::uuid, 'select public.payroll_run_submit(' || :'R' || ')', 'Compute', 'a draft can''t be submitted');
select pg_temp.as_user(null);
select public.payroll_run_store(:R, (select l from probe_lines), '{}', :RE::uuid);

-- ---- submit / send back / approve ----------------------------------------------
select pg_temp.fails_as(:RV::uuid, 'select public.payroll_run_submit(' || :'R' || ')', 'Edit access', 'Pay Runs (view) can''t submit');
select pg_temp.run(:RE::uuid, 'select public.payroll_run_submit(' || :'R' || ')');
select pg_temp.fails_as(:RE::uuid, $q$insert into public.payroll_run_adjustments (run_id, profile_id, kind, name, amount)
  values ((select id from public.payroll_runs), '00000000-0000-0000-0000-0000000000b2', 'earning', 'late', 1)$q$, 'send it back', 'a submitted run can''t be changed');
select pg_temp.fails_as(:FA::uuid, 'select public.payroll_run_send_back(' || :'R' || ', '''')', 'why', 'sending back needs a reason');
select pg_temp.run(:FA::uuid, 'select public.payroll_run_send_back(' || :'R' || ', ''Check the bonus'')');
select pg_temp.ok((select status = 'computed' and sent_back_note = 'Check the bonus' from public.payroll_runs), 'Finance sends it back with a reason');
select pg_temp.run(:RE::uuid, 'select public.payroll_run_submit(' || :'R' || ')');
select pg_temp.fails_as(:RE::uuid, 'select public.payroll_run_approve(' || :'R' || ')', 'Approve access', 'HR can''t approve pay');
select pg_temp.fails_as(:FA::uuid, 'select public.payroll_run_approve(' || :'R' || ')', 'password', 'approving needs the password re-entered');
select public.staff_record_reauth(:FA::uuid);
select public.staff_record_reauth(:FS::uuid);
select pg_temp.fails_as(:FS::uuid, 'select public.payroll_run_approve(' || :'R' || ')', 'limit', 'an approver''s peso limit applies to total net pay');
select pg_temp.fails_as(:FA::uuid, 'select public.payroll_run_release(' || :'R' || ')', 'approved', 'can''t release before approval');
select pg_temp.run(:FA::uuid, 'select public.payroll_run_approve(' || :'R' || ')');
select pg_temp.ok((select status = 'approved' and approved_by = :FA::uuid from public.payroll_runs), 'Finance approves');

-- ---- release ------------------------------------------------------------------
select pg_temp.ok(pg_temp.seen(:T::uuid, 'select * from public.payroll_lines') = 0, 'no payslip before release');
select pg_temp.fails_as(:RE::uuid, 'select public.payroll_run_release(' || :'R' || ')', 'Payroll Approval', 'HR can''t release pay');
select pg_temp.run(:FA::uuid, 'select public.payroll_run_release(' || :'R' || ')');
select pg_temp.ok((select status = 'released' and released_by = :FA::uuid from public.payroll_runs), 'released');
select pg_temp.ok((select (data->'liquidation'->'settlement'->>'settled')::boolean and data->'liquidation'->'settlement'->>'settledBy' = 'Fay Approver'
                     from public.cash_advance_requests where id = 'cafe0000-0000-0000-0000-000000000001'), 'the cash advance is marked settled by payroll');
select pg_temp.ok((select balance = 400 and is_active from public.payroll_recurring_items where code = 'SSS_LOAN'), 'the loan balance goes down');
select pg_temp.ok(pg_temp.seen(:T::uuid, 'select * from public.payroll_lines') = 1, 'the technician sees their own payslip');
select pg_temp.ok(pg_temp.seen(:T2::uuid, $q$select * from public.payroll_lines where profile_id = '00000000-0000-0000-0000-0000000000b1'$q$) = 0, '… and nobody else''s');
select pg_temp.ok(pg_temp.seen(:T::uuid, 'select * from public.payroll_runs') = 1, '… and the run it belongs to');
select pg_temp.ok(pg_temp.seen('00000000-0000-0000-0000-0000000000b4'::uuid, 'select * from public.payroll_runs') = 0, 'someone not paid in it sees no run');
select pg_temp.ok(pg_temp.seen(:T::uuid, 'select * from public.payroll_run_adjustments') = 0, 'technicians don''t read the run''s adjustments');
select pg_temp.fails_as(:RE::uuid, 'select public.payroll_run_delete(' || :'R' || ')', 'can''t be deleted', 'a released run can''t be deleted');
select pg_temp.fails_as(:HA::uuid, 'select public.payroll_period_unlock(' || :'P' || ', ''x'')', 'can''t be unlocked any more', 'its timesheets can never be unlocked');

rollback;

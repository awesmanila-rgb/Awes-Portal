-- =====================================================================
-- Probe for 20261005_01_payroll_timesheets.sql — building timesheets
-- from DTR / leave / holidays, how each day is worked out, HR
-- corrections, OT approval, review, lock / unlock, totals, and who can
-- read what. One transaction, rolled back.
--   psql -d awes_backup -f payroll_timesheets_probe.sql
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

-- ---- periods ---------------------------------------------------------
select pg_temp.fails_as(:HV::uuid, $q$select public.payroll_period_create('SEMI_MONTHLY','2026-09-01','2026-09-15','2026-09-20')$q$, 'Edit access', 'View access can''t open a period');
select pg_temp.run(:HE::uuid, $q$select public.payroll_period_create('SEMI_MONTHLY','2026-09-01','2026-09-15','2026-09-20')$q$);
select pg_temp.fails_as(:HE::uuid, $q$select public.payroll_period_create('SEMI_MONTHLY','2026-09-10','2026-09-25','2026-09-30')$q$, 'overlaps', 'overlapping periods are refused');
select pg_temp.fails_as(:HE::uuid, $q$select public.payroll_period_create('MONTHLY','2026-09-01','2026-10-15','2026-10-20')$q$, 'longer than a month', 'a period can''t be longer than a month');
\set P '(select id from public.payroll_periods where pay_frequency = ''SEMI_MONTHLY'' and period_start = ''2026-09-01'')'

-- ---- build -------------------------------------------------------------
select pg_temp.fails_as(:HV::uuid, 'select public.payroll_period_build(' || :'P' || ')', 'Edit access', 'View access can''t build');
select pg_temp.run(:HE::uuid, 'select public.payroll_period_build(' || :'P' || ')');
select pg_temp.ok((select count(*) = 30 from public.payroll_timesheet_days where period_id = :P), 'two semi-monthly people × 15 days built (the weekly one is left out)');

select pg_temp.ok((select regular_min = 480 and late_min = 0 and status = 'present' and day_type = 'ORDINARY' from pg_temp.day(:T, '2026-09-01')), 'full day: 8 hours regular');
select pg_temp.ok((select late_min = 20 and regular_min = 460 and 'LATE' = any(flags) from pg_temp.day(:T, '2026-09-02')), '20 minutes late (past the grace period)');
select pg_temp.ok((select late_min = 0 and regular_min = 475 from pg_temp.day(:T, '2026-09-03')), '5 minutes late is inside the grace period');
select pg_temp.ok((select undertime_min = 60 and regular_min = 420 from pg_temp.day(:T, '2026-09-04')), 'left an hour early: undertime');
select pg_temp.ok((select ot_claimed_min = 270 and ot_paid_min = 0 and 'OT_NOT_APPROVED' = any(flags) from pg_temp.day(:T, '2026-09-05')), 'OT is claimed but not paid until approved');
select pg_temp.ok((select day_type = 'REST_DAY' and premium_min = 480 and regular_min = 0 from pg_temp.day(:T, '2026-09-06')), 'work on the rest day is rest-day premium');
select pg_temp.ok((select status = 'absent' from pg_temp.day(:T, '2026-09-07')), 'no DTR and only a pending leave: absent');
select pg_temp.ok((select regular_min = 480 from pg_temp.day(:T, '2026-09-08')), 'older "HH:MM" DTR records are read too');
select pg_temp.ok((select status = 'incomplete' and 'MISSING_OUT' = any(flags) from pg_temp.day(:T, '2026-09-09')), 'no time-out: flagged');
select pg_temp.ok((select status = 'leave' and leave_paid and leave_type = 'Vacation Leave' from pg_temp.day(:T, '2026-09-10')), 'approved vacation leave: paid leave');
select pg_temp.ok((select status = 'holiday' and holiday_kind = 'REGULAR' from pg_temp.day(:T, '2026-09-12')), 'regular holiday not worked');
select pg_temp.ok((select status = 'rest' from pg_temp.day(:T, '2026-09-13')), 'Sunday: rest day');
select pg_temp.ok((select day_type = 'SPECIAL_HOLIDAY' and premium_min = 480 from pg_temp.day(:T, '2026-09-14')), 'worked the special day: special-day premium');
select pg_temp.ok((select status = 'leave' and not leave_paid from pg_temp.day(:T, '2026-09-15')), 'unpaid leave');
select pg_temp.ok((select status = 'rest' from pg_temp.day(:T2, '2026-09-05')), 'Saturday is a rest day for the Mon–Fri person');
select pg_temp.ok((select status = 'holiday' and day_type = 'HOLIDAY_REGULAR_REST_DAY' from pg_temp.day(:T2, '2026-09-12')), 'holiday on a rest day is typed as such');

-- ---- who can read -------------------------------------------------------
select pg_temp.ok(pg_temp.seen(:HV::uuid, 'select * from public.payroll_timesheet_days') = 30, 'Timesheets (view) reads the days');
select pg_temp.ok(pg_temp.seen(:HV::uuid, 'select * from public.payroll_employees') = 0, '… but never the pay rates');
select pg_temp.ok(pg_temp.seen(:HV::uuid, $q$select * from public.payroll_period_totals((select id from public.payroll_periods limit 1)) where shift_start = '08:00'$q$) = 2,
  '… and gets the shifts through the totals');
select pg_temp.ok(pg_temp.seen(:T::uuid, 'select * from public.payroll_timesheet_days') = 0, 'a technician can''t see their days while the period is open');

-- ---- corrections & OT -----------------------------------------------------
select pg_temp.run(:HV::uuid, $q$update public.payroll_timesheet_days set time_out = '2026-09-09T09:00:00Z', adjust_note = 'x' where work_date = '2026-09-09'$q$);
select pg_temp.ok((select time_out is null from pg_temp.day(:T, '2026-09-09')), 'View access can''t correct a day');
select pg_temp.fails_as(:HE::uuid, $q$update public.payroll_timesheet_days set time_out = '2026-09-09T09:00:00Z' where profile_id = '00000000-0000-0000-0000-0000000000b1' and work_date = '2026-09-09'$q$,
  'Say why', 'a correction needs a note');
select pg_temp.fails_as(:HE::uuid, $q$update public.payroll_timesheet_days set regular_min = 999 where work_date = '2026-09-09'$q$, 'permission denied', 'worked-out columns can''t be written');
select pg_temp.run(:HE::uuid, $q$update public.payroll_timesheet_days set time_out = '2026-09-09T09:00:00Z', adjust_note = 'Forgot to time out; confirmed by foreman'
  where profile_id = '00000000-0000-0000-0000-0000000000b1' and work_date = '2026-09-09'$q$);
select pg_temp.ok((select status = 'present' and regular_min = 480 and adjusted and adjusted_by = :HE::uuid and cardinality(flags) = 0 from pg_temp.day(:T, '2026-09-09')),
  'the corrected day is worked out again and marked corrected');
select pg_temp.ok(exists (select 1 from public.activity_log where entity_type = 'payroll_timesheet_days' and details->>'note' like 'Forgot%'), 'the correction is in the activity log');
select pg_temp.run(:HE::uuid, $q$update public.payroll_timesheet_days set hr_status = 'leave_paid', adjust_note = 'Sick, medical certificate'
  where profile_id = '00000000-0000-0000-0000-0000000000b1' and work_date = '2026-09-07'$q$);
select pg_temp.ok((select status = 'leave' and leave_paid from pg_temp.day(:T, '2026-09-07')), 'HR can turn an absence into paid leave');

select pg_temp.run(:HE::uuid, 'select public.payroll_ts_set_reviewed(' || :'P' || ', ''00000000-0000-0000-0000-0000000000b2'', true)');
select pg_temp.fails_as(:HE::uuid, 'select public.payroll_ts_set_reviewed(' || :'P' || ', ''00000000-0000-0000-0000-0000000000b1'', true)',
  'need attention', 'can''t mark someone reviewed with OT still unapproved');
select pg_temp.run(:HE::uuid, 'select public.payroll_ts_approve_ot(' || :'P' || ', ''00000000-0000-0000-0000-0000000000b1'')');
select pg_temp.ok((select ot_paid_min = 270 and nd_ot_min = 30 and ot_approved_by = :HE::uuid and cardinality(flags) = 0 from pg_temp.day(:T, '2026-09-05')),
  'approved OT is paid; 22:00–22:30 counts as night differential');
select pg_temp.run(:HE::uuid, $q$update public.payroll_timesheet_days set ot_approved_min = 120 where profile_id = '00000000-0000-0000-0000-0000000000b1' and work_date = '2026-09-05'$q$);
select pg_temp.ok((select ot_paid_min = 120 and nd_ot_min = 30 from pg_temp.day(:T, '2026-09-05')), 'HR can approve part of the OT');
select pg_temp.run(:HE::uuid, 'select public.payroll_ts_set_reviewed(' || :'P' || ', ''00000000-0000-0000-0000-0000000000b1'', true)');
select pg_temp.ok((select count(*) = 2 from public.payroll_timesheets where period_id = :P and reviewed_at is not null), 'both marked reviewed');

-- ---- totals ------------------------------------------------------------
select pg_temp.ok((select regular_hours = 54.58 and late_hours = 0.33 and undertime_hours = 1 and days_absent = 0 and days_paid_leave = 3 and days_unpaid_leave = 1
                     and premium_hours = '{"REST_DAY": 8.00, "SPECIAL_HOLIDAY": 8.00}'::jsonb and ot_hours = '{"OT_REGULAR": 2.00}'::jsonb
                     and nd_hours = '{"OT_REGULAR": 0.50}'::jsonb and unworked_regular_holidays = 1 and issues = 0
                     from public.payroll_period_totals(:P) where profile_id = :T::uuid),
  'totals come out by bucket, keyed by the labor premium codes');
select pg_temp.ok((select days_absent = 10 from public.payroll_period_totals(:P) where profile_id = :T2::uuid), 'the Mon–Fri person with no DTR: 10 absences');

-- ---- lock ----------------------------------------------------------------
select pg_temp.fails_as(:HE::uuid, 'select public.payroll_period_lock(' || :'P' || ')', 'Approve access', 'Edit access can''t lock');
select pg_temp.fails_as(:HA::uuid, 'select public.payroll_period_lock(' || :'P' || ')', 'password', 'locking needs the password re-entered');
select public.staff_record_reauth(:HA::uuid);
select pg_temp.run(:HA::uuid, $q$update public.payroll_timesheet_days set hr_status = 'absent', adjust_note = 'AWOL' where profile_id = '00000000-0000-0000-0000-0000000000b2' and work_date = '2026-09-01'$q$);
select pg_temp.fails_as(:HA::uuid, 'select public.payroll_period_lock(' || :'P' || ')', 'reviewed', 'a correction un-reviews the person; lock refuses');
select pg_temp.run(:HA::uuid, 'select public.payroll_ts_set_reviewed(' || :'P' || ', ''00000000-0000-0000-0000-0000000000b2'', true)');
select pg_temp.run(:HA::uuid, 'select public.payroll_period_lock(' || :'P' || ')');
select pg_temp.ok((select status = 'locked' and locked_by = :HA::uuid from public.payroll_periods where id = :P), 'approver locks the period');
select pg_temp.fails_as(:A::uuid, $q$update public.payroll_timesheet_days set time_in = null, adjust_note = 'x' where work_date = '2026-09-01'$q$, 'locked', 'a locked period can''t be corrected');
select pg_temp.fails_as(:A::uuid, 'select public.payroll_period_build(' || :'P' || ')', 'locked', '… or rebuilt');
select pg_temp.fails_as(:A::uuid, 'select public.payroll_period_delete(' || :'P' || ')', 'locked', '… or deleted');
select pg_temp.ok(pg_temp.seen(:T::uuid, 'select * from public.payroll_timesheet_days') = 15, 'once locked, a technician sees their own 15 days');
select pg_temp.ok(pg_temp.seen(:T::uuid, 'select * from public.payroll_periods') = 1, '… and the period');
select pg_temp.ok(pg_temp.seen(:T::uuid, 'select * from public.payroll_period_totals(' || :'P' || ')') = 1, '… and only their own totals');
select pg_temp.ok(pg_temp.seen('00000000-0000-0000-0000-0000000000b4'::uuid, 'select * from public.payroll_timesheet_days') = 0, 'someone not in the period sees nothing');

-- ---- unlock & rebuild -------------------------------------------------------
select pg_temp.fails_as(:HA::uuid, 'select public.payroll_period_unlock(' || :'P' || ', '''')', 'why', 'unlocking needs a reason');
select pg_temp.run(:HA::uuid, 'select public.payroll_period_unlock(' || :'P' || ', ''Late OT slip'')');
select pg_temp.run(:HE::uuid, 'select public.payroll_period_build(' || :'P' || ')');
select pg_temp.ok((select adjusted and regular_min = 480 from pg_temp.day(:T, '2026-09-09')), 'rebuilding keeps HR''s corrections');
select pg_temp.ok((select ot_paid_min = 120 from pg_temp.day(:T, '2026-09-05')), '… and OT approvals whose OT didn''t change');
select pg_temp.ok((select count(*) = 0 from public.payroll_timesheets where period_id = :P and reviewed_at is not null), '… but everyone needs reviewing again');
select pg_temp.run(:HE::uuid, 'select public.payroll_period_build(' || :'P' || ', true)');
select pg_temp.ok((select not adjusted and status = 'incomplete' from pg_temp.day(:T, '2026-09-09')), '"start over" throws corrections away');
select pg_temp.ok((select ot_approved_min is null from pg_temp.day(:T, '2026-09-05')), '… and OT approvals');

rollback;

-- =====================================================================
-- Probe for 20261003_01_staff_attendance_split.sql — Technician Attendance
-- vs Office Staff Attendance. One transaction, rolled back.
--   psql -d awes_backup -f attendance_split_probe.sql
-- =====================================================================
\set ON_ERROR_STOP 1
begin;
create function pg_temp.ok(p_cond boolean, p_name text) returns void language plpgsql as $$
begin if p_cond then raise notice 'PASS  %', p_name; else raise exception 'FAIL  %', p_name; end if; end $$;
create function pg_temp.seen(p_user uuid, p_sql text) returns bigint language plpgsql as $$
declare n bigint; begin
  perform set_config('request.jwt.claim.sub', p_user::text, true); perform set_config('request.jwt.claim.role', 'authenticated', true);
  set local role authenticated; execute 'select count(*) from (' || p_sql || ') x' into n; reset role; return n; end $$;
select set_config('request.jwt.claim.role', 'service_role', true);

insert into auth.users (id, email) values
  ('af000000-0000-0000-0000-000000000001','d@s'), ('af000000-0000-0000-0000-000000000002','o@s'),
  ('af000000-0000-0000-0000-000000000003','h@s'), ('af000000-0000-0000-0000-000000000004','x@s'),
  ('af000000-0000-0000-0000-000000000005','sub@s');
insert into public.profiles (id, name, role, username) values
  ('af000000-0000-0000-0000-000000000001','Dina Dispatcher','staff','sp_disp'),
  ('af000000-0000-0000-0000-000000000002','Olive Office-DTR','staff','sp_off'),
  ('af000000-0000-0000-0000-000000000003','Hana HR Head','staff','sp_hr'),
  ('af000000-0000-0000-0000-000000000004','Xavier Legacy','staff','sp_leg');
\set D   '''af000000-0000-0000-0000-000000000001'''
\set O   '''af000000-0000-0000-0000-000000000002'''
\set H   '''af000000-0000-0000-0000-000000000003'''
\set X   '''af000000-0000-0000-0000-000000000004'''
\set SUB '''af000000-0000-0000-0000-000000000005'''
\set A   '''00000000-0000-0000-0000-0000000000a1'''
\set T   '''00000000-0000-0000-0000-0000000000b1'''
select public.staff_apply_access(:D::uuid, '[{"id":"operations"},{"id":"hr"}]', '[{"module":"ops.dispatch","level":"edit"},{"module":"hr.attendance","level":"view"}]', :A::uuid);
select public.staff_apply_access(:O::uuid, '[{"id":"hr"}]', '[{"module":"hr.staff_attendance","level":"view"}]', :A::uuid);
select public.staff_apply_access(:H::uuid, '[{"id":"hr","is_head":true}]', '[{"module":"hr.attendance","level":"view"},{"module":"hr.staff_attendance","level":"view"}]', :A::uuid);
insert into public.profiles (id, name, role, username, supervisor_id) values (:SUB::uuid, 'Sam Sub', 'staff', 'sp_sub', :H::uuid);
-- time records: a technician's and an office staff member's
insert into public.dtr_records (id, technician_id, date, data) values
  ('b0f00000-0000-0000-0000-000000000001', :T::uuid,   current_date, '{"timeIn":"2026-10-01T08:00:00+08:00"}'),
  ('b0f00000-0000-0000-0000-000000000002', :SUB::uuid, current_date, '{"timeIn":"2026-10-01T08:05:00+08:00"}');

select pg_temp.ok((select label from public.app_modules where key = 'hr.attendance') = 'Technician Attendance'
                  and (select label from public.app_modules where key = 'hr.staff_attendance') = 'Office Staff Attendance',
                  'two pages: Technician Attendance and Office Staff Attendance');

-- ---- Technician Attendance only (e.g. an Operations dispatcher) -----------
select pg_temp.ok(pg_temp.seen(:D::uuid, 'select 1 from public.dtr_records where id = ''b0f00000-0000-0000-0000-000000000001''') = 1, 'Technician Attendance: sees technicians'' time records');
select pg_temp.ok(pg_temp.seen(:D::uuid, 'select 1 from public.dtr_records where id = ''b0f00000-0000-0000-0000-000000000002''') = 0, '… but not office staff''s');
select pg_temp.ok(pg_temp.seen(:D::uuid, 'select 1 from public.profiles where role = ''staff'' and id <> ''af000000-0000-0000-0000-000000000001''') = 0,
                  '… and not office staff''s names either');
select pg_temp.ok(pg_temp.seen(:D::uuid, 'select 1 from public.profiles where role = ''technician''') >= 1, '… while technicians'' names are there');

-- ---- Office Staff Attendance only ------------------------------------------
select pg_temp.ok(pg_temp.seen(:O::uuid, 'select 1 from public.dtr_records where id = ''b0f00000-0000-0000-0000-000000000002''') = 1 and pg_temp.seen(:O::uuid, 'select 1 from public.dtr_records where id = ''b0f00000-0000-0000-0000-000000000001''') = 0, 'Office Staff Attendance: office staff only, no technicians');
select pg_temp.ok(pg_temp.seen(:O::uuid, 'select 1 from public.profiles where id = ''af000000-0000-0000-0000-000000000005''') = 1, '… with their names');

-- ---- both, own, team ---------------------------------------------------------
select pg_temp.ok(pg_temp.seen(:H::uuid, 'select 1 from public.dtr_records where id = ''b0f00000-0000-0000-0000-000000000001''') = 1 and pg_temp.seen(:H::uuid, 'select 1 from public.dtr_records where id = ''b0f00000-0000-0000-0000-000000000002''') = 1, 'both pages: sees everyone');
select pg_temp.ok(pg_temp.seen(:SUB::uuid, 'select 1 from public.dtr_records where id = ''b0f00000-0000-0000-0000-000000000002''') = 1 and pg_temp.seen(:SUB::uuid, 'select 1 from public.dtr_records where id = ''b0f00000-0000-0000-0000-000000000001''') = 0, 'everyone still sees their own');
select pg_temp.ok(pg_temp.seen(:A::uuid, 'select 1 from public.dtr_records where id = ''b0f00000-0000-0000-0000-000000000001''') = 1 and pg_temp.seen(:A::uuid, 'select 1 from public.dtr_records where id = ''b0f00000-0000-0000-0000-000000000002''') = 1, 'the Super Admin sees everyone');

-- ---- upgrading: people who had Attendance keep office staff — once ---------
-- a database from before the split: Xavier and Dina only had "Attendance"
delete from public.app_one_time_steps where step = 'hr_attendance_split';
delete from public.staff_access where module_key = 'hr.staff_attendance' and user_id in (:X::uuid, :D::uuid);
select public.staff_apply_access(:X::uuid, '[{"id":"hr"}]', '[{"module":"hr.attendance","level":"view"}]', :A::uuid);
insert into public.access_templates (id, name, departments, access) values
  ('af100000-0000-0000-0000-000000000001', 'HR Clerk (old)', '["hr"]', '[{"module":"hr.attendance","level":"view"},{"module":"hr.leaves","level":"view"}]');
select pg_temp.ok(public.hr_split_attendance_once(), 'the upgrade copy runs the first time');
select pg_temp.ok((select level from public.staff_access where user_id = :X::uuid and module_key = 'hr.staff_attendance') = 1,
                  'someone who had Attendance gets Office Staff Attendance at the same level');
select pg_temp.ok(pg_temp.seen(:X::uuid, 'select 1 from public.dtr_records where id = ''b0f00000-0000-0000-0000-000000000002''') = 1,
                  '… and still sees office staff''s time records');
select pg_temp.ok((select exists (select 1 from jsonb_array_elements(access) a where a->>'module' = 'hr.staff_attendance')
                     from public.access_templates where id = 'af100000-0000-0000-0000-000000000001'),
                  'a role template with Attendance gains Office Staff Attendance');
-- the Super Admin then sets the dispatcher to technicians only …
select public.staff_apply_access(:D::uuid, '[{"id":"operations"},{"id":"hr"}]', '[{"module":"ops.dispatch","level":"edit"},{"module":"hr.attendance","level":"view"}]', :A::uuid);
-- … and later re-runs the migration
select pg_temp.ok(not public.hr_split_attendance_once(), 'a re-run skips the copy');
select pg_temp.ok((select count(*) from public.staff_access where user_id = :D::uuid and module_key = 'hr.staff_attendance') = 0,
                  'the dispatcher stays on Technician Attendance only');

\echo
\echo 'All attendance split probes passed — rolling back.'
rollback;

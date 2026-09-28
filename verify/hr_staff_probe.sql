-- =====================================================================
-- Probe suite for 20260926_05_hr_staff_access.sql
-- One transaction, rolled back. Prints PASS per check.
--   psql -d awes_backup -f hr_staff_probe.sql
-- =====================================================================
\set ON_ERROR_STOP 1
begin;

create function pg_temp.ok(p_cond boolean, p_name text) returns void language plpgsql as $$
begin if p_cond then raise notice 'PASS  %', p_name; else raise exception 'FAIL  %', p_name; end if; end $$;
create function pg_temp.fails(p_sql text, p_like text, p_name text) returns void language plpgsql as $$
begin
  begin execute p_sql;
  exception when others then
    if sqlerrm ilike '%' || p_like || '%' then raise notice 'PASS  % (%)', p_name, sqlerrm; return; end if;
    raise exception 'FAIL  % — wrong error: %', p_name, sqlerrm;
  end;
  raise exception 'FAIL  % — succeeded but should have failed', p_name;
end $$;
create function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p::text, ''), true);
  perform set_config('request.jwt.claim.role', case when p is null then 'service_role' else 'authenticated' end, true);
end $$;
create function pg_temp.cnt(p_sql text) returns bigint language plpgsql as $$
declare n bigint; begin execute 'select count(*) from (' || p_sql || ') x' into n; return n; end $$;

insert into auth.users (id, email) values
  ('80000000-0000-0000-0000-00000000000a','ha@staff.awes-app.local'),
  ('80000000-0000-0000-0000-00000000000b','hb@staff.awes-app.local'),
  ('80000000-0000-0000-0000-00000000000c','hc@staff.awes-app.local');
insert into public.profiles (id, name, role, username) values
  ('80000000-0000-0000-0000-00000000000a','Hana HR Head','staff','h_head'),
  ('80000000-0000-0000-0000-00000000000b','Hugo HR Viewer','staff','h_view'),
  ('80000000-0000-0000-0000-00000000000c','Pat Purchasing','staff','h_pur');
\set HA '''80000000-0000-0000-0000-00000000000a'''
\set HB '''80000000-0000-0000-0000-00000000000b'''
\set HC '''80000000-0000-0000-0000-00000000000c'''
\set A  '''00000000-0000-0000-0000-0000000000a1'''
\set T  '''00000000-0000-0000-0000-0000000000b1'''
\set T2 '''00000000-0000-0000-0000-0000000000b2'''
\set LV '''90000000-0000-0000-0000-000000000001'''

select pg_temp.as_user(null);
select public.staff_apply_access(:HA::uuid, '[{"id":"hr","is_head":true}]',
  '[{"module":"hr.attendance","level":"view"},{"module":"hr.leaves","level":"approve"},{"module":"hr.tech_profiles","level":"edit"}]', :A::uuid);
select public.staff_apply_access(:HB::uuid, '[{"id":"hr"}]',
  '[{"module":"hr.leaves","level":"view"},{"module":"hr.tech_profiles","level":"view"}]', :A::uuid);
select public.staff_apply_access(:HC::uuid, '[{"id":"purchasing"}]', '[{"module":"pur.suppliers","level":"view"}]', :A::uuid);

-- technician activity (unchanged paths)
select pg_temp.as_user(:T::uuid); set local role authenticated;
insert into public.dtr_records (id, technician_id, date, data) values ('91000000-0000-0000-0000-000000000001', :T::uuid, current_date, '{"timeIn":"2026-09-25T08:00:00+08:00"}')
  on conflict (id) do nothing;
insert into public.leave_requests (id, technician_id, status, submitted_at, data)
  values (:LV::uuid, :T::uuid, 'pending', now(), '{"leaveType":"Sick","dateFrom":"2026-09-29","dateTo":"2026-09-30","reason":"Flu"}');
reset role;

-- ---- Attendance ---------------------------------------------------
select pg_temp.as_user(:HA::uuid); set local role authenticated;
select pg_temp.ok(pg_temp.cnt('select 1 from public.dtr_records where id = ''91000000-0000-0000-0000-000000000001''') = 1, 'Attendance View: reads technicians'' DTR');
select pg_temp.ok(pg_temp.cnt('select 1 from public.profiles where role = ''technician''') >= 2, 'HR: sees the technician list');
update public.dtr_records set data = '{"timeIn":"2026-09-25T06:00:00+08:00"}' where id = '91000000-0000-0000-0000-000000000001';
reset role;
select pg_temp.ok((select data->>'timeIn' from public.dtr_records where id = '91000000-0000-0000-0000-000000000001') = '2026-09-25T08:00:00+08:00', 'HR cannot alter a DTR entry');
select pg_temp.as_user(:HB::uuid); set local role authenticated;
select pg_temp.ok(pg_temp.cnt('select 1 from public.dtr_records where id = ''91000000-0000-0000-0000-000000000001''') = 0, 'no Attendance access → no DTR');
reset role;
select pg_temp.as_user(:HC::uuid); set local role authenticated;
select pg_temp.ok(pg_temp.cnt('select 1 from public.leave_requests where id = ''90000000-0000-0000-0000-000000000001''') = 0, 'non-HR staff see no leave requests');
select pg_temp.ok(pg_temp.cnt('select 1 from public.profiles where role = ''technician''') = 0, 'non-HR staff (Suppliers only) see no technician profiles');
reset role;

-- ---- Leave decisions ------------------------------------------------
select pg_temp.as_user(:HB::uuid); set local role authenticated;
select pg_temp.ok(pg_temp.cnt('select 1 from public.leave_requests where id = ''90000000-0000-0000-0000-000000000001''') = 1, 'Leaves View: sees the request');
update public.leave_requests set status = 'approved', data = data || '{"status":"approved"}' where id = '90000000-0000-0000-0000-000000000001';
reset role;
select pg_temp.ok((select status from public.leave_requests where id = :LV::uuid) = 'pending', 'Leaves View: cannot decide');

select pg_temp.as_user(:HA::uuid); set local role authenticated;
select pg_temp.fails($q$update public.leave_requests set status='approved', data = data || '{"status":"approved"}' where id='90000000-0000-0000-0000-000000000001'$q$,
       'Enter your password', 'deciding asks for password re-entry');
reset role;
select pg_temp.as_user(null); select public.staff_record_reauth(:HA::uuid);
select pg_temp.as_user(:HA::uuid); set local role authenticated;
select pg_temp.fails($q$update public.leave_requests set data = data || '{"dateTo":"2026-10-15"}' where id='90000000-0000-0000-0000-000000000001'$q$,
       'Only the person who filed', 'HR cannot change the leave dates');
update public.leave_requests set status = 'approved',
  data = data || '{"status":"approved","comment":"Get well","decidedBy":"Someone Else"}' where id = '90000000-0000-0000-0000-000000000001';
reset role;
select pg_temp.ok((select status = 'approved' and data->>'decidedBy' = 'Hana HR Head' and data->>'comment' = 'Get well'
                     from public.leave_requests where id = :LV::uuid), 'Approve: leave approved, stamped with the real approver');
select pg_temp.as_user(:HA::uuid); set local role authenticated;
select pg_temp.fails($q$update public.leave_requests set status='disapproved', data = data || '{"status":"disapproved"}' where id='90000000-0000-0000-0000-000000000001'$q$,
       'already approved', 'a decided leave can''t be flipped by staff');
reset role;

-- staff's own leave can't be self-approved (staff file leave like anyone)
select pg_temp.as_user(:HA::uuid); set local role authenticated;
insert into public.leave_requests (id, technician_id, status, submitted_at, data)
  values ('90000000-0000-0000-0000-000000000002', :HA::uuid, 'pending', now(), '{"leaveType":"Vacation"}');
update public.leave_requests set status = 'approved', data = data || '{"status":"approved"}' where id = '90000000-0000-0000-0000-000000000002';
reset role;
select pg_temp.ok((select status from public.leave_requests where id = '90000000-0000-0000-0000-000000000002') = 'pending',
                  'HR Head cannot approve their own leave');

-- ---- Violations & documents ----------------------------------------
select pg_temp.as_user(:HA::uuid); set local role authenticated;
insert into public.technician_violations (technician_id, occurred_on, description) values (:T::uuid, current_date, 'Late — probe');
select pg_temp.ok(true, 'Profiles Edit: records a violation');
insert into public.technician_documents (technician_id, title, file_data) values (:T::uuid, 'Memo — probe', 'data:application/pdf;base64,AAAA');
select pg_temp.ok(true, 'Profiles Edit: uploads a document');
select pg_temp.fails(format($q$insert into public.technician_violations (technician_id, occurred_on, description) values (%L, current_date, 'x')$q$,
       '80000000-0000-0000-0000-00000000000b'), 'row-level security', 'violations only for technicians (not staff accounts)');
reset role;
select pg_temp.as_user(:HB::uuid); set local role authenticated;
select pg_temp.ok(pg_temp.cnt('select 1 from public.technician_violations where description = ''Late — probe''') = 1, 'Profiles View: sees violations');
select pg_temp.fails(format($q$insert into public.technician_violations (technician_id, occurred_on, description) values (%L, current_date, 'x')$q$,
       '00000000-0000-0000-0000-0000000000b1'), 'row-level security', 'Profiles View: cannot add a violation');
delete from public.technician_documents where title = 'Memo — probe';
reset role;
select pg_temp.ok((select count(*) from public.technician_documents where title = 'Memo — probe') = 1, 'Profiles View: cannot remove a document');

-- ---- technicians & accounts unchanged -------------------------------
select pg_temp.as_user(:T2::uuid); set local role authenticated;
select pg_temp.ok(pg_temp.cnt('select 1 from public.technician_violations where description = ''Late — probe''') = 0, 'another technician still can''t see it');
reset role;
select pg_temp.as_user(:HA::uuid); set local role authenticated;
update public.profiles set active = false where id = '00000000-0000-0000-0000-0000000000b1';
reset role;
select pg_temp.ok((select active from public.profiles where id = :T::uuid), 'HR cannot deactivate a technician account (Super Admin only)');

\echo
\echo 'All HR staff probes passed — rolling back.'
rollback;

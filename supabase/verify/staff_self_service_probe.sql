-- =====================================================================
-- Probe for 20261001_01_staff_self_service.sql — office staff's own
-- attendance / leave / cash advance, Head endorsement, team view.
-- One transaction, rolled back.   psql -d awes_backup -f staff_self_service_probe.sql
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
create function pg_temp.inbox_has(p_kind text, p_ref text) returns boolean language sql as $$
  select exists (select 1 from jsonb_array_elements(public.inbox_items()) x where x->>'kind' = p_kind and x->>'ref_id' = p_ref) $$;
create function pg_temp.seen(p_user uuid, p_sql text) returns bigint language plpgsql as $$
declare n bigint; begin
  perform pg_temp.as_user(p_user); set local role authenticated;
  execute 'select count(*) from (' || p_sql || ') x' into n; reset role; return n; end $$;

insert into auth.users (id, email) values
  ('ab000000-0000-0000-0000-00000000000a','h@s'), ('ab000000-0000-0000-0000-00000000000b','s@s'),
  ('ab000000-0000-0000-0000-00000000000c','hr@s'), ('ab000000-0000-0000-0000-00000000000d','fin@s'), ('ab000000-0000-0000-0000-00000000000e','h2@s');
insert into public.profiles (id, name, role, username) values
  ('ab000000-0000-0000-0000-00000000000a','Hera Head','staff','ss_head'),
  ('ab000000-0000-0000-0000-00000000000c','Hana HR','staff','ss_hr'),
  ('ab000000-0000-0000-0000-00000000000d','Fina Finance','staff','ss_fin'),
  ('ab000000-0000-0000-0000-00000000000e','Other Head','staff','ss_head2');
\set H  '''ab000000-0000-0000-0000-00000000000a'''
\set S  '''ab000000-0000-0000-0000-00000000000b'''
\set HR '''ab000000-0000-0000-0000-00000000000c'''
\set FN '''ab000000-0000-0000-0000-00000000000d'''
\set H2 '''ab000000-0000-0000-0000-00000000000e'''
\set A  '''00000000-0000-0000-0000-0000000000a1'''
\set T  '''00000000-0000-0000-0000-0000000000b1'''
select pg_temp.as_user(null);
select public.staff_apply_access(:H::uuid, '[{"id":"purchasing","is_head":true}]', '[{"module":"pur.suppliers","level":"edit"}]', :A::uuid);
select public.staff_apply_access(:H2::uuid, '[{"id":"operations","is_head":true}]', '[{"module":"ops.dispatch","level":"view"}]', :A::uuid);
insert into public.profiles (id, name, role, username, supervisor_id) values (:S::uuid, 'Sam Sub', 'staff', 'ss_sub', :H::uuid);
select public.staff_apply_access(:S::uuid, '[{"id":"purchasing"}]', '[{"module":"pur.suppliers","level":"view"}]', :H::uuid);
select public.staff_apply_access(:HR::uuid, '[{"id":"hr"}]', '[{"module":"hr.leaves","level":"approve"},{"module":"hr.attendance","level":"view"}]', :A::uuid);
select public.staff_apply_access(:FN::uuid, '[{"id":"finance"}]', '[{"module":"fin.cash_advance","level":"approve"}]', :A::uuid);
select public.staff_record_reauth(:HR::uuid); select public.staff_record_reauth(:FN::uuid);

-- ---- filing: sub-user, Head, technician --------------------------------
select pg_temp.as_user(:S::uuid); set local role authenticated;
insert into public.leave_requests (id, technician_id, status, submitted_at, data) values ('ac000000-0000-0000-0000-000000000001', :S::uuid, 'pending', now(), '{"leaveType":"Vacation Leave","dateFrom":"2026-10-12"}');
insert into public.cash_advance_requests (id, technician_id, status, submitted_at, data) values ('ac000000-0000-0000-0000-000000000002', :S::uuid, 'pending', now(), '{"amount":2000,"technicianName":"Sam Sub"}');
insert into public.dtr_records (id, technician_id, date, data) values ('ac000000-0000-0000-0000-000000000003', :S::uuid, current_date, '{"timeIn":"2026-10-01T08:01:00+08:00"}');
insert into public.device_locks (technician_id, device_id) values (:S::uuid, 'sam-phone');
reset role;
select pg_temp.ok(true, 'office staff time in, register their device, file leave and a cash advance');
select pg_temp.ok((select status = 'pending' and head = :H::uuid from public.request_endorsements where request_id = 'ac000000-0000-0000-0000-000000000001'),
                  'a sub-user''s leave waits for their Head');
select pg_temp.ok(exists (select 1 from public.request_endorsements where request_id = 'ac000000-0000-0000-0000-000000000002'), '… and so does their cash advance');
select pg_temp.as_user(:H::uuid); set local role authenticated;
insert into public.leave_requests (id, technician_id, status, submitted_at, data) values ('ac000000-0000-0000-0000-000000000004', :H::uuid, 'pending', now(), '{"leaveType":"Sick Leave"}');
reset role;
select pg_temp.as_user(:T::uuid); set local role authenticated;
insert into public.leave_requests (id, technician_id, status, submitted_at, data) values ('ac000000-0000-0000-0000-000000000005', :T::uuid, 'pending', now(), '{"leaveType":"Sick Leave"}');
reset role;
select pg_temp.ok(not exists (select 1 from public.request_endorsements where request_id in ('ac000000-0000-0000-0000-000000000004','ac000000-0000-0000-0000-000000000005')),
                  'Heads'' and technicians'' own requests need no endorsement');

-- ---- HR can't approve before the Head endorses ---------------------------
select pg_temp.as_user(:HR::uuid); set local role authenticated;
select pg_temp.fails($q$update public.leave_requests set status='approved', data = data || '{"status":"approved"}' where id='ac000000-0000-0000-0000-000000000001'$q$,
       'Hera Head''s endorsement', 'HR cannot approve a sub-user''s leave before the Head endorses');
reset role;
select pg_temp.as_user(:HR::uuid);
select pg_temp.ok(not pg_temp.inbox_has('leave_decide', 'ac000000-0000-0000-0000-000000000001') and pg_temp.inbox_has('leave_decide', 'ac000000-0000-0000-0000-000000000005'),
                  'HR Inbox: the un-endorsed leave isn''t there yet; the technician''s is');
select pg_temp.ok(not pg_temp.inbox_has('leave_endorse', 'ac000000-0000-0000-0000-000000000001'), 'HR doesn''t get the endorsement item');
select pg_temp.as_user(:H::uuid);
select pg_temp.ok(pg_temp.inbox_has('leave_endorse', 'ac000000-0000-0000-0000-000000000001') and pg_temp.inbox_has('ca_endorse', 'ac000000-0000-0000-0000-000000000002'),
                  'the Head''s Inbox has both items to endorse');
select pg_temp.as_user(:H2::uuid);
select pg_temp.ok(not pg_temp.inbox_has('leave_endorse', 'ac000000-0000-0000-0000-000000000001'), 'another Head doesn''t');

-- ---- who can endorse ------------------------------------------------------
select pg_temp.as_user(:H2::uuid);
select pg_temp.fails($q$select public.staff_endorse('leave', 'ac000000-0000-0000-0000-000000000001', 'endorse')$q$, 'this person''s Head', 'another Head can''t endorse');
select pg_temp.as_user(:S::uuid);
select pg_temp.fails($q$select public.staff_endorse('leave', 'ac000000-0000-0000-0000-000000000001', 'endorse')$q$, 'this person''s Head', 'nobody endorses their own request');
select pg_temp.as_user(:S::uuid); set local role authenticated;
select pg_temp.fails($q$update public.request_endorsements set status = 'endorsed'$q$, 'permission denied', 'endorsements can''t be written directly');
reset role;

-- ---- endorse → HR approves -------------------------------------------------
select pg_temp.as_user(:H::uuid);
select pg_temp.ok(public.staff_endorse('leave', 'ac000000-0000-0000-0000-000000000001', 'endorse') = 'endorsed', 'Head endorses the leave');
select pg_temp.as_user(:HR::uuid);
select pg_temp.ok(pg_temp.inbox_has('leave_decide', 'ac000000-0000-0000-0000-000000000001'), 'now it reaches HR''s Inbox');
select pg_temp.as_user(:HR::uuid); set local role authenticated;
update public.leave_requests set status = 'approved', data = data || '{"status":"approved"}' where id = 'ac000000-0000-0000-0000-000000000001';
reset role;
select pg_temp.ok((select status from public.leave_requests where id = 'ac000000-0000-0000-0000-000000000001') = 'approved', 'HR approves it after endorsement');

-- ---- decline ------------------------------------------------------------------
select pg_temp.as_user(:H::uuid);
select pg_temp.fails($q$select public.staff_endorse('cash', 'ac000000-0000-0000-0000-000000000002', 'decline', '')$q$, 'Give a reason', 'declining needs a reason');
select public.staff_endorse('cash', 'ac000000-0000-0000-0000-000000000002', 'decline', 'Use the petty cash instead');
select pg_temp.ok((select status = 'disapproved' and data->>'comment' like 'Declined by Hera Head: Use the petty cash%' from public.cash_advance_requests
                    where id = 'ac000000-0000-0000-0000-000000000002'), 'Head declines — the advance closes as disapproved with the reason');
select pg_temp.as_user(:FN::uuid); set local role authenticated;
select pg_temp.fails($q$update public.cash_advance_requests set status='approved', data = data || '{"status":"approved"}' where id='ac000000-0000-0000-0000-000000000002'$q$,
       'already', 'Finance can''t approve a declined advance');
reset role;

-- ---- team view (read only) -----------------------------------------------
select pg_temp.ok(pg_temp.seen(:H::uuid, 'select 1 from public.dtr_records where technician_id = ''ab000000-0000-0000-0000-00000000000b''') = 1
                  and pg_temp.seen(:H::uuid, 'select 1 from public.leave_requests where technician_id = ''ab000000-0000-0000-0000-00000000000b''') = 1,
                  'Head sees their sub-user''s attendance and leave');
select pg_temp.ok(pg_temp.seen(:H::uuid, 'select 1 from public.leave_requests where technician_id = ''00000000-0000-0000-0000-0000000000b1''') = 0
                  and pg_temp.seen(:H::uuid, 'select 1 from public.dtr_records where technician_id = ''00000000-0000-0000-0000-0000000000b1''') = 0,
                  '… but nobody outside their team');
select pg_temp.ok(pg_temp.seen(:H2::uuid, 'select 1 from public.dtr_records where technician_id = ''ab000000-0000-0000-0000-00000000000b''') = 0, 'another Head sees none of it');
select pg_temp.as_user(:H::uuid); set local role authenticated;
update public.dtr_records set data = '{"timeIn":"2026-10-01T07:00:00+08:00"}' where id = 'ac000000-0000-0000-0000-000000000003';
reset role;
select pg_temp.ok((select data->>'timeIn' from public.dtr_records where id = 'ac000000-0000-0000-0000-000000000003') = '2026-10-01T08:01:00+08:00', 'the team view is read only');

-- ---- HR sees office staff; device lock is per person -------------------------
select pg_temp.ok(pg_temp.seen(:HR::uuid, 'select 1 from public.profiles where role = ''staff''') >= 4
                  and pg_temp.seen(:HR::uuid, 'select 1 from public.dtr_records where technician_id = ''ab000000-0000-0000-0000-00000000000b''') = 1,
                  'HR sees office staff and their attendance');
select pg_temp.ok(pg_temp.seen(:H::uuid, 'select 1 from public.device_locks') = 0, 'nobody else sees a person''s registered device');

-- ---- Super Admin can override ------------------------------------------------
select pg_temp.as_user(:S::uuid); set local role authenticated;
insert into public.leave_requests (id, technician_id, status, submitted_at, data) values ('ac000000-0000-0000-0000-000000000006', :S::uuid, 'pending', now(), '{"leaveType":"Emergency"}');
reset role;
select pg_temp.as_user(:A::uuid); set local role authenticated;
update public.leave_requests set status = 'approved', data = data || '{"status":"approved"}' where id = 'ac000000-0000-0000-0000-000000000006';
reset role;
select pg_temp.ok((select status from public.leave_requests where id = 'ac000000-0000-0000-0000-000000000006') = 'approved', 'the Super Admin can approve without waiting (override)');

\echo
\echo 'All staff self-service probes passed — rolling back.'
rollback;

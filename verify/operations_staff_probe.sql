-- =====================================================================
-- Probe suite for 20260926_07_operations_staff_access.sql
-- One transaction, rolled back. Prints PASS per check.
--   psql -d awes_backup -f operations_staff_probe.sql
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
  ('b0000000-0000-0000-0000-00000000000a','oa@staff.awes-app.local'),
  ('b0000000-0000-0000-0000-00000000000b','ob@staff.awes-app.local'),
  ('b0000000-0000-0000-0000-00000000000c','oc@staff.awes-app.local');
insert into public.profiles (id, name, role, username) values
  ('b0000000-0000-0000-0000-00000000000a','Dina Dispatcher','staff','o_disp'),
  ('b0000000-0000-0000-0000-00000000000b','Olly Observer','staff','o_view'),
  ('b0000000-0000-0000-0000-00000000000c','Hal HR','staff','o_hr');
\set D  '''b0000000-0000-0000-0000-00000000000a'''
\set O  '''b0000000-0000-0000-0000-00000000000b'''
\set X  '''b0000000-0000-0000-0000-00000000000c'''
\set A  '''00000000-0000-0000-0000-0000000000a1'''
\set T  '''00000000-0000-0000-0000-0000000000b1'''
\set T2 '''00000000-0000-0000-0000-0000000000b2'''
\set CU '''17c5334e-5b59-473b-a31f-72a47cf22d81'''

select pg_temp.as_user(null);
select public.staff_apply_access(:D::uuid, '[{"id":"operations"}]',
  '[{"module":"ops.dispatch","level":"edit"},{"module":"ops.service_requests","level":"edit"},{"module":"ops.service_reports","level":"edit"},{"module":"ops.past_service","level":"edit"}]', :A::uuid);
select public.staff_apply_access(:O::uuid, '[{"id":"operations"}]',
  '[{"module":"ops.dispatch","level":"view"},{"module":"ops.service_requests","level":"view"},{"module":"ops.service_reports","level":"view"}]', :A::uuid);
select public.staff_apply_access(:X::uuid, '[{"id":"hr"}]', '[{"module":"hr.leaves","level":"view"}]', :A::uuid);

-- ---- Dispatch --------------------------------------------------------
select pg_temp.as_user(:D::uuid); set local role authenticated;
insert into public.dispatch_tickets (id, status, data) values ('JO-PROBE-001', 'open',
  jsonb_build_object('id','JO-PROBE-001','status','open','custName','Acme Foods','assignedWorkerIds', jsonb_build_array('00000000-0000-0000-0000-0000000000b1')));
select pg_temp.ok(true, 'Dispatch Edit: creates a job order');
update public.dispatch_tickets set data = data || jsonb_build_object('assignedWorkerIds', jsonb_build_array('00000000-0000-0000-0000-0000000000b2'),
  'removedWorkerIds', jsonb_build_array('00000000-0000-0000-0000-0000000000b1')) where id = 'JO-PROBE-001';
reset role;
select pg_temp.ok((select data->'assignedWorkerIds' @> '["00000000-0000-0000-0000-0000000000b2"]' from public.dispatch_tickets where id = 'JO-PROBE-001'),
                  'Dispatch Edit: reassigns the technician (guard lets dispatchers through)');
select pg_temp.as_user(:D::uuid); set local role authenticated;
insert into public.dispatch_ticket_messages (ticket_id, sender_id, sender_name, sender_role, body)
  values ('JO-PROBE-001', :D::uuid, 'Dina Dispatcher', 'admin', 'Please bring a ladder');
select pg_temp.ok(true, 'Dispatch Edit: posts in the job order chat');
update public.dispatch_tickets set status = 'closed', data = data || '{"status":"closed","closedBy":"Dina Dispatcher"}' where id = 'JO-PROBE-001';
reset role;
select pg_temp.ok((select status from public.dispatch_tickets where id = 'JO-PROBE-001') = 'closed', 'Dispatch Edit: closes a job order');

select pg_temp.as_user(:O::uuid); set local role authenticated;
select pg_temp.ok(pg_temp.cnt('select 1 from public.dispatch_tickets where id = ''JO-PROBE-001''') = 1, 'Dispatch View: sees the job order');
select pg_temp.ok(pg_temp.cnt('select 1 from public.dispatch_ticket_messages where ticket_id = ''JO-PROBE-001''') = 1, 'Dispatch View: reads the chat');
select pg_temp.fails($q$insert into public.dispatch_tickets (id, status, data) values ('JO-PROBE-002','open','{}')$q$, 'row-level security', 'Dispatch View: cannot create a job order');
update public.dispatch_tickets set status = 'open', data = data || '{"status":"open"}' where id = 'JO-PROBE-001';
select pg_temp.fails(format($q$insert into public.dispatch_ticket_messages (ticket_id, sender_id, sender_role, body) values ('JO-PROBE-001', %L, 'admin', 'x')$q$,
       'b0000000-0000-0000-0000-00000000000b'), 'row-level security', 'Dispatch View: cannot post in the chat');
reset role;
select pg_temp.ok((select status from public.dispatch_tickets where id = 'JO-PROBE-001') = 'closed', 'Dispatch View: cannot reopen / change it');

-- technicians unchanged: the newly assigned one sees it and can't touch assignments
select pg_temp.as_user(:T2::uuid); set local role authenticated;
select pg_temp.ok(pg_temp.cnt('select 1 from public.dispatch_tickets where id = ''JO-PROBE-001''') = 1, 'assigned technician sees the job order');
update public.dispatch_tickets set data = data || jsonb_build_object('assignedWorkerIds', '[]'::jsonb) where id = 'JO-PROBE-001';
reset role;
select pg_temp.ok((select data->'assignedWorkerIds' @> '["00000000-0000-0000-0000-0000000000b2"]' from public.dispatch_tickets where id = 'JO-PROBE-001'),
                  'technician still cannot change who is assigned');
select pg_temp.as_user(:X::uuid); set local role authenticated;
select pg_temp.ok(pg_temp.cnt('select 1 from public.dispatch_tickets where id = ''JO-PROBE-001''') = 0, 'non-Operations staff see no job orders');
reset role;

-- ---- Service requests ----------------------------------------------
select pg_temp.as_user(:D::uuid); set local role authenticated;
insert into public.service_requests (id, customer_id, description, status, origin)
  values ('b1000000-0000-0000-0000-000000000001', :CU::uuid, 'Aircon not cooling (phoned in)', 'new', 'admin_dispatch');
update public.service_requests set status = 'schedule_proposed', proposed_schedule_date = current_date + 2 where id = 'b1000000-0000-0000-0000-000000000001';
insert into public.service_request_messages (id, request_id, sender_id, sender_name, sender_role, body)
  values (gen_random_uuid(), 'b1000000-0000-0000-0000-000000000001', :D::uuid, 'AWES', 'admin', 'We can come on Monday');
reset role;
select pg_temp.ok((select status from public.service_requests where id = 'b1000000-0000-0000-0000-000000000001') = 'schedule_proposed', 'Requests Edit: logs, schedules and replies');
select pg_temp.as_user(:D::uuid); set local role authenticated;
select pg_temp.fails($q$insert into public.service_request_messages (id, request_id, sender_id, sender_name, sender_role, body) values (gen_random_uuid(), 'b1000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-00000000000a', 'x', 'customer', 'fake')$q$,
       'row-level security', 'staff cannot post as the customer');
reset role;
select pg_temp.as_user(:O::uuid); set local role authenticated;
select pg_temp.ok(pg_temp.cnt('select 1 from public.service_request_messages where request_id = ''b1000000-0000-0000-0000-000000000001''') = 1, 'Requests View: reads the conversation');
update public.service_requests set status = 'cancelled' where id = 'b1000000-0000-0000-0000-000000000001';
reset role;
select pg_temp.ok((select status from public.service_requests where id = 'b1000000-0000-0000-0000-000000000001') = 'schedule_proposed', 'Requests View: cannot change a request');

-- ---- Service reports & record past service ---------------------------
select pg_temp.as_user(:O::uuid); set local role authenticated;
select pg_temp.ok(pg_temp.cnt('select 1 from public.service_reports') >= 1, 'Reports View: reads every report');
update public.service_reports set remarks = 'tampered' where sr_no = 'SR-20260818-001';
reset role;
select pg_temp.ok((select coalesce(remarks,'') from public.service_reports where sr_no = 'SR-20260818-001') <> 'tampered', 'Reports View: cannot change a report');
select pg_temp.as_user(:D::uuid); set local role authenticated;
update public.service_reports set remarks = 'Corrected by office' where sr_no = 'SR-20260818-001';
reset role;
select pg_temp.ok((select remarks from public.service_reports where sr_no = 'SR-20260818-001') = 'Corrected by office', 'Reports Edit: corrects a report');
select pg_temp.as_user(:D::uuid); set local role authenticated;
delete from public.service_reports where sr_no = 'SR-20260818-001';
reset role;
select pg_temp.ok(exists (select 1 from public.service_reports where sr_no = 'SR-20260818-001'), 'deleting reports stays Super Admin only');

select pg_temp.as_user(:D::uuid); set local role authenticated;
select pg_temp.ok(public.admin_record_past_service(jsonb_build_object(
    'technician_id', '00000000-0000-0000-0000-0000000000b1', 'date', current_date - 3,
    'cust_name', 'Acme Foods', 'customer_id', '17c5334e-5b59-473b-a31f-72a47cf22d81',
    'services_done', '["Cleaning"]'::jsonb)) like 'SR-%', 'Past Service Edit: records work already done');
reset role;
select pg_temp.as_user(:O::uuid); set local role authenticated;
select pg_temp.fails($q$select public.admin_record_past_service('{"technician_id":"00000000-0000-0000-0000-0000000000b1","date":"2026-09-01","cust_name":"Acme Foods"}')$q$,
       'Edit access for Record Past Service', 'no Past Service access: refused');
reset role;

\echo
\echo 'All operations staff probes passed — rolling back.'
rollback;

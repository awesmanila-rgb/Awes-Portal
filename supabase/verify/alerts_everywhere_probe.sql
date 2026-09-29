-- Probe for 20261011_01_alerts_everywhere.sql — new Inbox items reach the
-- right accounts, and each new item is pushed once to whoever it's waiting
-- on. One transaction, rolled back.   psql -d awes_backup -f alerts_everywhere_probe.sql
\set ON_ERROR_STOP 1
begin;
create function pg_temp.ok(c boolean, n text) returns void language plpgsql as $$ begin if c then raise notice 'PASS  %', n; else raise exception 'FAIL  %', n; end if; end $$;
create function pg_temp.as_user(p uuid) returns void language plpgsql as $$ begin
  perform set_config('request.jwt.claim.sub', coalesce(p::text, ''), true);
  perform set_config('request.jwt.claim.role', case when p is null then 'service_role' else 'authenticated' end, true); end $$;
create function pg_temp.inbox(p uuid, k text, ref text) returns bigint language plpgsql as $$ declare n bigint; begin
  perform pg_temp.as_user(p); select count(*) into n from jsonb_array_elements(public.inbox_items()) x where x->>'kind' = k and x->>'ref_id' = ref; return n; end $$;
create function pg_temp.pushed_to(k text, ref text, u uuid) returns boolean language sql as $$
  select exists (select 1 from public.inbox_escalations_due() d where d.kind = k and d.ref_id = ref and d.level = 0 and u = any(d.recipients)) $$;

\set A '''00000000-0000-0000-0000-0000000000a1'''
\set D '''50000000-0000-0000-0000-00000000000a'''
\set F '''50000000-0000-0000-0000-00000000000b'''
\set K '''50000000-0000-0000-0000-00000000000c'''
insert into auth.users (id, email) values (:D, 'd@x'), (:F, 'f@x'), (:K, 'k@x');
insert into public.profiles (id, name, role, username) values (:D, 'Dina Dispatch', 'staff', 'al_d'), (:F, 'Fe Finance', 'staff', 'al_f'), (:K, 'Ken Tools', 'staff', 'al_k');
select pg_temp.as_user(null);
select public.staff_apply_access(:D::uuid, '[{"id":"operations"}]', '[{"module":"ops.dispatch","level":"edit"},{"module":"ops.service_requests","level":"edit"}]', :A::uuid);
select public.staff_apply_access(:F::uuid, '[{"id":"finance"}]', '[{"module":"fin.payroll_approve","level":"approve","approve_limit":1000000}]', :A::uuid);
select public.staff_apply_access(:K::uuid, '[{"id":"operations"}]', '[{"module":"tools.return","level":"edit"}]', :A::uuid);

set local session_replication_role = replica;
insert into public.dispatch_tickets (id, status, data) values
  ('al-jo-late', 'in_progress', jsonb_build_object('jobOrderNo', 'JO-AL1', 'custName', 'Acme Foods', 'date', (public.manila_today() - 2)::text,
                                                   'assignedWorkerIds', jsonb_build_array('00000000-0000-0000-0000-0000000000b1'))),
  ('al-jo-none', 'open', jsonb_build_object('jobOrderNo', 'JO-AL2', 'custName', 'Bayview Mall', 'date', (public.manila_today() + 1)::text, 'assignedWorkerIds', '[]'::jsonb));
insert into public.service_requests (id, customer_id, description, status, cancel_requested, cancel_requested_at, cancel_requested_reason) values
  ('50000000-0000-0000-0000-0000000000e1', (select id from public.customers where name = 'Acme Foods'), 'Aircon leaking', 'preparing', true, now(), 'Fixed by building maintenance');
insert into public.service_requests (id, customer_id, description, status) values
  ('50000000-0000-0000-0000-0000000000e2', (select id from public.customers where name = 'Acme Foods'), 'PM visit', 'fee_accepted');
insert into public.payroll_periods (id, pay_frequency, period_start, period_end, pay_date, label, status) values
  ('50000000-0000-0000-0000-0000000000f1', 'SEMI_MONTHLY', '2026-08-01', '2026-08-15', '2026-08-20', 'Aug 01 – Aug 15, 2026', 'locked');
insert into public.payroll_runs (id, period_id, status, headcount, total_net, submitted_at) values
  ('50000000-0000-0000-0000-0000000000f2', '50000000-0000-0000-0000-0000000000f1', 'submitted', 3, 42000, now());
insert into public.warehouses (id, code, name) values ('50000000-0000-0000-0000-0000000000b9', 'PRB-WH', 'Probe Warehouse') on conflict do nothing;
insert into public.tools (id, name, home_warehouse_id, status, holder_name, due_back) values
  ('50000000-0000-0000-0000-0000000000a9', 'Probe vacuum pump', '50000000-0000-0000-0000-0000000000b9', 'issued', 'Bryan', public.manila_today() - 3);
set local session_replication_role = origin;

select pg_temp.ok(pg_temp.inbox(:D, 'jo_overdue', 'al-jo-late') = 1, 'an overdue job order is in the dispatcher''s Inbox');
select pg_temp.ok(pg_temp.inbox(:D, 'jo_unassigned', 'al-jo-none') = 1, 'a job order with nobody assigned is too');
select pg_temp.ok(pg_temp.inbox(:D, 'sr_cancel', '50000000-0000-0000-0000-0000000000e1') = 1, 'a customer''s cancel request is too');
select pg_temp.ok(pg_temp.inbox(:D, 'sr_next', '50000000-0000-0000-0000-0000000000e2') = 1, 'a service request waiting on the office is too');
select pg_temp.ok(pg_temp.inbox(:F, 'pay_approve', '50000000-0000-0000-0000-0000000000f2') = 1, 'a submitted pay run is in Finance''s Inbox');
select pg_temp.ok(pg_temp.inbox(:D, 'pay_approve', '50000000-0000-0000-0000-0000000000f2') = 0, '… not the dispatcher''s');
select pg_temp.ok(pg_temp.inbox(:K, 'tool_overdue', '50000000-0000-0000-0000-0000000000a9') = 1, 'an overdue tool is in the tool keeper''s Inbox');

select pg_temp.as_user(null);
select pg_temp.ok(pg_temp.pushed_to('jo_overdue', 'al-jo-late', :D::uuid), 'the new overdue job order is pushed to the dispatcher');
select pg_temp.ok(not pg_temp.pushed_to('jo_overdue', 'al-jo-late', :F::uuid), '… not to Finance');
select pg_temp.ok(pg_temp.pushed_to('pay_approve', '50000000-0000-0000-0000-0000000000f2', :F::uuid), 'the pay run is pushed to Finance');
select pg_temp.ok(pg_temp.pushed_to('tool_overdue', '50000000-0000-0000-0000-0000000000a9', :K::uuid), 'the overdue tool is pushed to the tool keeper');
select public.inbox_mark_sent((select jsonb_agg(to_jsonb(d)) from public.inbox_escalations_due() d where d.level = 0));
select pg_temp.ok(not exists (select 1 from public.inbox_escalations_due() d where d.level = 0 and d.ref_id in ('al-jo-late', '50000000-0000-0000-0000-0000000000f2')),
  'each new item is pushed only once');
rollback;

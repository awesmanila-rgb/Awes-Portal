-- =====================================================================
-- Probe suite for 20260928_01_round3_inbox_escalation.sql
-- One transaction, rolled back. Prints PASS per check.
--   psql -d awes_backup -f round3_probe.sql
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
create function pg_temp.has(p_kind text, p_ref text) returns boolean language sql as $$
  select exists (select 1 from jsonb_array_elements(public.inbox_items()) x where x->>'kind' = p_kind and x->>'ref_id' = p_ref) $$;
create function pg_temp.st(p_kind text, p_ref text) returns text language sql as $$
  select x->>'state' from jsonb_array_elements(public.inbox_items()) x where x->>'kind' = p_kind and x->>'ref_id' = p_ref $$;

insert into auth.users (id, email) values
  ('e0000000-0000-0000-0000-00000000000a','ea@staff.awes-app.local'),
  ('e0000000-0000-0000-0000-00000000000b','eb@staff.awes-app.local'),
  ('e0000000-0000-0000-0000-00000000000c','ec@staff.awes-app.local'),
  ('e0000000-0000-0000-0000-00000000000d','ed@staff.awes-app.local');
insert into public.profiles (id, name, role, username) values
  ('e0000000-0000-0000-0000-00000000000a','Fina Head','staff','x_finhead'),
  ('e0000000-0000-0000-0000-00000000000c','Paco Purchasing','staff','x_pur'),
  ('e0000000-0000-0000-0000-00000000000d','Ella Edit','staff','x_edit');
\set FH '''e0000000-0000-0000-0000-00000000000a'''
\set FS '''e0000000-0000-0000-0000-00000000000b'''
\set PU '''e0000000-0000-0000-0000-00000000000c'''
\set FE '''e0000000-0000-0000-0000-00000000000d'''
\set A  '''00000000-0000-0000-0000-0000000000a1'''
\set T  '''00000000-0000-0000-0000-0000000000b1'''

select pg_temp.as_user(null);
select public.staff_apply_access(:FH::uuid, '[{"id":"finance","is_head":true}]',
  '[{"module":"fin.cash_advance","level":"approve"},{"module":"fin.liquidation","level":"approve"}]', :A::uuid);
insert into public.profiles (id, name, role, username, supervisor_id) values (:FS::uuid, 'Fred Finance', 'staff', 'x_finsub', :FH::uuid);
select public.staff_apply_access(:FS::uuid, '[{"id":"finance"}]', '[{"module":"fin.cash_advance","level":"approve"}]', :FH::uuid);
select public.staff_apply_access(:FE::uuid, '[{"id":"finance"}]', '[{"module":"fin.cash_advance","level":"edit"}]', :A::uuid);
select public.staff_apply_access(:PU::uuid, '[{"id":"purchasing"}]', '[{"module":"pur.requisitions","level":"approve"}]', :A::uuid);

-- work items: a fresh advance, an old one, a requisition, a late job order
select pg_temp.as_user(:T::uuid); set local role authenticated;
insert into public.cash_advance_requests (id, technician_id, status, submitted_at, data) values
  ('e1000000-0000-0000-0000-000000000001', :T::uuid, 'pending', now() - interval '1 hour',  '{"amount":1500,"technicianName":"Bryan"}'),
  ('e1000000-0000-0000-0000-000000000002', :T::uuid, 'pending', now() - interval '30 hours', '{"amount":4000,"technicianName":"Bryan"}');
insert into public.material_requisitions (id, status, requester_name) values ('e2000000-0000-0000-0000-000000000001', 'draft', 'Bryan');
insert into public.material_requisition_items (mr_id, description, qty_requested) values ('e2000000-0000-0000-0000-000000000001', 'Copper', 2);
update public.material_requisitions set status = 'submitted' where id = 'e2000000-0000-0000-0000-000000000001';
reset role;
select pg_temp.as_user(:A::uuid); set local role authenticated;
insert into public.dispatch_tickets (id, status, data) values ('JO-INBOX-1', 'open', jsonb_build_object('custName', 'Acme Foods', 'date', public.manila_today() - 4));
reset role;

-- ---- who sees what ---------------------------------------------------
select pg_temp.as_user(:FS::uuid);
select pg_temp.ok(pg_temp.has('ca_approve', 'e1000000-0000-0000-0000-000000000001') and pg_temp.has('ca_approve', 'e1000000-0000-0000-0000-000000000002'),
                  'Cash Advance approver sees advances waiting for approval');
select pg_temp.ok(not pg_temp.has('mr_review', 'e2000000-0000-0000-0000-000000000001'), '… but not Purchasing''s requisitions');
select pg_temp.ok(pg_temp.st('ca_approve', 'e1000000-0000-0000-0000-000000000001') = 'waiting', 'a 1-hour-old advance is "waiting" (response time 8 h)');
select pg_temp.ok(pg_temp.st('ca_approve', 'e1000000-0000-0000-0000-000000000002') = 'escalated', 'a 30-hour-old advance is "escalated" (after 24 h)');
select pg_temp.as_user(:FE::uuid);
select pg_temp.ok(not pg_temp.has('ca_approve', 'e1000000-0000-0000-0000-000000000001'), 'Edit-only staff don''t get approval items (they can''t act on them)');
select pg_temp.as_user(:PU::uuid);
select pg_temp.ok(pg_temp.has('mr_review', 'e2000000-0000-0000-0000-000000000001'), 'Purchasing approver sees the submitted requisition');
select pg_temp.as_user(:T::uuid);
select pg_temp.ok(jsonb_array_length(public.inbox_items()) = 0, 'technicians have no inbox');
select pg_temp.as_user(:A::uuid);
select pg_temp.ok(pg_temp.has('jo_late', 'JO-INBOX-1') and pg_temp.st('jo_late', 'JO-INBOX-1') = 'escalated', 'Super Admin sees everything, incl. a job order 4 days late');

-- nobody is asked to approve their own record
select pg_temp.as_user(:PU::uuid); set local role authenticated;
insert into public.material_requisitions (id, status, requester_name) values ('e2000000-0000-0000-0000-000000000002', 'draft', 'Paco Purchasing');
insert into public.material_requisition_items (mr_id, description, qty_requested) values ('e2000000-0000-0000-0000-000000000002', 'Office stock', 1);
update public.material_requisitions set status = 'submitted' where id = 'e2000000-0000-0000-0000-000000000002';
reset role;
select pg_temp.as_user(:PU::uuid);
select pg_temp.ok(not pg_temp.has('mr_review', 'e2000000-0000-0000-0000-000000000002'), 'an approver''s own requisition isn''t in their own "to review" list');
select pg_temp.ok(pg_temp.has('mr_review', 'e2000000-0000-0000-0000-000000000001'), '… while someone else''s still is');
select pg_temp.as_user(:A::uuid);
select pg_temp.ok(pg_temp.has('mr_review', 'e2000000-0000-0000-0000-000000000002'), '… and the Super Admin sees it');

-- the item leaves the inbox once acted on
select pg_temp.as_user(:A::uuid); set local role authenticated;
update public.cash_advance_requests set status = 'approved', data = data || '{"status":"approved"}' where id = 'e1000000-0000-0000-0000-000000000001';
reset role;
select pg_temp.as_user(:FS::uuid);
select pg_temp.ok(not pg_temp.has('ca_approve', 'e1000000-0000-0000-0000-000000000001'), 'approved → gone from "to approve"');
select pg_temp.as_user(:FE::uuid);
select pg_temp.ok(pg_temp.has('ca_release', 'e1000000-0000-0000-0000-000000000001'), '… and now waits on Cash Advance Edit: "cash not given"');

-- ---- response times -----------------------------------------------
select pg_temp.as_user(:FH::uuid);
select pg_temp.fails($q$select public.inbox_sla_save('ca_approve', 1, 2, true)$q$, 'Only the Super Admin', 'staff can''t change response times');
select pg_temp.as_user(:A::uuid);
select pg_temp.fails($q$select public.inbox_sla_save('ca_approve', 10, 5, true)$q$, 'at least the overdue time', 'escalation can''t come before overdue');
select public.inbox_sla_save('ca_approve', 40, 80, true);
select pg_temp.as_user(:FS::uuid);
select pg_temp.ok(pg_temp.st('ca_approve', 'e1000000-0000-0000-0000-000000000002') = 'waiting', 'longer response time → the 30-hour advance is back to "waiting"');
select pg_temp.as_user(:A::uuid);
select public.inbox_sla_save('ca_approve', 8, 24, false);
select pg_temp.as_user(:FS::uuid);
select pg_temp.ok(not pg_temp.has('ca_approve', 'e1000000-0000-0000-0000-000000000002'), 'a switched-off item type leaves every inbox');
select pg_temp.as_user(:A::uuid);
select public.inbox_sla_save('ca_approve', 8, 24, true);

-- ---- escalation ---------------------------------------------------------
select pg_temp.as_user(:FS::uuid); set local role authenticated;
select pg_temp.fails($q$select * from public.inbox_escalations_due()$q$, 'permission denied', 'app users can''t read the escalation queue');
select pg_temp.fails($q$select * from public.inbox_all_items()$q$, 'permission denied', 'app users can''t read the unfiltered item list');
reset role;
select pg_temp.as_user(null); set local role service_role;
select pg_temp.ok((select recipients = array['e0000000-0000-0000-0000-00000000000a']::uuid[] from public.inbox_escalations_due()
                    where key = 'ca_approve:e1000000-0000-0000-0000-000000000002:L1'),
                  'level 1 goes to the Finance Head');
select pg_temp.ok(not exists (select 1 from public.inbox_escalations_due() where key = 'ca_approve:e1000000-0000-0000-0000-000000000002:L2'),
                  'no level 2 yet (30 h < 48 h)');
select pg_temp.ok((select recipients = array['00000000-0000-0000-0000-0000000000a1']::uuid[] from public.inbox_escalations_due()
                    where key = 'jo_late:JO-INBOX-1:L1'),
                  'a department with no Head escalates straight to the Super Admin');
select pg_temp.ok(exists (select 1 from public.inbox_escalations_due() where key = 'jo_late:JO-INBOX-1:L2'), 'level 2 at twice the time (3+ days ≥ 2 × 24 h)');
select public.inbox_mark_sent((select jsonb_agg(to_jsonb(d)) from public.inbox_escalations_due() d));
select pg_temp.ok(not exists (select 1 from public.inbox_escalations_due()), 'each notification is sent once (nothing due on the next run)');
reset role;

-- ---- Head sees escalated items on pages they only view ---------------
select pg_temp.as_user(null);
select public.staff_apply_access(:FH::uuid, '[{"id":"finance","is_head":true}]',
  '[{"module":"fin.cash_advance","level":"view"},{"module":"fin.liquidation","level":"approve"}]', :A::uuid);
select pg_temp.as_user(:FH::uuid);
select pg_temp.ok(pg_temp.has('ca_approve', 'e1000000-0000-0000-0000-000000000002'), 'a Head still sees an escalated item in their department (View only)');

\echo
\echo 'All Round 3 probes passed — rolling back.'
rollback;

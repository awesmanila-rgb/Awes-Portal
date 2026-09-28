-- =====================================================================
-- Probe for 20261002_01_inventory_to_administration.sql — sets up a
-- company the old way (Inventory under Purchasing), runs the move, and
-- checks nobody gained or lost access. One transaction, rolled back.
--   psql -d awes_backup -f inventory_to_administration_probe.sql
-- =====================================================================
\set ON_ERROR_STOP 1
begin;
create function pg_temp.ok(p_cond boolean, p_name text) returns void language plpgsql as $$
begin if p_cond then raise notice 'PASS  %', p_name; else raise exception 'FAIL  %', p_name; end if; end $$;
create function pg_temp.dept(p uuid, d text) returns text language sql as $$
  select case when is_head then 'head' else 'member' end from public.staff_departments where user_id = p and department_id = d $$;
select set_config('request.jwt.claim.role', 'service_role', true);

-- the old way: Inventory filed under Purchasing
update public.app_modules set department = 'purchasing', sort = sort - 34 where key like 'inv.%' and department = 'administration';
update public.inbox_sla set department = 'purchasing' where kind = 'po_receive';

insert into auth.users (id, email) values
  ('ad000000-0000-0000-0000-000000000001','ph@s'), ('ad000000-0000-0000-0000-000000000002','ps@s'),
  ('ad000000-0000-0000-0000-000000000003','ot@s'), ('ad000000-0000-0000-0000-000000000004','ah@s'),
  ('ad000000-0000-0000-0000-000000000005','px@s');
insert into public.profiles (id, name, role, username) values
  ('ad000000-0000-0000-0000-000000000001','Purchasing Head','staff','mv_ph'),
  ('ad000000-0000-0000-0000-000000000003','Ops Head (has stock view)','staff','mv_ot'),
  ('ad000000-0000-0000-0000-000000000004','Admin Head','staff','mv_ah');
\set PH '''ad000000-0000-0000-0000-000000000001'''
\set PS '''ad000000-0000-0000-0000-000000000002'''
\set OT '''ad000000-0000-0000-0000-000000000003'''
\set AH '''ad000000-0000-0000-0000-000000000004'''
\set PX '''ad000000-0000-0000-0000-000000000005'''
select public.staff_apply_access(:PH::uuid, '[{"id":"purchasing","is_head":true}]',
  '[{"module":"pur.suppliers","level":"edit"},{"module":"inv.stock","level":"edit"},{"module":"inv.receive","level":"edit"}]', null);
insert into public.profiles (id, name, role, username, supervisor_id) values
  (:PS::uuid, 'Stock Clerk (sub)', 'staff', 'mv_ps', :PH::uuid),
  (:PX::uuid, 'Supplier Clerk (sub, no stock)', 'staff', 'mv_px', :PH::uuid);
select public.staff_apply_access(:PS::uuid, '[{"id":"purchasing"}]', '[{"module":"inv.receive","level":"view"}]', null);
select public.staff_apply_access(:PX::uuid, '[{"id":"purchasing"}]', '[{"module":"pur.suppliers","level":"view"}]', null);
select public.staff_apply_access(:OT::uuid, '[{"id":"operations","is_head":true},{"id":"purchasing"}]',
  '[{"module":"ops.dispatch","level":"view"},{"module":"inv.issue","level":"view"}]', null);
select public.staff_apply_access(:AH::uuid, '[{"id":"administration","is_head":true}]', '[{"module":"adm.customers","level":"edit"}]', null);
insert into public.access_templates (id, name, departments, access) values
  ('ae000000-0000-0000-0000-000000000001', 'Stock Keeper (old)', '["purchasing"]', '[{"module":"inv.stock","level":"view"},{"module":"inv.receive","level":"edit"}]');

create temp table before_access as select user_id, module_key, level, approve_limit, expires_at from public.staff_access;

-- ---- the move ---------------------------------------------------------------
select public.inventory_move_to_administration();

select pg_temp.ok((select bool_and(department = 'administration') from public.app_modules where key like 'inv.%'), 'all 8 Inventory pages are in Administration');
select pg_temp.ok((select section from public.app_modules where key = 'inv.stock') = 'Inventory'
                  and (select min(sort) from public.app_modules where key like 'inv.%') > (select max(sort) from public.app_modules where key like 'adm.%'),
                  '… grouped as "Inventory", after Administration''s own pages');
select pg_temp.ok(not exists (select * from before_access except select user_id, module_key, level, approve_limit, expires_at from public.staff_access)
                  and not exists (select user_id, module_key, level, approve_limit, expires_at from public.staff_access except select * from before_access),
                  'nobody gained or lost a page (levels, limits and end dates unchanged)');
select pg_temp.ok(pg_temp.dept(:PH::uuid, 'administration') = 'head' and pg_temp.dept(:PH::uuid, 'purchasing') = 'head',
                  'the Purchasing Head now also heads Administration (keeps managing their stock team)');
select pg_temp.ok(pg_temp.dept(:PS::uuid, 'administration') = 'member' and pg_temp.dept(:PS::uuid, 'purchasing') = 'member',
                  'their stock sub-user is in Administration under them');
select pg_temp.ok(pg_temp.dept(:PX::uuid, 'administration') is null, 'a sub-user without Inventory isn''t added');
select pg_temp.ok(pg_temp.dept(:OT::uuid, 'administration') = 'member' and pg_temp.dept(:OT::uuid, 'operations') = 'head',
                  'someone who only views stock joins as a member, not a Head');
select pg_temp.ok(pg_temp.dept(:AH::uuid, 'administration') = 'head', 'the existing Administration Head is unchanged');
select pg_temp.ok((select departments ? 'administration' from public.access_templates where id = 'ae000000-0000-0000-0000-000000000001'),
                  'a role template with Inventory pages gains Administration');
select pg_temp.ok((select department from public.inbox_sla where kind = 'po_receive') = 'administration', 'Inbox: "PO not yet received" is an Administration item');

-- the Head can still manage the sub-user's Inventory access under the new department
select public.staff_apply_access(:PS::uuid, '[{"id":"purchasing"},{"id":"administration"}]',
  '[{"module":"inv.receive","level":"edit"},{"module":"inv.stock","level":"view"}]', :PH::uuid);
select pg_temp.ok((select level from public.staff_access where user_id = :PS::uuid and module_key = 'inv.receive') = 2,
                  'the Head gives their sub-user more Inventory access under Administration');

-- running it again changes nothing
create temp table before2 as select user_id, department_id, is_head from public.staff_departments;
select public.inventory_move_to_administration();
select pg_temp.ok(not exists (select * from before2 except select user_id, department_id, is_head from public.staff_departments)
                  and not exists (select user_id, department_id, is_head from public.staff_departments except select * from before2),
                  'running the move again changes nothing');

\echo
\echo 'All inventory → administration probes passed — rolling back.'
rollback;

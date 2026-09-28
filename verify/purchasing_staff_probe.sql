-- =====================================================================
-- Probe suite for 20260926_02_purchasing_staff_access.sql
-- One transaction, rolled back at the end. Prints PASS per check.
--   psql -d awes_backup -f purchasing_staff_probe.sql
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
-- as a user, with RLS on
create function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p::text, ''), true);
  perform set_config('request.jwt.claim.role', case when p is null then 'service_role' else 'authenticated' end, true);
end $$;
create function pg_temp.cnt(p_sql text) returns bigint language plpgsql as $$
declare n bigint; begin execute 'select count(*) from (' || p_sql || ') x' into n; return n; end $$;

-- ---- people -------------------------------------------------------
insert into auth.users (id, email) values
  ('20000000-0000-0000-0000-00000000000a','h@staff.awes-app.local'),
  ('20000000-0000-0000-0000-00000000000b','s@staff.awes-app.local'),
  ('20000000-0000-0000-0000-00000000000c','v@staff.awes-app.local'),
  ('20000000-0000-0000-0000-00000000000d','f@staff.awes-app.local');
insert into public.profiles (id, name, role, username) values
  ('20000000-0000-0000-0000-00000000000a','Head Pur','staff','p_head'),
  ('20000000-0000-0000-0000-00000000000c','Viewer','staff','p_view'),
  ('20000000-0000-0000-0000-00000000000d','Finance Only','staff','p_fin');
\set H  '''20000000-0000-0000-0000-00000000000a'''
\set S  '''20000000-0000-0000-0000-00000000000b'''
\set V  '''20000000-0000-0000-0000-00000000000c'''
\set F  '''20000000-0000-0000-0000-00000000000d'''
\set A  '''00000000-0000-0000-0000-0000000000a1'''
\set T  '''00000000-0000-0000-0000-0000000000b1'''

select pg_temp.as_user(null);
select public.staff_apply_access(:H::uuid, '[{"id":"purchasing","is_head":true}]',
  '[{"module":"pur.suppliers","level":"edit"},{"module":"pur.materials","level":"edit"},
    {"module":"pur.requisitions","level":"approve"},{"module":"pur.purchase_orders","level":"approve","approve_limit":100000}]', :A::uuid);
insert into public.profiles (id, name, role, username, supervisor_id) values (:S::uuid,'Sub Pur','staff','p_sub',:H::uuid);
select public.staff_apply_access(:S::uuid, '[{"id":"purchasing"}]',
  '[{"module":"pur.suppliers","level":"edit"},{"module":"pur.materials","level":"view"},
    {"module":"pur.requisitions","level":"edit"},{"module":"pur.purchase_orders","level":"approve","approve_limit":5000}]', :H::uuid);
select public.staff_apply_access(:V::uuid, '[{"id":"purchasing"}]',
  '[{"module":"pur.suppliers","level":"view"},{"module":"pur.purchase_orders","level":"view"}]', :A::uuid);
select public.staff_apply_access(:F::uuid, '[{"id":"finance"}]', '[{"module":"fin.cash_advance","level":"view"}]', :A::uuid);

-- ---- Suppliers ----------------------------------------------------
select pg_temp.as_user(:S::uuid); set local role authenticated;
insert into public.suppliers (id, name) values ('30000000-0000-0000-0000-000000000001', 'Probe Supply Co');
select pg_temp.ok(true, 'Edit: staff adds a supplier');
update public.suppliers set city = 'Makati' where id = '30000000-0000-0000-0000-000000000001';
select pg_temp.ok((select city from public.suppliers where id = '30000000-0000-0000-0000-000000000001') = 'Makati', 'Edit: staff updates a supplier');
reset role;

select pg_temp.as_user(:V::uuid); set local role authenticated;
select pg_temp.ok(pg_temp.cnt('select 1 from public.suppliers where id = ''30000000-0000-0000-0000-000000000001''') = 1, 'View: staff reads suppliers');
select pg_temp.fails($q$insert into public.suppliers (name) values ('Nope')$q$, 'row-level security', 'View: staff cannot add a supplier');
update public.suppliers set city = 'Hacked' where id = '30000000-0000-0000-0000-000000000001';
reset role;
select pg_temp.ok((select city from public.suppliers where id = '30000000-0000-0000-0000-000000000001') = 'Makati', 'View: an update changes nothing');

select pg_temp.as_user(:F::uuid); set local role authenticated;
select pg_temp.ok(pg_temp.cnt('select 1 from public.suppliers') = 0, 'Finance-only staff see no suppliers');
select pg_temp.ok(pg_temp.cnt('select 1 from public.purchase_orders') = 0, 'Finance-only staff see no POs');
reset role;

select pg_temp.as_user(:T::uuid); set local role authenticated;
select pg_temp.ok(pg_temp.cnt('select 1 from public.suppliers') = 0, 'technician still sees no suppliers');
reset role;

-- ---- Materials ----------------------------------------------------
select pg_temp.as_user(:H::uuid); set local role authenticated;
insert into public.materials (id, code, name, category, unit, is_active)
values ('30000000-0000-0000-0000-0000000000a1', 'PRB-0001', 'Probe copper pipe', 'Piping', 'm', true);
select pg_temp.ok(true, 'Edit: Head adds a material');
reset role;
select pg_temp.as_user(:S::uuid); set local role authenticated;
select pg_temp.fails($q$insert into public.materials (code, name, category, unit) values ('PRB-0002','x','Piping','pc')$q$, 'row-level security', 'View-only materials: cannot add');
reset role;

-- ---- Signatories + PO ---------------------------------------------
select pg_temp.as_user(:A::uuid); set local role authenticated;
insert into public.po_signatories (id, name, position, user_id) values
  ('30000000-0000-0000-0000-0000000000c1', 'Head Pur', 'Purchasing Manager', :H::uuid),
  ('30000000-0000-0000-0000-0000000000c2', 'Sub Pur', 'Purchasing Officer', :S::uuid),
  ('30000000-0000-0000-0000-0000000000c3', 'Owner', 'General Manager', null);
reset role;
select pg_temp.as_user(:H::uuid); set local role authenticated;
select pg_temp.fails($q$insert into public.po_signatories (name) values ('Sneaky')$q$, 'row-level security', 'staff cannot add signatories');
reset role;

-- Sub drafts a PO (auto preparer = own signatory, created_by = self)
select pg_temp.as_user(:S::uuid); set local role authenticated;
insert into public.purchase_orders (id, supplier_id) values ('30000000-0000-0000-0000-0000000000d1', '30000000-0000-0000-0000-000000000001');
insert into public.purchase_order_items (po_id, description, qty, unit_price, material_id, code)
values ('30000000-0000-0000-0000-0000000000d1', 'Probe copper pipe', 10, 300, '30000000-0000-0000-0000-0000000000a1', 'PRB-0001');
reset role;
select pg_temp.ok((select created_by = :S::uuid and prepared_by_id = '30000000-0000-0000-0000-0000000000c2'
                     from public.purchase_orders where id = '30000000-0000-0000-0000-0000000000d1'),
                  'draft records who drafted it and pre-fills their signatory as preparer');

-- Sub tries to issue own PO
select pg_temp.as_user(null); select public.staff_record_reauth(:S::uuid);
select pg_temp.as_user(:S::uuid); set local role authenticated;
select pg_temp.fails($q$update public.purchase_orders set status = 'issued', approved_by_id = '30000000-0000-0000-0000-0000000000c3' where id = '30000000-0000-0000-0000-0000000000d1'$q$,
       'your own', 'cannot issue a PO you drafted');
reset role;

-- Head issues without password re-entry
select pg_temp.as_user(:H::uuid); set local role authenticated;
select pg_temp.fails($q$update public.purchase_orders set status = 'issued', approved_by_id = '30000000-0000-0000-0000-0000000000c3' where id = '30000000-0000-0000-0000-0000000000d1'$q$,
       'Enter your password', 'issuing asks for password re-entry');
reset role;
select pg_temp.as_user(null); select public.staff_record_reauth(:H::uuid);
select pg_temp.as_user(:H::uuid); set local role authenticated;
update public.purchase_orders set status = 'issued', approved_by_id = '30000000-0000-0000-0000-0000000000c3' where id = '30000000-0000-0000-0000-0000000000d1';
reset role;
select pg_temp.ok((select status = 'issued' and approved_by_id = '30000000-0000-0000-0000-0000000000c1'
                          and approved_snapshot->>'name' = 'Head Pur'
                     from public.purchase_orders where id = '30000000-0000-0000-0000-0000000000d1'),
                  'Head issues it — and the PO prints the Head as approver, not the one picked');

-- Over-limit: Head drafts a big PO, Sub (limit 5,000) tries to issue
select pg_temp.as_user(:H::uuid); set local role authenticated;
insert into public.purchase_orders (id, supplier_id) values ('30000000-0000-0000-0000-0000000000d2', '30000000-0000-0000-0000-000000000001');
insert into public.purchase_order_items (po_id, description, qty, unit_price, material_id, code)
values ('30000000-0000-0000-0000-0000000000d2', 'Probe copper pipe', 100, 300, '30000000-0000-0000-0000-0000000000a1', 'PRB-0001');
reset role;
select pg_temp.as_user(:S::uuid); set local role authenticated;
select pg_temp.fails($q$update public.purchase_orders set status = 'issued' where id = '30000000-0000-0000-0000-0000000000d2'$q$,
       'above your approval limit', 'sub-user cannot issue above their peso limit');
reset role;

-- View-only cannot issue or cancel
select pg_temp.as_user(:V::uuid); set local role authenticated;
select pg_temp.ok(pg_temp.cnt('select 1 from public.purchase_orders') >= 2, 'View: staff read POs');
update public.purchase_orders set status = 'cancelled', cancel_reason = 'x' where id = '30000000-0000-0000-0000-0000000000d1';
reset role;
select pg_temp.ok((select status from public.purchase_orders where id = '30000000-0000-0000-0000-0000000000d1') = 'issued', 'View: cannot cancel a PO');

-- Staff not linked to a signatory can't issue: unlink the Head
update public.po_signatories set user_id = null where id = '30000000-0000-0000-0000-0000000000c1';
select pg_temp.as_user(null); select public.staff_record_reauth(:H::uuid);
insert into public.purchase_orders (id, supplier_id, created_by) values ('30000000-0000-0000-0000-0000000000d3', '30000000-0000-0000-0000-000000000001', :S::uuid);
insert into public.purchase_order_items (po_id, description, qty, unit_price, material_id, code)
values ('30000000-0000-0000-0000-0000000000d3', 'Probe copper pipe', 1, 300, '30000000-0000-0000-0000-0000000000a1', 'PRB-0001');
update public.purchase_orders set created_by = :S::uuid where id = '30000000-0000-0000-0000-0000000000d3';
select pg_temp.as_user(:H::uuid); set local role authenticated;
select pg_temp.fails($q$update public.purchase_orders set status = 'issued', approved_by_id = '30000000-0000-0000-0000-0000000000c3' where id = '30000000-0000-0000-0000-0000000000d3'$q$,
       'linked to a PO signatory', 'unlinked staff cannot issue (no signature to print)');
reset role;
update public.po_signatories set user_id = :H::uuid where id = '30000000-0000-0000-0000-0000000000c1';

-- Cancel an issued PO: Head (Approve) can
select pg_temp.as_user(:H::uuid); set local role authenticated;
update public.purchase_orders set status = 'cancelled', cancel_reason = 'Supplier out of stock' where id = '30000000-0000-0000-0000-0000000000d1';
reset role;
select pg_temp.ok((select status from public.purchase_orders where id = '30000000-0000-0000-0000-0000000000d1') = 'cancelled', 'Approve: Head cancels an issued PO');

-- Super Admin unchanged: picks any approver, no re-entry
select pg_temp.as_user(:A::uuid); set local role authenticated;
update public.purchase_orders set status = 'issued', approved_by_id = '30000000-0000-0000-0000-0000000000c3' where id = '30000000-0000-0000-0000-0000000000d2';
reset role;
select pg_temp.ok((select approved_snapshot->>'name' from public.purchase_orders where id = '30000000-0000-0000-0000-0000000000d2') = 'Owner',
                  'Super Admin issues as before, with the approver they chose');

-- ---- Requisitions -------------------------------------------------
-- Technician files one for their own job order (unchanged behaviour)
select pg_temp.as_user(:T::uuid); set local role authenticated;
insert into public.material_requisitions (id, status, job_order_id) values ('30000000-0000-0000-0000-0000000000e1', 'draft', 'JO-20260818-001');
insert into public.material_requisition_items (mr_id, description, qty_requested) values ('30000000-0000-0000-0000-0000000000e1', 'Copper pipe', 5);
update public.material_requisitions set status = 'submitted' where id = '30000000-0000-0000-0000-0000000000e1';
select pg_temp.fails($q$update public.material_requisitions set status = 'approved' where id = '30000000-0000-0000-0000-0000000000e1'$q$,
       'can no longer be changed', 'technician still cannot approve');
reset role;

-- Sub (Edit only) can see and adjust, but not decide
select pg_temp.as_user(:S::uuid); set local role authenticated;
select pg_temp.ok(pg_temp.cnt('select 1 from public.material_requisitions where id = ''30000000-0000-0000-0000-0000000000e1''') = 1, 'Edit: staff see technicians'' requests');
update public.material_requisition_items set qty_approved = 3 where mr_id = '30000000-0000-0000-0000-0000000000e1';
select pg_temp.ok((select qty_approved from public.material_requisition_items where mr_id = '30000000-0000-0000-0000-0000000000e1') = 3, 'Edit: staff adjust approved quantity');
select pg_temp.fails($q$update public.material_requisitions set status = 'approved' where id = '30000000-0000-0000-0000-0000000000e1'$q$,
       'don''t have Approve access', 'Edit-only staff cannot approve a request');
reset role;

-- Head approves (password re-entered above)
select pg_temp.as_user(:H::uuid); set local role authenticated;
update public.material_requisitions set status = 'approved' where id = '30000000-0000-0000-0000-0000000000e1';
reset role;
select pg_temp.ok((select status = 'approved' and reviewer_name = 'Head Pur' from public.material_requisitions where id = '30000000-0000-0000-0000-0000000000e1'),
                  'Approve: Head approves — reviewer name is the Head');

-- A staff member's own request can't be approved by themselves
select pg_temp.as_user(:H::uuid); set local role authenticated;
insert into public.material_requisitions (id, status) values ('30000000-0000-0000-0000-0000000000e2', 'draft');
insert into public.material_requisition_items (mr_id, description, qty_requested) values ('30000000-0000-0000-0000-0000000000e2', 'Office stock', 1);
update public.material_requisitions set status = 'submitted' where id = '30000000-0000-0000-0000-0000000000e2';
select pg_temp.fails($q$update public.material_requisitions set status = 'approved' where id = '30000000-0000-0000-0000-0000000000e2'$q$,
       'your own', 'cannot approve your own request');
reset role;

-- Viewer sees no requisitions (no pur.requisitions access)
select pg_temp.as_user(:V::uuid); set local role authenticated;
select pg_temp.ok(pg_temp.cnt('select 1 from public.material_requisitions') = 0, 'no requisition access → none visible');
reset role;

-- ---- Storage ------------------------------------------------------
select pg_temp.as_user(:V::uuid); set local role authenticated;
select pg_temp.ok(exists (select 1 from pg_policies where policyname = 'purch_assets_staff_select'), 'signature images readable by PO staff (policy present)');
reset role;

\echo
\echo 'All purchasing staff probes passed — rolling back.'
rollback;

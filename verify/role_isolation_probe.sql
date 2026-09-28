-- =====================================================================
-- Role isolation probe — what each kind of account can READ
-- (20260930_01_restricted_reads.sql and everything before it)
--
-- Builds realistic data owned by different people, then reads it as:
-- signed out, technician, storekeeper, customer, staff with one page,
-- finance staff, a Head, a deactivated staff member. One transaction,
-- rolled back.     psql -d awes_backup -f role_isolation_probe.sql
-- =====================================================================
\set ON_ERROR_STOP 1
begin;
create function pg_temp.ok(p_cond boolean, p_name text) returns void language plpgsql as $$
begin if p_cond then raise notice 'PASS  %', p_name; else raise exception 'FAIL  %', p_name; end if; end $$;
-- rows of a table visible to a person (null = signed out)
create function pg_temp.seen(p_user uuid, p_table text) returns bigint language plpgsql as $$
declare n bigint;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claim.role', case when p_user is null then 'anon' else 'authenticated' end, true);
  execute case when p_user is null then 'set local role anon' else 'set local role authenticated' end;
  begin execute format('select count(*) from public.%I', p_table) into n;
  exception when insufficient_privilege then n := 0; end;
  execute 'reset role';
  return n;
end $$;
-- Realistic data owned by different people, for the read-access matrix.
create or replace function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p::text, ''), true);
  perform set_config('request.jwt.claim.role', case when p is null then 'anon' else 'authenticated' end, true);
end $$;

-- people -------------------------------------------------------------------
insert into auth.users (id, email) values
  ('f0000000-0000-0000-0000-00000000000c','cust.acme@portal'),
  ('f0000000-0000-0000-0000-000000000001','head@staff'), ('f0000000-0000-0000-0000-000000000002','supsub@staff'),
  ('f0000000-0000-0000-0000-000000000003','fin@staff'),  ('f0000000-0000-0000-0000-000000000004','gone@staff');
insert into public.profiles (id, name, role, username, active) values
  ('f0000000-0000-0000-0000-00000000000c','Ana (Acme login)','customer',null,true),
  ('f0000000-0000-0000-0000-000000000001','Hera Head','staff','a_head',true),
  ('f0000000-0000-0000-0000-000000000003','Fina Finance','staff','a_fin',true),
  ('f0000000-0000-0000-0000-000000000004','Gone Staff','staff','a_gone',true);
select pg_temp.as_user(null); set local role postgres;
select public.staff_apply_access('f0000000-0000-0000-0000-000000000001', '[{"id":"purchasing","is_head":true}]',
  '[{"module":"pur.purchase_orders","level":"approve"},{"module":"pur.suppliers","level":"edit"},{"module":"pur.materials","level":"view"}]', null);
insert into public.profiles (id, name, role, username, supervisor_id) values ('f0000000-0000-0000-0000-000000000002','Sam Suppliers','staff','a_sup','f0000000-0000-0000-0000-000000000001');
select public.staff_apply_access('f0000000-0000-0000-0000-000000000002', '[{"id":"purchasing"}]', '[{"module":"pur.suppliers","level":"view"}]', null);
select public.staff_apply_access('f0000000-0000-0000-0000-000000000003', '[{"id":"finance"}]', '[{"module":"fin.cash_advance","level":"approve"}]', null);
select public.staff_apply_access('f0000000-0000-0000-0000-000000000004', '[{"id":"finance"}]',
  '[{"module":"fin.cash_advance","level":"approve"},{"module":"hr.leaves","level":"approve"},{"module":"inv.stock","level":"view"}]', null);
select set_config('request.jwt.claim.role', 'service_role', true);   -- the profile guard only lets admin / service role change 'active'
update public.profiles set active = false where id = 'f0000000-0000-0000-0000-000000000004';
select set_config('request.jwt.claim.role', 'anon', true);
insert into public.customer_login_links (profile_id, customer_id) values ('f0000000-0000-0000-0000-00000000000c', '17c5334e-5b59-473b-a31f-72a47cf22d81');

-- as the Super Admin: company data ------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1'); set local role authenticated;
insert into public.warehouses (id, code, name) values ('f1000000-0000-0000-0000-000000000001','AW1','Main'), ('f1000000-0000-0000-0000-000000000002','AW2','Site');
insert into public.warehouse_storekeepers (warehouse_id, user_id) values ('f1000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000b2');
insert into public.materials (id, code, name, category, unit, is_active) values
  ('f2000000-0000-0000-0000-000000000001','AUD-1','Copper pipe','Piping','m',true), ('f2000000-0000-0000-0000-000000000002','AUD-2','Old part','Piping','pc',false);
insert into public.suppliers (id, name) values ('f3000000-0000-0000-0000-000000000001','Audit Supply');
insert into public.supplier_contacts (supplier_id, name) values ('f3000000-0000-0000-0000-000000000001','Mr Sales');
insert into public.supplier_materials (supplier_id, material_id, price) values ('f3000000-0000-0000-0000-000000000001','f2000000-0000-0000-0000-000000000001', 250);
update public.supplier_materials set price = 260 where supplier_id = 'f3000000-0000-0000-0000-000000000001';
insert into public.po_signatories (name, position) values ('Owner','GM');
insert into public.purchase_orders (id, supplier_id) values ('f4000000-0000-0000-0000-000000000001','f3000000-0000-0000-0000-000000000001');
insert into public.purchase_order_items (po_id, description, qty, unit_price, material_id, code) values ('f4000000-0000-0000-0000-000000000001','Copper pipe',10,260,'f2000000-0000-0000-0000-000000000001','AUD-1');
insert into public.stock_movements (doc_type, doc_ref, warehouse_id, material_id, qty, unit_cost) values
  ('opening','Open','f1000000-0000-0000-0000-000000000001','f2000000-0000-0000-0000-000000000001',50,240),
  ('opening','Open','f1000000-0000-0000-0000-000000000002','f2000000-0000-0000-0000-000000000001',30,240);
select public.inv_post_receipt(jsonb_build_object('warehouse_id','f1000000-0000-0000-0000-000000000002','lines',
  jsonb_build_array(jsonb_build_object('material_id','f2000000-0000-0000-0000-000000000001','qty',5))));
select public.inv_post_issue(jsonb_build_object('warehouse_id','f1000000-0000-0000-0000-000000000002','worker_id','00000000-0000-0000-0000-0000000000b3',
  'lines', jsonb_build_array(jsonb_build_object('material_id','f2000000-0000-0000-0000-000000000001','qty',2))));
insert into public.tools (id, asset_tag, kind, name, home_warehouse_id, status, condition, purchase_cost) values
  ('f5000000-0000-0000-0000-000000000001','AUD-T1','tool','Vacuum pump','f1000000-0000-0000-0000-000000000002','available','good',18000);
insert into public.projects (id, name, status) values ('f6000000-0000-0000-0000-000000000001','Audit Project','active');
insert into public.announcements (id, title) values (-9001, 'Audit notice');
insert into public.customer_equipment (id, customer_id, equip_type, equip_location) values
  ('f7000000-0000-0000-0000-000000000001','03d15d60-85f8-476a-b30d-5a323cce8e64','Split','Bayview lobby');
insert into public.equipment_photos (equipment_id, customer_id, storage_path) values ('f7000000-0000-0000-0000-000000000001','03d15d60-85f8-476a-b30d-5a323cce8e64','bayview/p.jpg');
insert into public.technician_violations (technician_id, occurred_on, description) values ('00000000-0000-0000-0000-0000000000b3', current_date, 'Late');
insert into public.technician_documents (technician_id, title, file_data) values ('00000000-0000-0000-0000-0000000000b3', 'Memo', 'data:x');
insert into public.service_requests (id, customer_id, description, status, origin) values
  ('f8000000-0000-0000-0000-000000000001','03d15d60-85f8-476a-b30d-5a323cce8e64','Bayview leak','new','admin_dispatch'),
  ('f8000000-0000-0000-0000-000000000002','17c5334e-5b59-473b-a31f-72a47cf22d81','Acme not cooling','new','admin_dispatch');
insert into public.service_request_messages (request_id, sender_id, sender_name, sender_role, body) values
  ('f8000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','AWES','admin','Bayview: we will visit');
reset role;

-- as technicians: their own records --------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b3'); set local role authenticated;
insert into public.cash_advance_requests (id, technician_id, status, submitted_at, data) values
  ('f9000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000b3','pending',now(),'{"amount":5000,"technicianName":"Elmer"}');
insert into public.leave_requests (id, technician_id, status, submitted_at, data) values
  ('f9000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-0000000000b3','pending',now(),'{"leaveType":"Sick","dateFrom":"2026-10-01"}');
insert into public.material_requisitions (id, status, requester_name) values ('f9000000-0000-0000-0000-000000000003','draft','Elmer');
insert into public.technician_locations (technician_id, lat, lng, updated_at) values ('00000000-0000-0000-0000-0000000000b3', 14.5, 121.0, now())
  on conflict (technician_id) do nothing;
insert into public.user_guide_progress (user_id, data) values ('00000000-0000-0000-0000-0000000000b3','{"lang":"tl"}');
reset role;
select pg_temp.as_user(null); set local role postgres;
insert into public.push_subscriptions (user_id, role, endpoint, p256dh, auth) values ('00000000-0000-0000-0000-0000000000b3','tech','https://push/elmer','k','a');

\set TECH     '''00000000-0000-0000-0000-0000000000b1'''
\set KEEPER   '''00000000-0000-0000-0000-0000000000b2'''
\set CUST     '''f0000000-0000-0000-0000-00000000000c'''
\set ONEPAGE  '''f0000000-0000-0000-0000-000000000002'''
\set FIN      '''f0000000-0000-0000-0000-000000000003'''
\set HEAD     '''f0000000-0000-0000-0000-000000000001'''
\set GONE     '''f0000000-0000-0000-0000-000000000004'''

-- ---- signed out: nothing -----------------------------------------------
select pg_temp.ok((select bool_and(pg_temp.seen(null, t) = 0) from unnest(array['customers','customer_equipment','announcements','materials',
  'warehouses','suppliers_directory','app_settings','service_reports','dispatch_tickets','cash_advance_requests','leave_requests','dtr_records','profiles']) t),
  'signed out: reads nothing');

-- ---- customer: only their own company ----------------------------------
select pg_temp.ok(pg_temp.seen(:CUST::uuid, 'customers') = 1, 'customer: sees only their own company');
select pg_temp.ok(pg_temp.seen(:CUST::uuid, 'customer_equipment') = (select count(*) from public.customer_equipment where customer_id = '17c5334e-5b59-473b-a31f-72a47cf22d81'),
                  'customer: sees only their own company''s units');
select pg_temp.ok(pg_temp.seen(:CUST::uuid, 'service_requests') = 1, 'customer: sees only their own service requests');
select pg_temp.ok(pg_temp.seen(:CUST::uuid, 'service_request_messages') = 0, 'customer: can''t read another company''s request messages');
select pg_temp.ok((select bool_and(pg_temp.seen(:CUST::uuid, t) = 0) from unnest(array['announcements','materials','material_categories','warehouses',
  'suppliers_directory','app_settings','suppliers','purchase_orders','stock_balances','stock_on_hand_qty','tools','tools_view','projects',
  'cash_advance_requests','leave_requests','dtr_records','technician_locations','technician_violations','dispatch_tickets','activity_log','inbox_sla',
  'staff_access','po_settings']) t), 'customer: no internal company data at all');
select pg_temp.ok(pg_temp.seen(:CUST::uuid, 'profiles') = 1, 'customer: sees no one else''s account');
do $$ begin
  perform set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-00000000000c', true); perform set_config('request.jwt.claim.role', 'authenticated', true);
  set local role authenticated;
  begin
    insert into public.customer_equipment (customer_id, equip_type) values ('03d15d60-85f8-476a-b30d-5a323cce8e64', 'Planted');
    raise exception 'FAIL  customer added a unit to another company';
  exception when insufficient_privilege then raise notice 'PASS  customer: can''t add units to another company';
  end;
  reset role;
end $$;

-- ---- technicians: their own records; customers / units for reports --------
select pg_temp.ok(pg_temp.seen(:TECH::uuid, 'customers') = 3 and pg_temp.seen(:TECH::uuid, 'customer_equipment') >= 2,
                  'technician: still picks any customer and unit on a report');
select pg_temp.ok(pg_temp.seen(:TECH::uuid, 'cash_advance_requests') = (select count(*) from public.cash_advance_requests where technician_id = '00000000-0000-0000-0000-0000000000b1')
                  and pg_temp.seen(:TECH::uuid, 'leave_requests') = (select count(*) from public.leave_requests where technician_id = '00000000-0000-0000-0000-0000000000b1'),
                  'technician: only their own advances and leave');
select pg_temp.ok((select bool_and(pg_temp.seen(:TECH::uuid, t) = 0) from unnest(array['technician_violations','technician_documents','technician_locations',
  'stock_balances','tools','suppliers','purchase_orders','activity_log','staff_access','inbox_sla','po_settings','user_guide_progress']) t),
  'technician: nothing about other people or the office');
select pg_temp.ok(pg_temp.seen(:TECH::uuid, 'profiles') = 1, 'technician: sees no one else''s account');
select pg_temp.ok(pg_temp.seen(:KEEPER::uuid, 'stock_on_hand_qty') = (select count(*) from public.stock_balances where warehouse_id = 'f1000000-0000-0000-0000-000000000001')
                  and pg_temp.seen(:KEEPER::uuid, 'stock_balances') = 0, 'storekeeper: only their warehouse''s quantities, never peso values');

-- ---- staff: only what their pages use -------------------------------------
select pg_temp.ok(pg_temp.seen(:ONEPAGE::uuid, 'suppliers') = 1, 'staff (Suppliers only): sees suppliers');
select pg_temp.ok((select bool_and(pg_temp.seen(:ONEPAGE::uuid, t) = 0) from unnest(array['customers','customer_equipment','purchase_orders','cash_advance_requests',
  'leave_requests','dtr_records','service_reports','dispatch_tickets','stock_balances','tools','technician_violations','activity_log']) t),
  'staff (Suppliers only): nothing from other pages');
select pg_temp.ok(pg_temp.seen(:FIN::uuid, 'cash_advance_requests') >= 1 and pg_temp.seen(:FIN::uuid, 'customers') = 0 and pg_temp.seen(:FIN::uuid, 'suppliers') = 0,
                  'finance staff: advances yes, customers and suppliers no');
select pg_temp.ok(pg_temp.seen(:HEAD::uuid, 'profiles') = 2, 'Head: sees their own and their sub-user''s account, nobody else''s');
select pg_temp.ok(pg_temp.seen(:HEAD::uuid, 'customers') = 0, 'Purchasing Head: no customer data');

-- ---- deactivated staff: nothing -----------------------------------------
select pg_temp.ok((select bool_and(pg_temp.seen(:GONE::uuid, t) = 0) from unnest(array['cash_advance_requests','leave_requests','stock_on_hand_qty','customers',
  'customer_equipment','announcements','materials','warehouses','suppliers_directory','app_settings','dtr_records','inbox_sla']) t),
  'deactivated staff: none of their old pages, nothing internal');

\echo
\echo 'All role isolation probes passed — rolling back.'
rollback;

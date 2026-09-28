-- =====================================================================
-- Probe suite for 20260926_03_inventory_staff_access.sql
-- One transaction, rolled back. Prints PASS per check.
--   psql -d awes_backup -f inventory_staff_probe.sql
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

-- ---- people & places ---------------------------------------------
insert into auth.users (id, email) values
  ('40000000-0000-0000-0000-00000000000a','rcv@staff.awes-app.local'),
  ('40000000-0000-0000-0000-00000000000b','iss@staff.awes-app.local'),
  ('40000000-0000-0000-0000-00000000000c','view@staff.awes-app.local'),
  ('40000000-0000-0000-0000-00000000000d','cost@staff.awes-app.local'),
  ('40000000-0000-0000-0000-00000000000e','rpt@staff.awes-app.local');
insert into public.profiles (id, name, role, username) values
  ('40000000-0000-0000-0000-00000000000a','Rina Receiver','staff','i_rcv'),
  ('40000000-0000-0000-0000-00000000000b','Ivan Issuer','staff','i_iss'),
  ('40000000-0000-0000-0000-00000000000c','Vic Viewer','staff','i_view'),
  ('40000000-0000-0000-0000-00000000000d','Cora Costs','staff','i_cost'),
  ('40000000-0000-0000-0000-00000000000e','Remy Reports','staff','i_rpt');
\set R '''40000000-0000-0000-0000-00000000000a'''
\set I '''40000000-0000-0000-0000-00000000000b'''
\set V '''40000000-0000-0000-0000-00000000000c'''
\set C '''40000000-0000-0000-0000-00000000000d'''
\set P '''40000000-0000-0000-0000-00000000000e'''
\set A '''00000000-0000-0000-0000-0000000000a1'''
\set K '''00000000-0000-0000-0000-0000000000b2'''
\set T '''00000000-0000-0000-0000-0000000000b1'''
\set W1 '''50000000-0000-0000-0000-000000000001'''
\set W2 '''50000000-0000-0000-0000-000000000002'''
\set M  '''50000000-0000-0000-0000-0000000000a1'''

select pg_temp.as_user(null);
select public.staff_apply_access(:R::uuid, '[{"id":"purchasing"}]', '[{"module":"inv.receive","level":"edit"}]', :A::uuid);
select public.staff_apply_access(:I::uuid, '[{"id":"purchasing"}]', '[{"module":"inv.issue","level":"edit"},{"module":"inv.slips","level":"view"}]', :A::uuid);
select public.staff_apply_access(:V::uuid, '[{"id":"purchasing"}]', '[{"module":"inv.stock","level":"view"},{"module":"inv.warehouses","level":"view"}]', :A::uuid);
select public.staff_apply_access(:C::uuid, '[{"id":"purchasing"},{"id":"finance"}]', '[{"module":"inv.stock","level":"edit"},{"module":"fin.costs","level":"view"}]', :A::uuid);
select public.staff_apply_access(:P::uuid, '[{"id":"purchasing"}]', '[{"module":"inv.reports","level":"view"}]', :A::uuid);

select pg_temp.as_user(:A::uuid);
insert into public.warehouses (id, code, name) values (:W1::uuid, 'PRB1', 'Probe Main'), (:W2::uuid, 'PRB2', 'Probe Site');
insert into public.materials (id, code, name, category, unit, is_active) values (:M::uuid, 'PRB-INV-1', 'Probe elbow', 'Piping', 'pc', true);
insert into public.warehouse_storekeepers (warehouse_id, user_id) values (:W1::uuid, :K::uuid);   -- Diony keeps W1 only

-- ---- Stock on Hand: opening balance -------------------------------
select pg_temp.as_user(:C::uuid); set local role authenticated;
insert into public.stock_movements (doc_type, doc_ref, warehouse_id, material_id, qty, unit_cost)
values ('opening', 'Opening', :W1::uuid, :M::uuid, 100, 50);
select pg_temp.ok(true, 'Stock Edit + costs: posts an opening balance');
reset role;
select pg_temp.as_user(:V::uuid); set local role authenticated;
select pg_temp.fails(format($q$insert into public.stock_movements (doc_type, doc_ref, warehouse_id, material_id, qty, unit_cost) values ('opening','x',%L,%L,5,1)$q$,
       '50000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-0000000000a1'), 'row-level security', 'Stock View: cannot post an opening balance');
select pg_temp.ok(pg_temp.cnt('select 1 from public.stock_on_hand_qty where material_id = ''50000000-0000-0000-0000-0000000000a1''') = 1, 'Stock View: sees quantities in every warehouse');
select pg_temp.ok(pg_temp.cnt('select 1 from public.stock_balances') = 0, 'Stock View without "See peso values": no stock values');
reset role;
select pg_temp.as_user(:C::uuid); set local role authenticated;
select pg_temp.ok((select avg_cost from public.stock_balances where material_id = '50000000-0000-0000-0000-0000000000a1' and warehouse_id = '50000000-0000-0000-0000-000000000001') = 50,
                  'With "See peso values": sees average cost');
reset role;

-- ---- Receive -------------------------------------------------------
select pg_temp.as_user(:R::uuid); set local role authenticated;
select public.inv_post_receipt(jsonb_build_object('warehouse_id', '50000000-0000-0000-0000-000000000002',
        'lines', jsonb_build_array(jsonb_build_object('material_id', '50000000-0000-0000-0000-0000000000a1', 'qty', 20, 'unit_cost', 999))));
select pg_temp.ok(true, 'Receive Edit: receives at a warehouse they don''t keep');
select pg_temp.ok(pg_temp.cnt('select 1 from public.stock_receipts where warehouse_id = ''50000000-0000-0000-0000-000000000002''') = 1, 'Receive: sees the receipt');
reset role;
select pg_temp.ok((select unit_cost from public.stock_movements where doc_type = 'receipt' and warehouse_id = '50000000-0000-0000-0000-000000000002') is distinct from 999,
                  'Receive without "See peso values": typed unit cost ignored (valued at average)');
select pg_temp.as_user(:I::uuid); set local role authenticated;
select pg_temp.fails($q$select public.inv_post_receipt(jsonb_build_object('warehouse_id','50000000-0000-0000-0000-000000000002','lines',jsonb_build_array(jsonb_build_object('material_id','50000000-0000-0000-0000-0000000000a1','qty',1))))$q$,
       'Edit access for Receive Stock', 'Issue-only staff cannot receive');
reset role;

-- ---- Issue ---------------------------------------------------------
select pg_temp.as_user(:I::uuid); set local role authenticated;
select pg_temp.ok(pg_temp.cnt('select 1 from public.profiles where role = ''technician''') >= 2, 'Issue: sees the worker list');
select public.inv_post_issue(jsonb_build_object('warehouse_id', '50000000-0000-0000-0000-000000000001', 'worker_id', '00000000-0000-0000-0000-0000000000b1',
        'lines', jsonb_build_array(jsonb_build_object('material_id', '50000000-0000-0000-0000-0000000000a1', 'qty', 5))));
select pg_temp.ok(pg_temp.cnt('select 1 from public.issue_slips where warehouse_id = ''50000000-0000-0000-0000-000000000001''') = 1, 'Issue Edit: issues to a worker');
select pg_temp.ok(pg_temp.cnt('select 1 from public.stock_receipts') >= 1, 'Slips & History View: sees receipts too');
select pg_temp.fails($q$select public.inv_post_transfer(jsonb_build_object('from_warehouse_id','50000000-0000-0000-0000-000000000001','to_warehouse_id','50000000-0000-0000-0000-000000000002','lines',jsonb_build_array(jsonb_build_object('material_id','50000000-0000-0000-0000-0000000000a1','qty',1))))$q$,
       'Edit access for Transfers', 'Issue-only staff cannot transfer');
reset role;

-- ---- Warehouses ----------------------------------------------------
select pg_temp.as_user(:V::uuid); set local role authenticated;
select pg_temp.fails($q$insert into public.warehouses (code, name) values ('NOPE','Nope')$q$, 'row-level security', 'Warehouses View: cannot add a warehouse');
select pg_temp.ok(pg_temp.cnt('select 1 from public.warehouse_storekeepers where warehouse_id = ''50000000-0000-0000-0000-000000000001''') = 1, 'Warehouses View: sees who keeps each warehouse');
select pg_temp.fails($q$insert into public.warehouse_storekeepers (warehouse_id, user_id) values ('50000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-0000000000b3')$q$,
       'row-level security', 'staff cannot assign storekeepers');
reset role;

-- ---- Reports -------------------------------------------------------
select pg_temp.as_user(:P::uuid); set local role authenticated;
select pg_temp.ok((select count(*) from public.inv_rpt_balance(date_trunc('month', now())::date, date_trunc('month', now())::date) where material_id = '50000000-0000-0000-0000-0000000000a1') >= 1
                  , 'Reports View: balance report covers every warehouse');
select pg_temp.ok((select bool_and(end_value is null) from public.inv_rpt_balance(date_trunc('month', now())::date, date_trunc('month', now())::date) where material_id = '50000000-0000-0000-0000-0000000000a1'),
                  'Reports without "See peso values": quantities only');
reset role;
select pg_temp.as_user(:V::uuid); set local role authenticated;
select pg_temp.ok((select count(*) from public.inv_rpt_balance(date_trunc('month', now())::date, date_trunc('month', now())::date)) = 0, 'no Reports access → empty report');
reset role;
select pg_temp.as_user(null);
select public.staff_apply_access(:P::uuid, '[{"id":"purchasing"},{"id":"finance"}]', '[{"module":"inv.reports","level":"view"},{"module":"fin.costs","level":"view"}]', :A::uuid);
select pg_temp.as_user(:P::uuid); set local role authenticated;
select pg_temp.ok((select bool_or(end_value is not null) from public.inv_rpt_balance(date_trunc('month', now())::date, date_trunc('month', now())::date) where material_id = '50000000-0000-0000-0000-0000000000a1'),
                  'Reports + "See peso values": values shown');
reset role;

-- ---- Storekeepers and technicians unchanged -----------------------
select pg_temp.as_user(:K::uuid); set local role authenticated;
select pg_temp.fails($q$select public.inv_post_receipt(jsonb_build_object('warehouse_id','50000000-0000-0000-0000-000000000002','lines',jsonb_build_array(jsonb_build_object('material_id','50000000-0000-0000-0000-0000000000a1','qty',1))))$q$,
       'not a storekeeper', 'storekeeper still limited to their own warehouse');
select pg_temp.ok(pg_temp.cnt('select 1 from public.stock_on_hand_qty where warehouse_id = ''50000000-0000-0000-0000-000000000002''') = 0, 'storekeeper still sees only their warehouse');
select pg_temp.ok(pg_temp.cnt('select 1 from public.stock_balances') = 0, 'storekeeper still sees no peso values');
reset role;
select pg_temp.as_user(:T::uuid); set local role authenticated;
select pg_temp.ok(pg_temp.cnt('select 1 from public.stock_on_hand_qty') = 0, 'plain technician sees no stock');
select pg_temp.ok(pg_temp.cnt('select 1 from public.issue_slips') = 1, 'technician still sees the slip issued to them');
reset role;

\echo
\echo 'All inventory staff probes passed — rolling back.'
rollback;

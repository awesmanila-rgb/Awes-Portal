-- =====================================================================
-- Probe suite for 20260926_08_operations_tools_staff_access.sql
-- One transaction, rolled back. Prints PASS per check.
--   psql -d awes_backup -f operations_tools_staff_probe.sql
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
  ('c0000000-0000-0000-0000-00000000000a','ta@staff.awes-app.local'),
  ('c0000000-0000-0000-0000-00000000000b','tb@staff.awes-app.local'),
  ('c0000000-0000-0000-0000-00000000000c','tc@staff.awes-app.local');
insert into public.profiles (id, name, role, username) values
  ('c0000000-0000-0000-0000-00000000000a','Tomas Toolroom','staff','t_edit'),
  ('c0000000-0000-0000-0000-00000000000b','Vera Viewer','staff','t_view'),
  ('c0000000-0000-0000-0000-00000000000c','Cid Costs','staff','t_cost');
\set E  '''c0000000-0000-0000-0000-00000000000a'''
\set V  '''c0000000-0000-0000-0000-00000000000b'''
\set C  '''c0000000-0000-0000-0000-00000000000c'''
\set A  '''00000000-0000-0000-0000-0000000000a1'''
\set T  '''00000000-0000-0000-0000-0000000000b1'''
\set K  '''00000000-0000-0000-0000-0000000000b2'''
\set W1 '''c1000000-0000-0000-0000-000000000001'''
\set W2 '''c1000000-0000-0000-0000-000000000002'''

select pg_temp.as_user(null);
select public.staff_apply_access(:E::uuid, '[{"id":"operations"}]',
  '[{"module":"tools.register","level":"edit"},{"module":"tools.issue","level":"edit"},{"module":"tools.defects","level":"edit"},{"module":"tools.maintenance","level":"edit"},
    {"module":"ops.projects","level":"edit"},{"module":"ops.tracker","level":"view"}]', :A::uuid);
select public.staff_apply_access(:V::uuid, '[{"id":"operations"}]',
  '[{"module":"tools.register","level":"view"},{"module":"tools.slips","level":"view"},{"module":"ops.projects","level":"view"}]', :A::uuid);
select public.staff_apply_access(:C::uuid, '[{"id":"operations"},{"id":"finance"}]',
  '[{"module":"tools.reports","level":"view"},{"module":"fin.costs","level":"view"}]', :A::uuid);

select pg_temp.as_user(:A::uuid);
insert into public.warehouses (id, code, name) values (:W1::uuid, 'TW1', 'Tool Main'), (:W2::uuid, 'TW2', 'Tool Site');
insert into public.warehouse_storekeepers (warehouse_id, user_id) values (:W1::uuid, :K::uuid);

-- ---- Tool register ---------------------------------------------------
-- the Super Admin registers one tool with its cost
select pg_temp.as_user(:A::uuid); set local role authenticated;
insert into public.tools (id, asset_tag, kind, name, home_warehouse_id, status, condition, purchase_cost)
values ('c2000000-0000-0000-0000-000000000001', 'TL-PRB-1', 'tool', 'Probe vacuum pump', :W2::uuid, 'available', 'good', 18000);
reset role;
select pg_temp.as_user(:E::uuid); set local role authenticated;
select pg_temp.ok(jsonb_array_length(public.tl_staff_save_tools(null, jsonb_build_array(jsonb_build_object(
         'name', 'Probe torque wrench', 'kind', 'tool', 'home_warehouse_id', 'c1000000-0000-0000-0000-000000000002', 'purchase_cost', 5000)))) = 1,
       'Register Edit: adds a tool (in a warehouse they don''t keep)');
select pg_temp.fails($q$insert into public.tools (kind, name, home_warehouse_id) values ('tool','direct','c1000000-0000-0000-0000-000000000001')$q$,
       'row-level security', 'staff can''t write the tools table directly (only through the save function)');
select pg_temp.ok(pg_temp.cnt('select 1 from public.tools') = 0, 'Register Edit without "See peso values": still can''t read cost rows');
reset role;
select pg_temp.ok((select purchase_cost is null from public.tools where name = 'Probe torque wrench'), 'without "See peso values" a typed cost isn''t saved');
select pg_temp.as_user(:E::uuid); set local role authenticated;
select public.tl_staff_save_tools('c2000000-0000-0000-0000-000000000001', jsonb_build_array(jsonb_build_object(
         'name', 'Probe vacuum pump (2-stage)', 'purchase_cost', null, 'po_no', '')));
reset role;
select pg_temp.ok((select name = 'Probe vacuum pump (2-stage)' and purchase_cost = 18000 from public.tools where id = 'c2000000-0000-0000-0000-000000000001'),
                  'editing a tool without "See peso values" keeps its purchase cost');
select pg_temp.as_user(:V::uuid); set local role authenticated;
select pg_temp.ok(pg_temp.cnt('select 1 from public.tools_view where asset_tag = ''TL-PRB-1''') = 1, 'Register View: sees the tool (cost-free list)');
select pg_temp.ok(pg_temp.cnt('select 1 from public.tools where asset_tag = ''TL-PRB-1''') = 0, 'Register View without "See peso values": no purchase cost');
select pg_temp.fails($q$select public.tl_staff_save_tools(null, '[{"name":"x","home_warehouse_id":"c1000000-0000-0000-0000-000000000001"}]')$q$,
       'Edit access for Tool Register', 'Register View: cannot add a tool');
select pg_temp.fails($q$select public.tl_admin_status('c2000000-0000-0000-0000-000000000001', 'lost', 'x')$q$, 'Edit access for Tool Register', 'Register View: cannot mark a tool lost');
reset role;
select pg_temp.as_user(:C::uuid); set local role authenticated;
select pg_temp.ok((select purchase_cost from public.tools where asset_tag = 'TL-PRB-1') = 18000, 'Tools page + "See peso values": sees purchase cost');
reset role;

-- ---- Issue & status -------------------------------------------------
select pg_temp.as_user(:E::uuid); set local role authenticated;
select public.tl_post_issue(jsonb_build_object('warehouse_id', 'c1000000-0000-0000-0000-000000000002', 'worker_id', '00000000-0000-0000-0000-0000000000b1',
        'sign_mode', 'phone', 'sig_keeper_path', 'c0000000-0000-0000-0000-00000000000a/k.png',
        'lines', jsonb_build_array(jsonb_build_object('tool_id', 'c2000000-0000-0000-0000-000000000001'))));
reset role;
select pg_temp.ok((select status from public.tools where asset_tag = 'TL-PRB-1') = 'issued', 'Issue Edit: issues a tool from any warehouse');
select pg_temp.as_user(:V::uuid); set local role authenticated;
select pg_temp.ok(pg_temp.cnt('select 1 from public.tool_slips where warehouse_id = ''c1000000-0000-0000-0000-000000000002''') = 1, 'Slips View: sees the issue slip');
select pg_temp.fails($q$select public.tl_post_return(jsonb_build_object('warehouse_id','c1000000-0000-0000-0000-000000000002','lines','[]'::jsonb))$q$,
       'Edit access for Return Tools', 'no Return access: cannot post a return');
reset role;

-- ---- Storekeepers & technicians unchanged ------------------------------
select pg_temp.as_user(:K::uuid); set local role authenticated;
select pg_temp.ok(pg_temp.cnt('select 1 from public.tools_view where asset_tag = ''TL-PRB-1''') = 0, 'storekeeper of another warehouse still can''t see it');
reset role;
select pg_temp.as_user(:T::uuid); set local role authenticated;
select pg_temp.ok(pg_temp.cnt('select 1 from public.tools_view where asset_tag = ''TL-PRB-1''') = 1, 'the worker holding it still sees it');
select pg_temp.ok(pg_temp.cnt('select 1 from public.tools') = 0, 'technician still sees no purchase costs');
reset role;

-- ---- Projects -----------------------------------------------------------
select pg_temp.as_user(:E::uuid); set local role authenticated;
insert into public.projects (id, name, status) values ('c3000000-0000-0000-0000-000000000001', 'Probe Warehouse Fit-out', 'active');
reset role;
select pg_temp.ok(exists (select 1 from public.projects where id = 'c3000000-0000-0000-0000-000000000001'), 'Projects Edit: adds a project');
select pg_temp.as_user(:V::uuid); set local role authenticated;
select pg_temp.ok(pg_temp.cnt('select 1 from public.projects where id = ''c3000000-0000-0000-0000-000000000001''') = 1, 'Projects View: sees it');
select pg_temp.fails($q$insert into public.projects (name, status) values ('Nope', 'active')$q$, 'row-level security', 'Projects View: cannot add');
reset role;

-- ---- Live Tracker ----------------------------------------------------------
select pg_temp.as_user(:T::uuid); set local role authenticated;
insert into public.technician_locations (technician_id, lat, lng, updated_at) values (:T::uuid, 14.55, 121.02, now())
  on conflict (technician_id) do update set lat = excluded.lat, lng = excluded.lng, updated_at = now();
reset role;
select pg_temp.as_user(:E::uuid); set local role authenticated;
select pg_temp.ok(pg_temp.cnt('select 1 from public.technician_locations where technician_id = ''00000000-0000-0000-0000-0000000000b1''') = 1, 'Tracker View: sees technician positions');
reset role;
select pg_temp.as_user(:V::uuid); set local role authenticated;
select pg_temp.ok(pg_temp.cnt('select 1 from public.technician_locations') = 0, 'no Tracker access: no positions');
reset role;
select pg_temp.as_user(:E::uuid); set local role authenticated;
update public.technician_locations set lat = 0 where technician_id = '00000000-0000-0000-0000-0000000000b1';
reset role;
select pg_temp.ok((select lat from public.technician_locations where technician_id = :T::uuid) = 14.55, 'Tracker is read-only for staff');

\echo
\echo 'All operations (tools / projects / tracker) staff probes passed — rolling back.'
rollback;

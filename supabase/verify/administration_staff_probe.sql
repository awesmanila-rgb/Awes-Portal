-- =====================================================================
-- Probe suite for 20260926_06_administration_staff_access.sql
-- One transaction, rolled back. Prints PASS per check.
--   psql -d awes_backup -f administration_staff_probe.sql
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
  ('a0000000-0000-0000-0000-00000000000a','aa@staff.awes-app.local'),
  ('a0000000-0000-0000-0000-00000000000b','ab@staff.awes-app.local'),
  ('a0000000-0000-0000-0000-00000000000c','ac@staff.awes-app.local');
insert into public.profiles (id, name, role, username) values
  ('a0000000-0000-0000-0000-00000000000a','Ada Admin Staff','staff','a_edit'),
  ('a0000000-0000-0000-0000-00000000000b','Vi Viewer','staff','a_view'),
  ('a0000000-0000-0000-0000-00000000000c','Fin Only','staff','a_fin');
\set E  '''a0000000-0000-0000-0000-00000000000a'''
\set V  '''a0000000-0000-0000-0000-00000000000b'''
\set X  '''a0000000-0000-0000-0000-00000000000c'''
\set A  '''00000000-0000-0000-0000-0000000000a1'''
\set T  '''00000000-0000-0000-0000-0000000000b1'''
\set CU '''17c5334e-5b59-473b-a31f-72a47cf22d81'''

select pg_temp.as_user(null);
select public.staff_apply_access(:E::uuid, '[{"id":"administration"}]',
  '[{"module":"adm.customers","level":"edit"},{"module":"adm.equipment","level":"edit"},{"module":"adm.announcements","level":"edit"},{"module":"adm.dropdowns","level":"edit"}]', :A::uuid);
select public.staff_apply_access(:V::uuid, '[{"id":"administration"}]',
  '[{"module":"adm.customers","level":"view"},{"module":"adm.equipment","level":"view"}]', :A::uuid);
select public.staff_apply_access(:X::uuid, '[{"id":"finance"}]', '[{"module":"fin.cash_advance","level":"view"}]', :A::uuid);

-- ---- Customers -------------------------------------------------------
select pg_temp.as_user(:E::uuid); set local role authenticated;
insert into public.customers (id, name) values ('a1000000-0000-0000-0000-000000000001', 'Probe Corp');
update public.customers set address = 'Makati' where id = 'a1000000-0000-0000-0000-000000000001';
reset role;
select pg_temp.ok((select address from public.customers where id = 'a1000000-0000-0000-0000-000000000001') = 'Makati', 'Customers Edit: adds and changes a customer');
select pg_temp.as_user(:V::uuid); set local role authenticated;
select pg_temp.fails($q$insert into public.customers (name) values ('Nope Inc')$q$, 'row-level security', 'Customers View: cannot add');
delete from public.customers where id = 'a1000000-0000-0000-0000-000000000001';
reset role;
select pg_temp.ok(exists (select 1 from public.customers where id = 'a1000000-0000-0000-0000-000000000001'), 'Customers View: cannot remove');

-- rename carries onto reports
select pg_temp.as_user(:E::uuid); set local role authenticated;
update public.customers set name = 'Acme Foods Inc.' where id = :CU::uuid;
select pg_temp.ok(public.rename_customer_on_reports('Acme Foods', 'Acme Foods Inc.') >= 1, 'Customers Edit: rename carried onto the customer''s reports');
reset role;
select pg_temp.ok((select cust_name from public.service_reports where sr_no = 'SR-20260818-001') = 'Acme Foods Inc.', 'report now shows the new name');
select pg_temp.as_user(:V::uuid); set local role authenticated;
select pg_temp.fails($q$select public.rename_customer_on_reports('Acme Foods Inc.', 'Hijack')$q$, 'Edit access for Customers', 'Customers View: cannot rename reports');
select pg_temp.ok(pg_temp.cnt('select 1 from public.service_reports where customer_id = ''17c5334e-5b59-473b-a31f-72a47cf22d81''') >= 1, 'Customers / Equipment View: reads the customer''s service history');
update public.service_reports set remarks = 'tampered' where sr_no = 'SR-20260818-001';
reset role;
select pg_temp.ok((select coalesce(remarks, '') from public.service_reports where sr_no = 'SR-20260818-001') <> 'tampered', 'history is read-only for Administration staff');
select pg_temp.as_user(:X::uuid); set local role authenticated;
select pg_temp.ok(pg_temp.cnt('select 1 from public.service_reports') = 0, 'non-Administration staff see no service reports');
reset role;

-- ---- Equipment & photos ---------------------------------------------
select pg_temp.as_user(:E::uuid); set local role authenticated;
insert into public.customer_equipment (id, customer_id, equip_type, equip_location) values ('a2000000-0000-0000-0000-000000000001', :CU::uuid, 'Split', 'Lobby');
update public.customer_equipment set equip_location = 'Lobby 2' where id = 'a2000000-0000-0000-0000-000000000001';
insert into public.equipment_photos (equipment_id, customer_id, storage_path) values ('a2000000-0000-0000-0000-000000000001', :CU::uuid, 'probe/p.jpg');
reset role;
select pg_temp.ok((select equip_location from public.customer_equipment where id = 'a2000000-0000-0000-0000-000000000001') = 'Lobby 2', 'Equipment Edit: changes a unit');
select pg_temp.ok(exists (select 1 from public.equipment_photos where storage_path = 'probe/p.jpg'), 'Equipment Edit: adds a photo');
select pg_temp.as_user(:V::uuid); set local role authenticated;
select pg_temp.ok(pg_temp.cnt('select 1 from public.equipment_photos where storage_path = ''probe/p.jpg''') = 1, 'Equipment View: sees photos');
delete from public.customer_equipment where id = 'a2000000-0000-0000-0000-000000000001';
select pg_temp.fails($q$insert into public.equipment_photos (equipment_id, customer_id, storage_path) values ('a2000000-0000-0000-0000-000000000001','17c5334e-5b59-473b-a31f-72a47cf22d81','x.jpg')$q$,
       'row-level security', 'Equipment View: cannot add photos');
reset role;
select pg_temp.ok(exists (select 1 from public.customer_equipment where id = 'a2000000-0000-0000-0000-000000000001'), 'Equipment View: cannot remove a unit');

-- ---- Announcements ----------------------------------------------------
select pg_temp.as_user(:E::uuid); set local role authenticated;
insert into public.announcements (id, title) values (-777, 'Probe notice');
reset role;
select pg_temp.ok(exists (select 1 from public.announcements where id = -777), 'Announcements Edit: posts');
select pg_temp.as_user(:V::uuid); set local role authenticated;
select pg_temp.fails($q$insert into public.announcements (id, title) values (-778, 'x')$q$, 'row-level security', 'no Announcements access: cannot post');
select pg_temp.ok(pg_temp.cnt('select 1 from public.announcements where id = -777') = 1, 'everyone still reads announcements');
reset role;

-- ---- Dropdown lists ---------------------------------------------------
select pg_temp.as_user(:E::uuid); set local role authenticated;
update public.app_settings set value = value || '{"probe":["x"]}' where key = 'settings/fieldLists';
select pg_temp.fails($q$insert into public.app_settings (key, value) values ('settings/emailjs', '{}')$q$, 'row-level security', 'Dropdowns Edit: cannot touch other settings');
reset role;
select pg_temp.ok((select value ? 'probe' from public.app_settings where key = 'settings/fieldLists'), 'Dropdowns Edit: saves the report form lists');
select pg_temp.as_user(:V::uuid); set local role authenticated;
update public.app_settings set value = '{}' where key = 'settings/fieldLists';
reset role;
select pg_temp.ok((select value ? 'probe' from public.app_settings where key = 'settings/fieldLists'), 'no Dropdowns access: lists unchanged');

-- ---- technicians & customers unchanged ------------------------------
select pg_temp.as_user(:T::uuid); set local role authenticated;
select pg_temp.fails($q$insert into public.customers (name) values ('Tech Co')$q$, 'row-level security', 'technician still cannot add customers');
select pg_temp.ok(pg_temp.cnt('select 1 from public.customers') >= 1, 'technician still reads customers');
reset role;

\echo
\echo 'All administration staff probes passed — rolling back.'
rollback;

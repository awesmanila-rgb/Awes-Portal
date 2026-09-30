-- Probe for 20261013_01_technician_accounts.sql. One transaction, rolled back.
\set ON_ERROR_STOP 1
begin;
create function pg_temp.ok(c boolean, n text) returns void language plpgsql as $$ begin if c then raise notice 'PASS  %', n; else raise exception 'FAIL  %', n; end if; end $$;
create function pg_temp.seen(p uuid, q text) returns bigint language plpgsql as $$ declare n bigint; begin
  perform set_config('request.jwt.claim.sub', p::text, true); perform set_config('request.jwt.claim.role','authenticated',true);
  set local role authenticated; execute 'select count(*) from (' || q || ') x' into n; reset role; return n; end $$;
create function pg_temp.del(p uuid) returns bigint language plpgsql as $$ declare n bigint; begin
  perform set_config('request.jwt.claim.sub', p::text, true); perform set_config('request.jwt.claim.role','authenticated',true);
  set local role authenticated; delete from public.device_locks where technician_id = '00000000-0000-0000-0000-0000000000b1'; get diagnostics n = row_count; reset role; return n; end $$;
\set A  '''00000000-0000-0000-0000-0000000000a1'''
\set OH '''70000000-0000-0000-0000-00000000000a'''
\set OV '''70000000-0000-0000-0000-00000000000b'''
\set X  '''70000000-0000-0000-0000-00000000000c'''
insert into auth.users (id, email) values (:OH, 'oh@t'), (:OV, 'ov@t'), (:X, 'x@t');
insert into public.profiles (id, name, role, username) values (:OH, 'Ops Head', 'staff', 'ta_oh'), (:OV, 'Ops Viewer', 'staff', 'ta_ov'), (:X, 'Purchasing', 'staff', 'ta_x');
select set_config('request.jwt.claim.role', 'service_role', true);
select public.staff_apply_access(:OH::uuid, '[{"id":"operations","is_head":true}]', '[{"module":"ops.technicians","level":"edit"}]', :A::uuid);
select public.staff_apply_access(:OV::uuid, '[{"id":"operations"}]', '[{"module":"ops.technicians","level":"view"}]', :A::uuid);
select public.staff_apply_access(:X::uuid,  '[{"id":"purchasing"}]', '[{"module":"pur.suppliers","level":"view"}]', :A::uuid);
insert into public.device_locks (technician_id, device_id) values ('00000000-0000-0000-0000-0000000000b1', 'probe-device') on conflict do nothing;
select pg_temp.ok(pg_temp.seen(:OV, $q$select * from public.profiles where role = 'technician'$q$) >= 7, 'Technicians (view) sees the technician list');
select pg_temp.ok(pg_temp.seen(:X,  $q$select * from public.profiles where role = 'technician'$q$) = 0, 'other staff don''t');
select pg_temp.ok(pg_temp.seen(:OV, $q$select * from public.profiles where role in ('admin','customer')$q$) = 0, '… and never admin or customer accounts');
select pg_temp.ok(pg_temp.del(:OV) = 0, 'view access can''t clear a device lock');
select pg_temp.ok(pg_temp.del(:OH) = 1, 'the Operations Head (edit) can');
rollback;

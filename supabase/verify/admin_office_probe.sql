-- Probe for 20261014_01_admin_office.sql. One transaction, rolled back.
\set ON_ERROR_STOP 1
begin;
create function pg_temp.ok(c boolean, n text) returns void language plpgsql as $$ begin if c then raise notice 'PASS  %', n; else raise exception 'FAIL  %', n; end if; end $$;
create function pg_temp.as_user(p uuid) returns void language plpgsql as $$ begin
  perform set_config('request.jwt.claim.sub', p::text, true); perform set_config('request.jwt.claim.role','authenticated',true); end $$;
create function pg_temp.run(p uuid, q text) returns text language plpgsql as $$ begin
  perform pg_temp.as_user(p); set local role authenticated;
  begin execute q; exception when others then reset role; return 'ERR: ' || sqlerrm; end; reset role; return 'ok'; end $$;
create function pg_temp.seen(p uuid, q text) returns bigint language plpgsql as $$ declare n bigint; begin
  perform pg_temp.as_user(p); set local role authenticated; execute 'select count(*) from (' || q || ') x' into n; reset role; return n; end $$;
create function pg_temp.inbox(p uuid, k text) returns bigint language plpgsql as $$ declare n bigint; begin
  perform pg_temp.as_user(p); select count(*) into n from jsonb_array_elements(public.inbox_items()) x where x->>'kind' = k; return n; end $$;
\set A  '''00000000-0000-0000-0000-0000000000a1'''
\set T  '''00000000-0000-0000-0000-0000000000b1'''
\set AE '''80000000-0000-0000-0000-00000000000a'''
\set AV '''80000000-0000-0000-0000-00000000000b'''
\set MS '''80000000-0000-0000-0000-00000000000c'''
insert into auth.users (id, email) values (:AE, 'ae@o'), (:AV, 'av@o'), (:MS, 'ms@o');
insert into public.profiles (id, name, role, username) values (:AE, 'Ana Admin', 'staff', 'ao_ae'), (:AV, 'Ben Viewer', 'staff', 'ao_av'), (:MS, 'Migo Messenger', 'staff', 'ao_ms');
select set_config('request.jwt.claim.role', 'service_role', true);
select public.staff_apply_access(:AE::uuid, '[{"id":"administration"}]',
  '[{"module":"adm.permits","level":"edit"},{"module":"adm.vehicles","level":"edit"},{"module":"adm.contracts","level":"edit"},{"module":"adm.bills","level":"edit"},{"module":"adm.assets","level":"edit"}]', :A::uuid);
select public.staff_apply_access(:AV::uuid, '[{"id":"administration"}]', '[{"module":"adm.permits","level":"view"}]', :A::uuid);
select public.staff_apply_access(:MS::uuid, '[{"id":"administration"}]', '[{"module":"adm.my_errands","level":"view"}]', :A::uuid);

-- permits
select pg_temp.ok(pg_temp.run(:AV, $q$insert into public.adm_permits (name, expires_on) values ('x', current_date)$q$) like 'ERR:%row-level%', 'view access can''t add a permit');
select pg_temp.run(:AE, $q$insert into public.adm_permits (kind, name, number, expires_on) values ('business_permit', 'Mayor''s Permit 2026', 'BP-1', current_date + 20), ('fsic', 'FSIC', 'F-1', current_date + 200)$q$);
select pg_temp.ok(pg_temp.seen(:AV, 'select * from public.adm_permits') = 2, 'view access sees the permits');
select pg_temp.ok(pg_temp.inbox(:AE, 'permit_expiring') = 1, 'a permit inside its 60-day window is in the Inbox (the far one isn''t)');
select pg_temp.ok(pg_temp.seen(:T, 'select * from public.adm_permits') = 0, 'technicians see none of it');

-- vehicles
select pg_temp.run(:AE, $q$insert into public.adm_vehicles (plate_no, make_model, odometer_km, pms_every_km, next_pms_km, reg_expires_on) values ('ABC 1234', 'L300', 10000, 5000, 15000, current_date + 10)$q$);
select pg_temp.ok(pg_temp.inbox(:AE, 'vehicle_due') = 1, 'registration expiring in 10 days is flagged');
select pg_temp.run(:AE, $q$insert into public.adm_vehicle_trips (vehicle_id, driver_name, destination, km_out) values ((select id from public.adm_vehicles where plate_no = 'ABC 1234'), 'Bryan', 'Makati', 10000)$q$);
select pg_temp.ok((select trip_no like 'TT-%' from public.adm_vehicle_trips), 'trip ticket numbered');
select pg_temp.ok(pg_temp.run(:AE, $q$insert into public.adm_vehicle_trips (vehicle_id, driver_name, km_out) values ((select id from public.adm_vehicles where plate_no = 'ABC 1234'), 'X', 10000)$q$) like 'ERR:%already out%', 'one open trip per vehicle');
select pg_temp.ok(pg_temp.run(:AE, $q$update public.adm_vehicle_trips set status = 'returned', km_in = 9000$q$) like 'ERR:%check%', 'km in can''t be below km out');
select pg_temp.run(:AE, $q$update public.adm_vehicle_trips set status = 'returned', km_in = 10085$q$);
select pg_temp.ok((select odometer_km = 10085 from public.adm_vehicles), 'closing the trip updates the odometer');
select pg_temp.run(:AE, $q$insert into public.adm_vehicle_service (vehicle_id, odometer_km, work) values ((select id from public.adm_vehicles), 14900, 'Change oil, filters')$q$);
select pg_temp.ok((select next_pms_km = 19900 from public.adm_vehicles), 'a service record sets the next PMS (+5,000 km)');

-- contracts
select pg_temp.run(:AE, $q$insert into public.adm_contracts (kind, title, party_name, start_on, end_on) values ('customer_pms', 'Quarterly PMS', 'Acme Foods', current_date - 300, current_date + 15)$q$);
select pg_temp.ok(pg_temp.inbox(:AE, 'contract_expiring') = 1, 'a contract ending in 15 days is flagged');

-- bills
select pg_temp.run(:AE, $q$insert into public.adm_bill_accounts (name, category, provider, account_no, due_day, usual_amount, send_messenger, messenger_id)
  values ('Meralco — Office', 'electricity', 'Meralco', '1234567890', extract(day from current_date)::int, 8500, true, '80000000-0000-0000-0000-00000000000c')$q$);
select pg_temp.run(:AE, 'select public.adm_bills_generate()');
select pg_temp.ok((select count(*) >= 1 and bool_and(amount = 8500) from public.adm_bills), 'this month''s bill is created from the account');
select pg_temp.ok(pg_temp.inbox(:AE, 'bill_due') >= 1, 'a bill due today is in the Inbox');
select pg_temp.run(:AE, $q$select public.adm_bill_send_errand((select id from public.adm_bills order by due_on limit 1))$q$);
select pg_temp.ok((select e.status = 'assigned' and e.assigned_to = '80000000-0000-0000-0000-00000000000c' and e.cash_amount = 8500
                     from public.adm_bills b join public.errands e on e.id = b.errand_id order by b.due_on limit 1), 'the messenger gets a payment errand with the cash amount');
select pg_temp.ok(pg_temp.run(:AE, $q$select public.adm_bill_send_errand((select id from public.adm_bills order by due_on limit 1))$q$) like 'ERR:%already%', 'only one errand per bill');
select pg_temp.run(:AE, $q$update public.adm_bills set status = 'paid', paid_on = current_date, paid_amount = 8430 where id = (select id from public.adm_bills order by due_on limit 1)$q$);
select pg_temp.ok(pg_temp.inbox(:AE, 'bill_due') = (select count(*) from public.adm_bills where status = 'unpaid' and due_on - 3 <= current_date), 'paying it clears the alert');

-- office assets
select pg_temp.run(:AE, $q$insert into public.adm_assets (category, name, serial_no, holder_id) values ('laptop', 'Lenovo ThinkPad', 'SN1', '80000000-0000-0000-0000-00000000000b')$q$);
select pg_temp.ok((select asset_tag like 'OA-%' and status = 'issued' and holder_name = 'Ben Viewer' from public.adm_assets), 'asset tagged and issued');
select pg_temp.ok(pg_temp.seen(:AV, 'select * from public.adm_assets') = 1, 'the holder sees the asset issued to them');
set local session_replication_role = replica;
update public.profiles set active = false where id = :AV;
set local session_replication_role = origin;
select pg_temp.ok(pg_temp.inbox(:AE, 'asset_unreturned') = 1, 'an asset still with a deactivated person is flagged');
select pg_temp.run(:AE, $q$update public.adm_assets set holder_id = null$q$);
select pg_temp.ok((select status = 'available' from public.adm_assets) and (select count(*) = 3 from public.adm_asset_events), 'returned: available, history kept (added, issued, returned)');
rollback;

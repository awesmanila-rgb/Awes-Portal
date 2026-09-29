-- Probe for 20261007_01_customer_ticket_tech_names.sql — the customer
-- portal gets the assigned technicians' names for its own job only.
-- One transaction, rolled back.   psql -d awes_backup -f customer_ticket_tech_names_probe.sql
\set ON_ERROR_STOP 1
begin;
create function pg_temp.ok(c boolean, n text) returns void language plpgsql as $$
begin if c then raise notice 'PASS  %', n; else raise exception 'FAIL  %', n; end if; end $$;
create function pg_temp.names_as(p uuid, t text) returns text[] language plpgsql as $$
declare r text[]; begin
  perform set_config('request.jwt.claim.sub', p::text, true); perform set_config('request.jwt.claim.role', 'authenticated', true);
  set local role authenticated; r := public.customer_ticket_tech_names(t); reset role; return r; end $$;
create function pg_temp.rows_as(p uuid, t text) returns bigint language plpgsql as $$
declare n bigint; begin
  perform set_config('request.jwt.claim.sub', p::text, true); perform set_config('request.jwt.claim.role', 'authenticated', true);
  set local role authenticated; select count(*) into n from public.dispatch_tickets where id = t; reset role; return n; end $$;

insert into auth.users (id, email) values ('c0000000-0000-0000-0000-00000000000a', 'c1@x'), ('c0000000-0000-0000-0000-00000000000b', 'c2@x');
insert into public.profiles (id, name, role) values ('c0000000-0000-0000-0000-00000000000a', 'Cust One', 'customer'), ('c0000000-0000-0000-0000-00000000000b', 'Cust Two', 'customer');
insert into public.customer_login_links (profile_id, customer_id) values
  ('c0000000-0000-0000-0000-00000000000a', (select id from public.customers where name = 'Acme Foods')),
  ('c0000000-0000-0000-0000-00000000000b', (select id from public.customers where name = 'Bayview Mall'));
set local session_replication_role = replica;
insert into public.dispatch_tickets (id, status, data) values ('probe-jo-1', 'acknowledged',
  jsonb_build_object('assignedWorkerIds', jsonb_build_array('00000000-0000-0000-0000-0000000000b1'),
                     'assignedWorkerNames', jsonb_build_array('Bryan', 'Diony'), 'remarks', 'internal note'));
insert into public.service_requests (customer_id, description, status, linked_dispatch_ticket_id)
  values ((select id from public.customers where name = 'Acme Foods'), 'Aircon not cooling', 'en_route', 'probe-jo-1');
set local session_replication_role = origin;

select pg_temp.ok(pg_temp.rows_as('c0000000-0000-0000-0000-00000000000a', 'probe-jo-1') = 0, 'customers still can''t read the ticket itself');
select pg_temp.ok(pg_temp.names_as('c0000000-0000-0000-0000-00000000000a', 'probe-jo-1') = array['Bryan','Diony'], 'the customer gets the crew names for their own job');
select pg_temp.ok(pg_temp.names_as('c0000000-0000-0000-0000-00000000000b', 'probe-jo-1') is null, 'another customer gets nothing');
select pg_temp.ok(pg_temp.names_as('00000000-0000-0000-0000-0000000000a1', 'probe-jo-1') = array['Bryan','Diony'], 'admin gets the names too');
select pg_temp.ok(pg_temp.names_as('c0000000-0000-0000-0000-00000000000a', 'no-such-jo') is null, 'unknown ticket: nothing');
rollback;

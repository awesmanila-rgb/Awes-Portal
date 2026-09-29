-- Probe for 20261009_01_service_report_review.sql — the Operations head
-- reviews and closes job orders (closing signs off their reports) and signs
-- off reports no job order covers; the Inbox shows both; customers only see
-- signed-off reports. One transaction, rolled back.
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
create function pg_temp.inbox(p uuid, k text, lbl text) returns bigint language plpgsql as $$ declare n bigint; begin
  perform pg_temp.as_user(p); select count(*) into n from jsonb_array_elements(public.inbox_items()) x where x->>'kind' = k and x->>'ref_label' = lbl; return n; end $$;

\set A  '''00000000-0000-0000-0000-0000000000a1'''
\set T  '''00000000-0000-0000-0000-0000000000b1'''
\set OH '''ab000000-0000-0000-0000-00000000000a'''
\set OD '''ab000000-0000-0000-0000-00000000000b'''
\set CU '''ab000000-0000-0000-0000-00000000000c'''
insert into auth.users (id, email) values (:OH, 'oh@x'), (:OD, 'od@x'), (:CU, 'cu@x');
insert into public.profiles (id, name, role, username) values (:OH, 'Olive Ops Head', 'staff', 'rv_oh'), (:OD, 'Dan Dispatcher', 'staff', 'rv_od');
insert into public.profiles (id, name, role) values (:CU, 'Acme login', 'customer');
insert into public.customer_login_links (profile_id, customer_id) values (:CU, (select id from public.customers where name = 'Acme Foods'));
select pg_temp.as_user(null);
select public.staff_apply_access(:OH::uuid, '[{"id":"operations"}]',
  '[{"module":"ops.dispatch","level":"approve"},{"module":"ops.service_reports","level":"approve"}]', :A::uuid);
select public.staff_apply_access(:OD::uuid, '[{"id":"operations"}]',
  '[{"module":"ops.dispatch","level":"edit"},{"module":"ops.service_reports","level":"view"}]', :A::uuid);

set local session_replication_role = replica;
insert into public.dispatch_tickets (id, status, data) values ('probe-jo-rv', 'completed',
  jsonb_build_object('jobOrderNo', 'JO-RV', 'custName', 'Acme Foods', 'completedAt', now() - interval '2 hours',
                     'equipmentList', jsonb_build_array(jsonb_build_object('reportSrNo', 'SR-A'))));
set local session_replication_role = origin;
select pg_temp.run(:T, $q$insert into public.service_reports (sr_no, technician_id, technician_name, cust_name, customer_id, completed, reviewed_at, reviewed_by)
  values ('SR-A', '00000000-0000-0000-0000-0000000000b1', 'Bryan', 'Acme Foods', (select id from public.customers where name = 'Acme Foods'), true, now(), 'Bryan')$q$);
select pg_temp.run(:T, $q$insert into public.service_reports (sr_no, technician_id, technician_name, cust_name, customer_id, completed)
  values ('SR-B', '00000000-0000-0000-0000-0000000000b1', 'Bryan', 'Acme Foods', (select id from public.customers where name = 'Acme Foods'), true)$q$);

select pg_temp.ok((select reviewed_at is null from public.service_reports where sr_no = 'SR-A'), 'a technician can''t sign off their own report by writing to it');
select pg_temp.ok(pg_temp.seen(:CU, $q$select * from public.service_reports where sr_no in ('SR-A','SR-B')$q$) = 0, 'the customer sees neither report yet');

select pg_temp.ok(pg_temp.run(:T, $q$update public.service_reports set reviewed_at = now(), reviewed_by = 'Bryan' where sr_no = 'SR-B'$q$) = 'ok'
                  and (select reviewed_at is null from public.service_reports where sr_no = 'SR-B'), 'writing the sign-off columns directly does nothing');
select pg_temp.ok(pg_temp.run(:T, $q$update public.service_reports set remarks = 'x' where sr_no = 'SR-B'$q$) like 'ERR:%cannot be edited%', 'filed reports stay read-only (existing guard)');

-- job order review
select pg_temp.ok(pg_temp.inbox(:OH, 'jo_review', 'JO-RV') = 1, 'the completed job order is in the Operations head''s Inbox');
select pg_temp.ok(pg_temp.inbox(:OD, 'jo_review', 'JO-RV') = 0, '… not the dispatcher''s');
select pg_temp.ok(pg_temp.run(:OD, $q$update public.dispatch_tickets set status = 'closed' where id = 'probe-jo-rv'$q$) like 'ERR: Only the Operations head%', 'a dispatcher can''t close it');
select pg_temp.ok(pg_temp.run(:OH, $q$select public.service_report_sign_off((select id from public.service_reports where sr_no = 'SR-A'))$q$) like 'ERR:%isn''t closed yet%',
  'its report can''t be signed off separately while the job order is open');
select pg_temp.ok(pg_temp.run(:OH, $q$update public.dispatch_tickets set status = 'closed',
  data = data || jsonb_build_object('closedBy', 'Olive Ops Head', 'closedById', 'ab000000-0000-0000-0000-00000000000a') where id = 'probe-jo-rv'$q$) = 'ok', 'the Operations head closes it');
select pg_temp.ok((select reviewed_at is not null and reviewed_by = 'Olive Ops Head' and reviewed_by_id = 'ab000000-0000-0000-0000-00000000000a' from public.service_reports where sr_no = 'SR-A'), 'closing signed off its report');
select pg_temp.ok(pg_temp.seen(:CU, $q$select * from public.service_reports where sr_no = 'SR-A'$q$) = 1, 'the customer now sees that report');

-- a report no job order covers
select pg_temp.ok(pg_temp.seen(:OH, $q$select * from public.service_reports_to_sign_off() i where i = (select id from public.service_reports where sr_no = 'SR-B')$q$) = 1, 'SR-B is on Needs Review');
select pg_temp.ok(pg_temp.inbox(:OH, 'report_signoff', 'SR-B') = 1 and pg_temp.inbox(:OD, 'report_signoff', 'SR-B') = 0, 'it''s in the head''s Inbox only');
select pg_temp.ok(pg_temp.run(:OD, $q$select public.service_report_sign_off((select id from public.service_reports where sr_no = 'SR-B'))$q$) like 'ERR: You need%', 'view access can''t sign off');
select pg_temp.ok(pg_temp.run(:OH, $q$select public.service_report_sign_off((select id from public.service_reports where sr_no = 'SR-B'))$q$) = 'ok', 'the head signs it off');
select pg_temp.ok((select reviewed_by = 'Olive Ops Head' from public.service_reports where sr_no = 'SR-B')
                  and pg_temp.seen(:CU, $q$select * from public.service_reports where sr_no = 'SR-B'$q$) = 1, 'signed off, and the customer sees it');
select pg_temp.ok(pg_temp.run(:OH, $q$select public.service_report_sign_off((select id from public.service_reports where sr_no = 'SR-B'))$q$) like 'ERR:%already signed off%', 'no second sign-off');

-- own report
select pg_temp.run(:OH, $q$insert into public.service_reports (sr_no, technician_id, cust_name, completed) values ('SR-C', 'ab000000-0000-0000-0000-00000000000a', 'Acme Foods', true)$q$);
select pg_temp.ok(pg_temp.run(:OH, $q$select public.service_report_sign_off((select id from public.service_reports where sr_no = 'SR-C'))$q$) like 'ERR:%your own%', 'nobody signs off their own report');
select pg_temp.ok(pg_temp.run(:A, $q$select public.service_report_sign_off((select id from public.service_reports where sr_no = 'SR-C'))$q$) = 'ok', 'the Super Admin can');
rollback;

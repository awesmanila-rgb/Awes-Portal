-- =====================================================================
-- Probe suite for 20260926_04_finance_staff_access.sql
-- One transaction, rolled back. Prints PASS per check.
--   psql -d awes_backup -f finance_staff_probe.sql
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
create function pg_temp.d(p uuid) returns jsonb language sql as $$ select data from public.cash_advance_requests where id = p $$;

insert into auth.users (id, email) values
  ('60000000-0000-0000-0000-00000000000a','fa@staff.awes-app.local'),
  ('60000000-0000-0000-0000-00000000000b','fb@staff.awes-app.local'),
  ('60000000-0000-0000-0000-00000000000c','fc@staff.awes-app.local');
insert into public.profiles (id, name, role, username) values
  ('60000000-0000-0000-0000-00000000000a','Fe Approver','staff','f_appr'),
  ('60000000-0000-0000-0000-00000000000b','Lito Liquidation','staff','f_liq'),
  ('60000000-0000-0000-0000-00000000000c','Pia Purchasing','staff','f_pur');
\set FA '''60000000-0000-0000-0000-00000000000a'''
\set FB '''60000000-0000-0000-0000-00000000000b'''
\set FC '''60000000-0000-0000-0000-00000000000c'''
\set A  '''00000000-0000-0000-0000-0000000000a1'''
\set T  '''00000000-0000-0000-0000-0000000000b1'''
\set CA1 '''70000000-0000-0000-0000-000000000001'''
\set CA2 '''70000000-0000-0000-0000-000000000002'''
\set RB1 '''70000000-0000-0000-0000-000000000003'''

select pg_temp.as_user(null);
select public.staff_apply_access(:FA::uuid, '[{"id":"finance"}]',
  '[{"module":"fin.cash_advance","level":"approve","approve_limit":5000},{"module":"fin.reimbursement","level":"view"}]', :A::uuid);
select public.staff_apply_access(:FB::uuid, '[{"id":"finance"}]',
  '[{"module":"fin.cash_advance","level":"edit"},{"module":"fin.liquidation","level":"approve"}]', :A::uuid);
select public.staff_apply_access(:FC::uuid, '[{"id":"purchasing"}]', '[{"module":"pur.suppliers","level":"view"}]', :A::uuid);

-- technician files two advances and a reimbursement (unchanged path)
select pg_temp.as_user(:T::uuid); set local role authenticated;
insert into public.cash_advance_requests (id, technician_id, status, submitted_at, data) values
  (:CA1::uuid, :T::uuid, 'pending', now(), '{"id":"70000000-0000-0000-0000-000000000001","amount":3000,"purpose":"Refrigerant","technicianName":"Bryan"}'),
  (:CA2::uuid, :T::uuid, 'pending', now(), '{"id":"70000000-0000-0000-0000-000000000002","amount":8000,"purpose":"Compressor","technicianName":"Bryan"}'),
  (:RB1::uuid, :T::uuid, 'pending', now(), '{"id":"70000000-0000-0000-0000-000000000003","kind":"reimbursement","amount":450,"technicianName":"Bryan"}');
reset role;

-- ---- visibility ---------------------------------------------------
select pg_temp.as_user(:FC::uuid); set local role authenticated;
select pg_temp.ok(pg_temp.cnt('select 1 from public.cash_advance_requests') = 0, 'non-finance staff see no requests');
reset role;
select pg_temp.as_user(:FB::uuid); set local role authenticated;
select pg_temp.ok(pg_temp.cnt('select 1 from public.cash_advance_requests where id::text like ''70000000-%''') = 2, 'Cash Advance / Liquidation staff see advances, not reimbursements');
reset role;
select pg_temp.as_user(:FA::uuid); set local role authenticated;
select pg_temp.ok(pg_temp.cnt('select 1 from public.cash_advance_requests where id::text like ''70000000-%''') = 3, 'with Reimbursement access, reimbursements too');
reset role;

-- ---- approve an advance -------------------------------------------
select pg_temp.as_user(:FB::uuid); set local role authenticated;
select pg_temp.fails($q$update public.cash_advance_requests set status='approved', data = data || '{"status":"approved"}' where id='70000000-0000-0000-0000-000000000001'$q$,
       'don''t have Approve access', 'Edit-only staff cannot approve an advance');
reset role;
select pg_temp.as_user(:FA::uuid); set local role authenticated;
select pg_temp.fails($q$update public.cash_advance_requests set status='approved', data = data || '{"status":"approved"}' where id='70000000-0000-0000-0000-000000000002'$q$,
       'above your approval limit', 'above the peso limit (₱8,000 > ₱5,000) is refused');
select pg_temp.fails($q$update public.cash_advance_requests set status='approved', data = data || '{"status":"approved"}' where id='70000000-0000-0000-0000-000000000001'$q$,
       'Enter your password', 'approval asks for password re-entry');
reset role;
select pg_temp.as_user(null); select public.staff_record_reauth(:FA::uuid);
select pg_temp.as_user(:FA::uuid); set local role authenticated;
select pg_temp.fails($q$update public.cash_advance_requests set data = data || '{"amount":1}' where id='70000000-0000-0000-0000-000000000001'$q$,
       'Only the person who filed', 'staff cannot change the amount a technician asked for');
update public.cash_advance_requests set status='approved',
  data = data || '{"status":"approved","comment":"OK","decidedBy":"Somebody Else","decidedAt":"2000-01-01"}' where id='70000000-0000-0000-0000-000000000001';
reset role;
select pg_temp.ok((select status = 'approved' and data->>'decidedBy' = 'Fe Approver' and data->>'comment' = 'OK' and (data->>'decidedAt') > '2020'
                     from public.cash_advance_requests where id = :CA1::uuid), 'approved — "decided by" is the real approver, not what the screen sent');

-- ---- record the cash given -----------------------------------------
select pg_temp.as_user(:FB::uuid); set local role authenticated;
update public.cash_advance_requests set data = data || '{"disbursed":true,"dateGiven":"2026-09-25","amountGiven":3000,"disbursedBy":"Nobody"}' where id='70000000-0000-0000-0000-000000000001';
reset role;
select pg_temp.ok((select (data->>'disbursed')::boolean and data->>'disbursedBy' = 'Lito Liquidation' from public.cash_advance_requests where id = :CA1::uuid),
                  'Edit: records cash given (stamped with who did it)');
select pg_temp.as_user(:FB::uuid); set local role authenticated;
select pg_temp.fails($q$update public.cash_advance_requests set data = data || '{"amountGiven":9999}' where id='70000000-0000-0000-0000-000000000001'$q$,
       'already recorded', 'payment can''t be recorded twice / changed afterwards');
reset role;

-- ---- liquidation ---------------------------------------------------
select pg_temp.as_user(:T::uuid); set local role authenticated;
update public.cash_advance_requests set data = data || '{"liquidation":{"totalAmount":2500,"items":[{"desc":"R32","amount":2500}]}}' where id='70000000-0000-0000-0000-000000000001';
reset role;
select pg_temp.ok((pg_temp.d(:CA1::uuid)->'liquidation'->>'status') = 'pending', 'technician submits a liquidation (unchanged path)');

select pg_temp.as_user(:FA::uuid); set local role authenticated;
select pg_temp.fails($q$update public.cash_advance_requests set data = jsonb_set(data, '{liquidation,status}', '"approved"') where id='70000000-0000-0000-0000-000000000001'$q$,
       'Approve access for Liquidation', 'Cash Advance approver without Liquidation access cannot approve it');
reset role;
select pg_temp.as_user(null); select public.staff_record_reauth(:FB::uuid);
select pg_temp.as_user(:FB::uuid); set local role authenticated;
select pg_temp.fails($q$update public.cash_advance_requests set data = jsonb_set(data, '{liquidation,totalAmount}', '100') where id='70000000-0000-0000-0000-000000000001'$q$,
       'Only the technician', 'staff cannot change liquidated amounts');
update public.cash_advance_requests set data = jsonb_set(data, '{liquidation}', (data->'liquidation') ||
  '{"status":"approved","settlement":{"type":"none","amount":0,"settled":true}}') where id='70000000-0000-0000-0000-000000000001';
reset role;
select pg_temp.ok((select l->>'decidedBy' = 'Lito Liquidation' and l->'settlement'->>'type' = 'return' and (l->'settlement'->>'amount')::numeric = 500
                          and not (l->'settlement'->>'settled')::boolean
                     from (select pg_temp.d(:CA1::uuid)->'liquidation' l) x),
                  'Approve: liquidation approved — balance worked out by the database (₱500 to return), not the screen');
select pg_temp.as_user(:FB::uuid); set local role authenticated;
update public.cash_advance_requests set data = jsonb_set(data, '{liquidation,settlement}', (data->'liquidation'->'settlement') || '{"settled":true,"method":"GCash"}') where id='70000000-0000-0000-0000-000000000001';
reset role;
select pg_temp.ok((select l->'settlement'->>'settledBy' = 'Lito Liquidation' and l->'settlement'->>'method' = 'GCash' and (l->'settlement'->>'settled')::boolean
                     from (select pg_temp.d(:CA1::uuid)->'liquidation' l) x), 'Edit: balance marked settled with method');

-- ---- reimbursement --------------------------------------------------
select pg_temp.as_user(:FA::uuid); set local role authenticated;
update public.cash_advance_requests set status='approved', data = data || '{"status":"approved"}' where id='70000000-0000-0000-0000-000000000003';
reset role;
select pg_temp.ok((select status from public.cash_advance_requests where id = :RB1::uuid) = 'pending', 'Reimbursement View: the approval changes nothing (still pending)');

-- ---- technician & Super Admin unchanged ----------------------------
select pg_temp.as_user(:T::uuid); set local role authenticated;
update public.cash_advance_requests set status='approved', data = data || '{"status":"approved"}' where id='70000000-0000-0000-0000-000000000002';
reset role;
select pg_temp.ok((select status from public.cash_advance_requests where id = :CA2::uuid) = 'pending', 'technician still cannot approve their own');
select pg_temp.as_user(:A::uuid); set local role authenticated;
update public.cash_advance_requests set status='approved', data = data || '{"status":"approved","decidedBy":"Admin"}' where id='70000000-0000-0000-0000-000000000002';
reset role;
select pg_temp.ok((select status = 'approved' and data->>'decidedBy' = 'Admin' from public.cash_advance_requests where id = :CA2::uuid),
                  'Super Admin approves any amount, as before');

\echo
\echo 'All finance staff probes passed — rolling back.'
rollback;

-- =====================================================================
-- Probe suite for 20260926_01_departments_access.sql
--
-- Runs entirely inside one transaction and ROLLS BACK at the end, so it
-- leaves no rows behind. Safe on the replica harness; on production only
-- run it if you are comfortable inserting (then discarding) test users
-- into auth.users.
--
--   psql -d awes_backup -f staff_access_probe.sql
--
-- Every check prints PASS or raises an error that names the failed rule.
-- =====================================================================
\set ON_ERROR_STOP 1
begin;

create function pg_temp.ok(p_cond boolean, p_name text) returns void language plpgsql as $$
begin
  if p_cond then raise notice 'PASS  %', p_name;
  else raise exception 'FAIL  %', p_name; end if;
end $$;

-- expects the statement to fail with a message containing p_like
create function pg_temp.fails(p_sql text, p_like text, p_name text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm ilike '%' || p_like || '%' then raise notice 'PASS  % (%)', p_name, sqlerrm; return; end if;
    raise exception 'FAIL  % — wrong error: %', p_name, sqlerrm;
  end;
  raise exception 'FAIL  % — statement succeeded but should have failed', p_name;
end $$;

create function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(p::text, ''), true),
         set_config('request.jwt.claim.role', case when p is null then 'service_role' else 'authenticated' end, true);
$$;

-- ---- fixtures ------------------------------------------------------
insert into auth.users (id, email) values
  ('10000000-0000-0000-0000-0000000000a1', 'probe.admin@local'),
  ('10000000-0000-0000-0000-00000000000a', 'head.pur@staff.awes-app.local'),
  ('10000000-0000-0000-0000-00000000000b', 'sub.pur@staff.awes-app.local'),
  ('10000000-0000-0000-0000-00000000000c', 'sub2@staff.awes-app.local'),
  ('10000000-0000-0000-0000-00000000000d', 'head.fin@staff.awes-app.local'),
  ('10000000-0000-0000-0000-00000000000e', 'tech@awes-app.local');

insert into public.profiles (id, name, role, username) values
  ('10000000-0000-0000-0000-0000000000a1', 'Probe Admin', 'admin',      null),
  ('10000000-0000-0000-0000-00000000000a', 'Head Pur',    'staff',      'probe_headpur'),
  ('10000000-0000-0000-0000-00000000000d', 'Head Fin',    'staff',      'probe_headfin'),
  ('10000000-0000-0000-0000-00000000000e', 'Probe Tech',  'technician', 'probe_tech');

\set H   '''10000000-0000-0000-0000-00000000000a'''
\set S   '''10000000-0000-0000-0000-00000000000b'''
\set S2  '''10000000-0000-0000-0000-00000000000c'''
\set F   '''10000000-0000-0000-0000-00000000000d'''
\set T   '''10000000-0000-0000-0000-00000000000e'''
\set A   '''10000000-0000-0000-0000-0000000000a1'''

select pg_temp.as_user(null);   -- service role, like the Edge Function

select public.staff_apply_access(:H::uuid,
  '[{"id":"purchasing","is_head":true}]',
  '[{"module":"pur.purchase_orders","level":"approve","approve_limit":100000},
    {"module":"pur.suppliers","level":"edit","expires_at":"2099-12-31T00:00:00+08"},
    {"module":"pur.materials","level":"view"}]', :A::uuid);
select public.staff_apply_access(:F::uuid,
  '[{"id":"finance","is_head":true}]',
  '[{"module":"fin.cash_advance","level":"approve"}]', :A::uuid);

-- ---- one level of supervision -------------------------------------
select pg_temp.fails(format($q$insert into public.profiles (id, name, role, supervisor_id) values (%L,'Tech Sub','technician',%L)$q$,
       '10000000-0000-0000-0000-00000000000c', '10000000-0000-0000-0000-00000000000a'),
       'Only staff accounts', 'technician cannot have a supervisor');

insert into public.profiles (id, name, role, username, supervisor_id)
values (:S::uuid, 'Sub Pur', 'staff', 'probe_subpur', :H::uuid);
select pg_temp.ok(true, 'staff sub-user created under a Head');

select pg_temp.fails(format($q$insert into public.profiles (id, name, role, supervisor_id) values (%L,'Sub of Sub','staff',%L)$q$,
       '10000000-0000-0000-0000-00000000000c', '10000000-0000-0000-0000-00000000000b'),
       'One level only', 'sub-user cannot supervise');
select pg_temp.fails(format($q$update public.profiles set supervisor_id = %L where id = %L$q$,
       '10000000-0000-0000-0000-00000000000d', '10000000-0000-0000-0000-00000000000a'),
       'this user has their own sub-users', 'Head with sub-users cannot be placed under a Head');

-- ---- departments ceiling ------------------------------------------
select pg_temp.fails(format($q$select public.staff_apply_access(%L,'[{"id":"purchasing","is_head":true}]','[]',null)$q$,
       '10000000-0000-0000-0000-00000000000b'), 'cannot be a department Head', 'sub-user cannot be Head');
select pg_temp.fails(format($q$select public.staff_apply_access(%L,'[{"id":"finance"}]','[]',null)$q$,
       '10000000-0000-0000-0000-00000000000b'), 'outside the supervisor', 'sub-user limited to Head''s departments');

-- ---- access ceiling -----------------------------------------------
select public.staff_apply_access(:S::uuid, '[{"id":"purchasing"}]',
  '[{"module":"pur.purchase_orders","level":"approve","approve_limit":20000},
    {"module":"pur.suppliers","level":"view","expires_at":"2099-01-01T00:00:00+08"}]', :H::uuid);
select pg_temp.ok(true, 'sub-user granted within ceiling');

select pg_temp.fails(format($q$select public.staff_apply_access(%L,'[{"id":"purchasing"}]','[{"module":"pur.purchase_orders","level":"approve","approve_limit":200000}]',null)$q$,
       '10000000-0000-0000-0000-00000000000b'), 'approval limit', 'limit above Head''s is refused');
select pg_temp.fails(format($q$select public.staff_apply_access(%L,'[{"id":"purchasing"}]','[{"module":"pur.purchase_orders","level":"approve"}]',null)$q$,
       '10000000-0000-0000-0000-00000000000b'), 'approval limit', 'unlimited under a limited Head is refused');
select pg_temp.fails(format($q$select public.staff_apply_access(%L,'[{"id":"purchasing"}]','[{"module":"pur.materials","level":"edit"}]',null)$q$,
       '10000000-0000-0000-0000-00000000000b'), 'above the supervisor''s own level', 'level above Head''s is refused');
select pg_temp.fails(format($q$select public.staff_apply_access(%L,'[{"id":"purchasing"}]','[{"module":"fin.cash_advance","level":"view"}]',null)$q$,
       '10000000-0000-0000-0000-00000000000b'), 'above the supervisor''s own access', 'page the Head lacks is refused');
select pg_temp.fails(format($q$select public.staff_apply_access(%L,'[{"id":"purchasing"}]','[{"module":"pur.suppliers","level":"view"}]',null)$q$,
       '10000000-0000-0000-0000-00000000000b'), 'must end on or before', 'permanent access under an expiring Head is refused');
select pg_temp.fails(format($q$select public.staff_apply_access(%L,'[{"id":"purchasing","is_head":true}]','[{"module":"pur.materials","level":"approve"}]',null)$q$,
       '10000000-0000-0000-0000-00000000000a'), 'has no Approve level', 'Approve refused on a page without approvals');

-- ---- cascade: lowering the Head lowers the sub-user ---------------
update public.staff_access set approve_limit = 10000 where user_id = :H::uuid and module_key = 'pur.purchase_orders';
select pg_temp.ok((select approve_limit from public.staff_access where user_id = :S::uuid and module_key = 'pur.purchase_orders') = 10000,
                  'Head limit lowered → sub-user limit clamped');
update public.staff_access set level = 2 where user_id = :H::uuid and module_key = 'pur.purchase_orders';
select pg_temp.ok((select level = 2 and approve_limit is null from public.staff_access where user_id = :S::uuid and module_key = 'pur.purchase_orders'),
                  'Head lowered to Edit → sub-user lowered to Edit, limit cleared');
delete from public.staff_access where user_id = :H::uuid and module_key = 'pur.suppliers';
select pg_temp.ok(not exists (select 1 from public.staff_access where user_id = :S::uuid and module_key = 'pur.suppliers'),
                  'Head loses a page → sub-user loses it');
update public.staff_access set level = 3, approve_limit = 100000 where user_id = :H::uuid and module_key = 'pur.purchase_orders';
select public.staff_apply_access(:S::uuid, '[{"id":"purchasing"}]',
  '[{"module":"pur.purchase_orders","level":"approve","approve_limit":20000}]', :H::uuid);

-- ---- has_perm / approvals (as the sub-user) -----------------------
select pg_temp.as_user(:S::uuid);
select pg_temp.ok(public.has_perm('pur.purchase_orders','edit'),     'sub-user has Edit on POs');
select pg_temp.ok(public.has_perm('pur.purchase_orders','approve'),  'sub-user has Approve on POs');
select pg_temp.ok(not public.has_perm('fin.cash_advance','view'),    'sub-user has no Finance page');
select pg_temp.ok(not public.can_see_costs(),                        'sub-user cannot see peso values');
select pg_temp.ok(public.staff_approval_check('pur.purchase_orders', 5000, :S::uuid) = 'own_record',  'cannot approve own record');
select pg_temp.ok(public.staff_approval_check('pur.purchase_orders', 50000, :H::uuid) = 'over_limit', 'over peso limit is refused');
select pg_temp.ok(public.staff_approval_check('pur.purchase_orders', 5000, :H::uuid) = 'reauth_required', 'password re-entry required');
select pg_temp.as_user(null); select public.staff_record_reauth(:S::uuid); select pg_temp.as_user(:S::uuid);
select pg_temp.ok(public.staff_approval_check('pur.purchase_orders', 5000, :H::uuid) = 'ok', 'approval passes after re-entry');
select pg_temp.ok((public.my_access()->'access'->'pur.purchase_orders'->>'level') = 'approve', 'my_access() reports the grant');
select pg_temp.ok((public.my_access()->'supervisor'->>'name') = 'Head Pur', 'my_access() reports the supervisor');

-- ---- RLS ----------------------------------------------------------
set local role authenticated;
select pg_temp.ok((select count(distinct user_id) from public.staff_access) = 1, 'sub-user reads only their own access');
select pg_temp.fails($q$insert into public.staff_access (user_id, module_key, level) values ('10000000-0000-0000-0000-00000000000b','fin.cash_advance',3)$q$,
       'permission denied', 'client cannot write staff_access');
select pg_temp.fails($q$select public.staff_apply_access('10000000-0000-0000-0000-00000000000b','[]','[]',null)$q$,
       'permission denied', 'client cannot call staff_apply_access');
reset role;

select pg_temp.as_user(:H::uuid); set local role authenticated;
select pg_temp.ok((select count(distinct user_id) from public.staff_access) = 2, 'Head reads own + sub-user access');
select pg_temp.ok((select count(*) from public.profiles where id = '10000000-0000-0000-0000-00000000000b') = 1, 'Head can read sub-user profile');
select pg_temp.ok((select count(*) from public.profiles where id = '10000000-0000-0000-0000-00000000000d') = 0, 'Head cannot read another Head''s profile');
reset role;

select pg_temp.as_user(:T::uuid); set local role authenticated;
select pg_temp.ok((select count(*) from public.staff_access) = 0, 'technician reads no staff access');
select pg_temp.ok(not public.has_perm('pur.materials','view'), 'technician has no staff pages');
reset role;

select pg_temp.as_user(:A::uuid); set local role authenticated;
select pg_temp.ok((select count(distinct user_id) from public.staff_access) >= 3, 'Super Admin reads all staff access');
select pg_temp.ok(public.has_perm('fin.cash_advance','approve') and public.staff_approval_check('fin.cash_advance', 9e9, :A::uuid) = 'ok',
                  'Super Admin passes every check');
reset role;

-- ---- activity log -------------------------------------------------
select pg_temp.as_user(:S::uuid);
insert into public.announcements (id, title) values (-424242, 'Probe notice');
select pg_temp.ok(exists (select 1 from public.activity_log where actor_id = :S::uuid and entity_type = 'announcements' and action = 'insert'),
                  'insert logged with the real actor');
select pg_temp.as_user(:H::uuid); set local role authenticated;
select pg_temp.ok(exists (select 1 from public.activity_log where actor_id = '10000000-0000-0000-0000-00000000000b'), 'Head reads sub-user''s activity');
select pg_temp.fails($q$delete from public.activity_log$q$, 'permission denied', 'activity log cannot be deleted from the app');
reset role;
select pg_temp.as_user(:S::uuid); set local role authenticated;
select pg_temp.ok(not exists (select 1 from public.activity_log where actor_id = '10000000-0000-0000-0000-00000000000a'), 'sub-user cannot read Head''s activity');
reset role;

-- ---- deactivating the Head switches the sub-user off ---------------
select pg_temp.as_user(null);
update public.profiles set active = false where id = :H::uuid;
select pg_temp.ok((select active from public.profiles where id = :H::uuid) = false, 'service role can deactivate (guard allows it)');
select pg_temp.as_user(:S::uuid);
select pg_temp.ok(not public.has_perm('pur.purchase_orders','view'), 'sub-user of an inactive Head loses access');

-- ---- expiry --------------------------------------------------------
select pg_temp.as_user(null);
update public.profiles set active = true where id = :H::uuid;
update public.staff_access set expires_at = now() - interval '1 minute' where user_id = :S::uuid and module_key = 'pur.purchase_orders';
select pg_temp.as_user(:S::uuid);
select pg_temp.ok(not public.has_perm('pur.purchase_orders','view'), 'expired access stops working');

\echo
\echo 'All staff access probes passed — rolling back.'
rollback;

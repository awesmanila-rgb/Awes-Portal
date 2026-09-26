-- =====================================================================
-- Probe suite for 20260927_01_round2_templates_delegation_dashboards.sql
-- One transaction, rolled back. Prints PASS per check.
--   psql -d awes_backup -f round2_probe.sql
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
create function pg_temp.lvl(p uuid, m text) returns text language sql as $$
  select public.perm_label(level) from public.staff_access where user_id = p and module_key = m $$;

insert into auth.users (id, email) values
  ('d0000000-0000-0000-0000-00000000000a','ra@staff.awes-app.local'),
  ('d0000000-0000-0000-0000-00000000000b','rb@staff.awes-app.local'),
  ('d0000000-0000-0000-0000-00000000000c','rc@staff.awes-app.local'),
  ('d0000000-0000-0000-0000-00000000000d','rd@staff.awes-app.local');
insert into public.profiles (id, name, role, username) values
  ('d0000000-0000-0000-0000-00000000000a','Hector Head','staff','r_head'),
  ('d0000000-0000-0000-0000-00000000000c','Tina Toplevel','staff','r_top'),
  ('d0000000-0000-0000-0000-00000000000d','Other Head','staff','r_head2');
\set H  '''d0000000-0000-0000-0000-00000000000a'''
\set S  '''d0000000-0000-0000-0000-00000000000b'''
\set U  '''d0000000-0000-0000-0000-00000000000c'''
\set H2 '''d0000000-0000-0000-0000-00000000000d'''
\set A  '''00000000-0000-0000-0000-0000000000a1'''
\set T  '''00000000-0000-0000-0000-0000000000b1'''

select pg_temp.as_user(null);
select public.staff_apply_access(:H::uuid, '[{"id":"purchasing","is_head":true},{"id":"finance","is_head":true}]',
  '[{"module":"pur.purchase_orders","level":"approve","approve_limit":50000},{"module":"pur.suppliers","level":"edit"},
    {"module":"fin.cash_advance","level":"approve","approve_limit":10000}]', :A::uuid);
insert into public.profiles (id, name, role, username, supervisor_id) values (:S::uuid, 'Sofia Sub', 'staff', 'r_sub', :H::uuid);
select public.staff_apply_access(:S::uuid, '[{"id":"purchasing"}]', '[{"module":"pur.suppliers","level":"view"}]', :H::uuid);
select public.staff_apply_access(:U::uuid, '[{"id":"purchasing"}]', '[{"module":"pur.materials","level":"view"}]', :A::uuid);
select public.staff_apply_access(:H2::uuid, '[{"id":"hr","is_head":true}]', '[{"module":"hr.leaves","level":"approve"}]', :A::uuid);

-- =========================== Templates ================================
select pg_temp.as_user(:H::uuid);
select pg_temp.fails($q$select public.template_save(null, 'Nope', '', '["purchasing"]', '[]')$q$, 'Only the Super Admin', 'Heads cannot create templates');
select pg_temp.as_user(:A::uuid);
select public.template_save(null, 'Purchasing Clerk', 'Day-to-day purchasing', '["purchasing"]',
  '[{"module":"pur.suppliers","level":"edit"},{"module":"pur.materials","level":"edit"},{"module":"pur.purchase_orders","level":"approve","approve_limit":200000}]') \gset tpl_
select pg_temp.ok(:'tpl_template_save' is not null, 'Super Admin creates a template');
select pg_temp.fails($q$select public.template_save(null, 'Bad', '', '[]', '[{"module":"pur.materials","level":"approve"}]')$q$, 'has no Approve level', 'template rules match page rules');

-- top-level person: full template
select public.template_apply(:U::uuid, :'tpl_template_save'::uuid, true);
select pg_temp.ok(pg_temp.lvl(:U::uuid, 'pur.purchase_orders') = 'approve'
                  and (select approve_limit from public.staff_access where user_id = :U::uuid and module_key = 'pur.purchase_orders') = 200000
                  and pg_temp.lvl(:U::uuid, 'pur.materials') = 'edit', 'template applied to a top-level person in full');
select pg_temp.ok(exists (select 1 from public.staff_template_links where user_id = :U::uuid), 'person is linked to the template');

-- sub-user via their Head: cut to the Head's access
select pg_temp.as_user(:H::uuid);
select public.template_apply(:S::uuid, :'tpl_template_save'::uuid, true);
select pg_temp.ok(pg_temp.lvl(:S::uuid, 'pur.purchase_orders') = 'approve'
                  and (select approve_limit from public.staff_access where user_id = :S::uuid and module_key = 'pur.purchase_orders') = 50000,
                  'sub-user gets the template cut to the Head''s limit (₱200,000 → ₱50,000)');
select pg_temp.ok(pg_temp.lvl(:S::uuid, 'pur.materials') is null, 'sub-user doesn''t get a page the Head lacks (Materials)');
select pg_temp.fails(format($q$select public.template_apply(%L, %L::uuid, true)$q$, 'd0000000-0000-0000-0000-00000000000c', :'tpl_template_save'),
       'your own sub-users', 'a Head can''t apply templates to someone else''s people');

-- editing the template updates everyone linked
select pg_temp.as_user(:A::uuid);
select public.template_save(:'tpl_template_save'::uuid, 'Purchasing Clerk', '', '["purchasing"]',
  '[{"module":"pur.suppliers","level":"view"},{"module":"pur.materials","level":"edit"},{"module":"pur.purchase_orders","level":"edit"}]');
select pg_temp.ok(pg_temp.lvl(:U::uuid, 'pur.purchase_orders') = 'edit' and pg_temp.lvl(:U::uuid, 'pur.suppliers') = 'view',
                  'changing the template updates linked people');
select pg_temp.ok(pg_temp.lvl(:S::uuid, 'pur.purchase_orders') = 'edit', '… including linked sub-users (still within their Head)');

-- deleting a template keeps people's access
select public.template_delete(:'tpl_template_save'::uuid);
select pg_temp.ok(pg_temp.lvl(:U::uuid, 'pur.materials') = 'edit' and not exists (select 1 from public.staff_template_links where user_id = :U::uuid),
                  'deleting a template unlinks people but keeps their access');

-- ========================== Delegation ================================
select pg_temp.as_user(:H::uuid);
select pg_temp.fails(format($q$select public.delegation_create(%L, current_date, current_date + 5, array['pur.purchase_orders'])$q$, 'd0000000-0000-0000-0000-00000000000c'),
       'your own sub-users', 'a Head can only delegate to their own sub-users');
select pg_temp.fails(format($q$select public.delegation_create(%L, current_date, current_date + 5, array['pur.suppliers'])$q$, 'd0000000-0000-0000-0000-00000000000b'),
       'held at Approve', 'only Approve pages can be delegated');
select pg_temp.fails(format($q$select public.delegation_create(%L, current_date, current_date + 120, array['pur.purchase_orders'])$q$, 'd0000000-0000-0000-0000-00000000000b'),
       'at most 90 days', 'delegation is capped at 90 days');

-- future delegation: not active yet
select public.delegation_create(:S::uuid, public.manila_today() + 3, public.manila_today() + 10, array['pur.purchase_orders', 'fin.cash_advance'], 'Away at site') \gset dlg_
select pg_temp.as_user(:S::uuid);
select pg_temp.ok(not public.has_perm('pur.purchase_orders', 'approve'), 'a delegation starting later isn''t active yet');
select pg_temp.as_user(:A::uuid);
update public.staff_delegations set starts_on = public.manila_today() where id = :'dlg_delegation_create'::uuid;

select pg_temp.as_user(:S::uuid);
select pg_temp.ok(public.has_perm('pur.purchase_orders', 'approve'), 'while active: the sub-user can approve POs');
select pg_temp.ok(public.has_perm('fin.cash_advance', 'view'), 'while active: a delegated page they didn''t have is usable');
select pg_temp.ok((public.my_access()->'access'->'pur.purchase_orders'->>'delegated_from') = 'Hector Head', 'my_access() shows whose approval they''re covering');
select pg_temp.ok(public.staff_approval_check('fin.cash_advance', 20000, :T::uuid, false) = 'over_limit', 'delegate works within the Head''s limit (₱10,000)');
select pg_temp.ok(public.staff_approval_check('fin.cash_advance', 5000, :T::uuid, false) = 'ok', 'delegate approves within the limit');
select pg_temp.ok(public.staff_approval_check('fin.cash_advance', 5000, :S::uuid, false) = 'own_record', 'delegate still can''t approve their own record');
select pg_temp.ok(not public.has_perm('pur.materials', 'approve'), 'nothing beyond the delegated pages');

-- Head loses the access → delegation stops giving it
select pg_temp.as_user(null);
select public.staff_apply_access(:H::uuid, '[{"id":"purchasing","is_head":true},{"id":"finance","is_head":true}]',
  '[{"module":"pur.purchase_orders","level":"edit"},{"module":"pur.suppliers","level":"edit"},{"module":"fin.cash_advance","level":"approve","approve_limit":10000}]', :A::uuid);
select pg_temp.as_user(:S::uuid);
select pg_temp.ok(not public.has_perm('pur.purchase_orders', 'approve'), 'Head no longer approves POs → neither does the delegate');
select pg_temp.ok(public.has_perm('fin.cash_advance', 'approve'), '… other delegated pages continue');

-- revoke
select pg_temp.as_user(:S::uuid);
select pg_temp.fails(format($q$select public.delegation_revoke(%L)$q$, :'dlg_delegation_create'), 'Only the person who delegated', 'the delegate can''t end it themselves');
select pg_temp.as_user(:H::uuid);
select public.delegation_revoke(:'dlg_delegation_create'::uuid);
select pg_temp.as_user(:S::uuid);
select pg_temp.ok(not public.has_perm('fin.cash_advance', 'view'), 'ended → access back to normal');

-- expired automatically
select pg_temp.as_user(:A::uuid);
insert into public.staff_delegations (from_user, to_user, starts_on, ends_on, modules, created_by)
values (:H::uuid, :S::uuid, public.manila_today() - 10, public.manila_today() - 1, array['fin.cash_advance'], :A::uuid);
select pg_temp.as_user(:S::uuid);
select pg_temp.ok(not public.has_perm('fin.cash_advance', 'view'), 'a delegation past its end date gives nothing');

-- Super Admin: on behalf of a Head, to anyone active
select pg_temp.as_user(:A::uuid);
select public.delegation_create(:U::uuid, public.manila_today(), public.manila_today() + 2, array['fin.cash_advance'], 'Admin set-up', :H::uuid) \gset adm_
select pg_temp.as_user(:U::uuid);
select pg_temp.ok(public.has_perm('fin.cash_advance', 'approve'), 'Super Admin delegates a Head''s approvals to someone outside their team');
select pg_temp.as_user(:H::uuid);
select pg_temp.fails(format($q$select public.delegation_create(%L, current_date, current_date + 1, array['fin.cash_advance'], '', %L)$q$,
       'd0000000-0000-0000-0000-00000000000b', 'd0000000-0000-0000-0000-00000000000d'), 'your own approvals', 'a Head can''t delegate someone else''s approvals');
select public.delegation_revoke(:'adm_delegation_create'::uuid);
select pg_temp.as_user(:U::uuid);
select pg_temp.ok(not public.has_perm('fin.cash_advance', 'view'), 'the Head can end a delegation the Super Admin made for them');

-- ========================== Dashboards ================================
select pg_temp.as_user(:H::uuid);
select pg_temp.ok((select count(*) from jsonb_array_elements(public.dept_dashboard()) x where x->>'dept' = 'purchasing') >= 1
                  and (select count(*) from jsonb_array_elements(public.dept_dashboard()) x where x->>'dept' = 'finance') >= 1,
                  'Head sees Purchasing and Finance figures');
select pg_temp.ok((select count(*) from jsonb_array_elements(public.dept_dashboard()) x where x->>'dept' in ('hr','operations','administration')) = 0,
                  'no figures for departments they can''t see');
select pg_temp.ok((select bool_and(x->'money' is null or x->>'money' is null) from jsonb_array_elements(public.dept_dashboard()) x where x->>'label' = 'POs issued this month'),
                  'PO value hidden without "See peso values"');
select pg_temp.as_user(:H2::uuid);
select pg_temp.ok((select count(*) from jsonb_array_elements(public.dept_dashboard()) x where x->>'label' = 'Leave requests to decide') = 1,
                  'HR Head sees leave figures');
-- "On leave today" reads the keys the app actually saves (dateFrom / dateTo)
select pg_temp.as_user(:T::uuid); set local role authenticated;
insert into public.leave_requests (id, technician_id, status, submitted_at, data)
values ('d1000000-0000-0000-0000-000000000001', :T::uuid, 'pending', now(),
        jsonb_build_object('dateFrom', public.manila_today() - 1, 'dateTo', public.manila_today() + 1, 'leaveType', 'Sick Leave'));
reset role;
select pg_temp.as_user(:A::uuid); set local role authenticated;
update public.leave_requests set status = 'approved', data = data || '{"status":"approved"}' where id = 'd1000000-0000-0000-0000-000000000001';
reset role;
select pg_temp.as_user(:H2::uuid);
select pg_temp.ok((select (x->>'value')::int >= 1 from jsonb_array_elements(public.dept_dashboard()) x where x->>'label' = 'On leave today'),
                  '"On leave today" counts leave saved by the app (dateFrom / dateTo)');
select pg_temp.as_user(:T::uuid);
select pg_temp.ok(jsonb_array_length(public.dept_dashboard()) = 0, 'technicians get no dashboard figures');
select pg_temp.as_user(:A::uuid);
select pg_temp.ok(jsonb_array_length(public.dept_dashboard()) >= 15, 'Super Admin gets every figure');

\echo
\echo 'All Round 2 probes passed — rolling back.'
rollback;

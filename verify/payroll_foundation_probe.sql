-- =====================================================================
-- Probe for 20261004_01_payroll_foundation.sql — Payroll Rules
-- (draft → publish, frozen versions, audit), Payroll Setup (pay setup,
-- rate history, government IDs), holidays, and who can read what.
-- One transaction, rolled back.   psql -d awes_backup -f payroll_foundation_probe.sql
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
create function pg_temp.seen(p_user uuid, p_sql text) returns bigint language plpgsql as $$
declare n bigint; begin
  perform pg_temp.as_user(p_user); set local role authenticated;
  execute 'select count(*) from (' || p_sql || ') x' into n; reset role; return n; end $$;
create function pg_temp.run(p_user uuid, p_sql text) returns void language plpgsql as $$
begin perform pg_temp.as_user(p_user); set local role authenticated; execute p_sql; reset role; end $$;
create function pg_temp.fails_as(p_user uuid, p_sql text, p_like text, p_name text) returns void language plpgsql as $$
begin
  perform pg_temp.as_user(p_user); set local role authenticated;
  begin execute p_sql;
  exception when others then
    reset role;
    if sqlerrm ilike '%' || p_like || '%' then raise notice 'PASS  % (%)', p_name, sqlerrm; return; end if;
    raise exception 'FAIL  % — wrong error: %', p_name, sqlerrm;
  end;
  reset role;
  raise exception 'FAIL  % — succeeded but should have failed', p_name;
end $$;

\set A  '''00000000-0000-0000-0000-0000000000a1'''
\set T  '''00000000-0000-0000-0000-0000000000b1'''
\set T2 '''00000000-0000-0000-0000-0000000000b2'''
\set HV '''ad000000-0000-0000-0000-00000000000a'''
\set HE '''ad000000-0000-0000-0000-00000000000b'''
\set FE '''ad000000-0000-0000-0000-00000000000c'''
\set FA '''ad000000-0000-0000-0000-00000000000d'''
\set FB '''ad000000-0000-0000-0000-00000000000e'''
\set CU '''ad000000-0000-0000-0000-00000000000f'''

insert into auth.users (id, email) values
  (:HV, 'hv@s'), (:HE, 'he@s'), (:FE, 'fe@s'), (:FA, 'fa@s'), (:FB, 'fb@s'), (:CU, 'cu@s');
insert into public.profiles (id, name, role, username) values
  (:HV, 'Hilda HR View', 'staff', 'pr_hv'), (:HE, 'Hugo HR Edit', 'staff', 'pr_he'),
  (:FE, 'Fe Finance Edit', 'staff', 'pr_fe'), (:FA, 'Faye Finance Approve', 'staff', 'pr_fa'),
  (:FB, 'Fidel Finance Approve', 'staff', 'pr_fb');
insert into public.profiles (id, name, role) values (:CU, 'A Customer', 'customer');

select pg_temp.as_user(null);
select public.staff_apply_access(:HV::uuid, '[{"id":"hr"}]', '[{"module":"hr.payroll_setup","level":"view"}]', :A::uuid);
select public.staff_apply_access(:HE::uuid, '[{"id":"hr"}]', '[{"module":"hr.payroll_setup","level":"edit"}]', :A::uuid);
select public.staff_apply_access(:FE::uuid, '[{"id":"finance"}]', '[{"module":"fin.payroll_rules","level":"edit"}]', :A::uuid);
select public.staff_apply_access(:FA::uuid, '[{"id":"finance"}]', '[{"module":"fin.payroll_rules","level":"approve"}]', :A::uuid);
select public.staff_apply_access(:FB::uuid, '[{"id":"finance"}]', '[{"module":"fin.payroll_rules","level":"approve"}]', :A::uuid);

-- ---- catalog & seed ---------------------------------------------------
select pg_temp.ok((select count(*) = 2 from public.app_modules where key in ('hr.payroll_setup','fin.payroll_rules')), 'both pages are in the access catalog');
select pg_temp.ok((select count(*) = 5 and bool_and(published_at is null) from public.payroll_rules), 'five seeded rules, all drafts');
select pg_temp.ok(not exists (select 1 from public.payroll_rules where public.payroll_rule_problem(kind, config) is not null), 'seeded rules pass the shape check');

-- ---- who can read rules ------------------------------------------------
select pg_temp.ok(pg_temp.seen(:T::uuid,  'select * from public.payroll_rules') = 0, 'technician can''t read payroll rules');
select pg_temp.ok(pg_temp.seen(:CU::uuid, 'select * from public.payroll_rules') = 0, 'customer can''t read payroll rules');
select pg_temp.ok(pg_temp.seen(:HV::uuid, 'select * from public.payroll_rules') = 5, 'Payroll Setup (view) can read the rules');
select pg_temp.ok(pg_temp.seen(:HV::uuid, 'select * from public.payroll_rule_audit') = 0, '… but not the rule audit trail');

-- ---- publishing ---------------------------------------------------------
select pg_temp.fails_as(:HE::uuid, $q$select public.payroll_rule_publish((select id from public.payroll_rules where kind='sss'), 'x')$q$,
  'Approve access', 'Payroll Setup staff can''t publish rules');
select pg_temp.fails_as(:FE::uuid, $q$select public.payroll_rule_publish((select id from public.payroll_rules where kind='sss'), 'x')$q$,
  'Approve access', 'Payroll Rules (edit) can''t publish');
select pg_temp.fails_as(:FA::uuid, $q$select public.payroll_rule_publish((select id from public.payroll_rules where kind='sss'), 'x')$q$,
  'password', 'an approver must re-enter their password');
select public.staff_record_reauth(:FA::uuid);
select pg_temp.fails_as(:FA::uuid, $q$select public.payroll_rule_publish((select id from public.payroll_rules where kind='sss'), '  ')$q$,
  'why', 'publishing needs a reason');
select pg_temp.run(:FA::uuid, $q$select public.payroll_rule_publish((select id from public.payroll_rules where kind='sss'), 'SSS Circular 2024-006')$q$);
select pg_temp.ok((select published_at is not null and published_by = :FA::uuid and version_label = 'SSS-2026-01-01'
                     from public.payroll_rules where kind='sss'), 'approver publishes; label filled in');
select pg_temp.run(:A::uuid, $q$select public.payroll_rule_publish(id, 'Initial setup') from public.payroll_rules where published_at is null$q$);
select pg_temp.ok((select count(*) = 5 from public.payroll_rules where published_at is not null), 'Super Admin publishes the other four');
select pg_temp.ok(pg_temp.seen(:HE::uuid, $q$select * from public.payroll_rules_at('2026-10-15')$q$) = 5, 'payroll_rules_at returns all five rules in force');
select pg_temp.ok(pg_temp.seen(:T::uuid, $q$select * from public.payroll_rules_at('2026-10-15')$q$) = 0, '… and nothing for a technician');

-- ---- published versions are frozen ----------------------------------------
select pg_temp.fails($q$update public.payroll_rules set config = config || '{"employee_rate":0.06}' where kind='sss'$q$,
  'can''t be changed', 'a published version can''t be edited, even directly');
select pg_temp.fails($q$delete from public.payroll_rules where kind='sss'$q$, 'can''t be deleted', 'a published version can''t be deleted');
select pg_temp.fails_as(:FE::uuid, $q$select public.payroll_rule_save_draft((select id from public.payroll_rules where kind='sss'), '{}'::jsonb, null)$q$,
  'can''t be changed', 'save_draft refuses published versions');
select pg_temp.fails_as(:FE::uuid, $q$update public.payroll_rules set notes = 'x'$q$, 'permission denied', 'no direct writes for staff');

-- ---- new version, four-eyes, closing the old one --------------------------
select pg_temp.fails_as(:T::uuid, $q$select public.payroll_rule_new_draft('philhealth', '2027-01-01')$q$, 'Edit access', 'technician can''t start a draft');
select pg_temp.run(:FA::uuid, $q$select public.payroll_rule_new_draft('philhealth', '2027-01-01')$q$);
select pg_temp.fails_as(:FE::uuid, $q$select public.payroll_rule_new_draft('philhealth', '2027-02-01')$q$, 'already a draft', 'only one draft per rule');
select pg_temp.run(:FA::uuid, $q$select public.payroll_rule_save_draft((select id from public.payroll_rules where kind='philhealth' and published_at is null),
   (select config || '{"premium_rate":0.055}' from public.payroll_rules where kind='philhealth' and published_at is null), '2027-01-01', 'PH-2027', 'Circular 2026-99', 'test')$q$);
select pg_temp.fails_as(:FA::uuid, $q$select public.payroll_rule_publish((select id from public.payroll_rules where kind='philhealth' and published_at is null), 'x')$q$,
  'own', 'an approver can''t publish a draft they made');
select public.staff_record_reauth(:FB::uuid);
select pg_temp.run(:FB::uuid, $q$select public.payroll_rule_publish((select id from public.payroll_rules where kind='philhealth' and published_at is null), 'Circular 2026-99')$q$);
select pg_temp.ok((select effective_to = '2026-12-31' from public.payroll_rules where kind='philhealth' and effective_from = '2026-01-01'),
  'publishing closes the old version the day before');
select pg_temp.ok(pg_temp.seen(:HE::uuid, $q$select * from public.payroll_rules_at('2027-03-01') where kind='philhealth' and (config->>'premium_rate')::numeric = 0.055$q$) = 1,
  'the new version is in force from its start date');
select pg_temp.ok(pg_temp.seen(:HE::uuid, $q$select * from public.payroll_rules_at('2026-12-31') where kind='philhealth' and (config->>'premium_rate')::numeric = 0.05$q$) = 1,
  '… and the old one still answers for earlier dates');

select pg_temp.run(:FE::uuid, $q$select public.payroll_rule_new_draft('bir', '2025-12-01')$q$);
select pg_temp.fails_as(:FB::uuid, $q$select public.payroll_rule_publish((select id from public.payroll_rules where kind='bir' and published_at is null), 'x')$q$,
  'has to start after', 'a new version can''t start on or before the current one');
select pg_temp.run(:FE::uuid, $q$select public.payroll_rule_save_draft((select id from public.payroll_rules where kind='bir' and published_at is null),
   (select jsonb_set(config, '{brackets,1,up_to}', '33000') from public.payroll_rules where kind='bir' and published_at is null), '2027-01-01')$q$);
select pg_temp.fails_as(:FB::uuid, $q$select public.payroll_rule_publish((select id from public.payroll_rules where kind='bir' and published_at is null), 'x')$q$,
  'must end where', 'a broken tax table can''t be published');
select pg_temp.run(:FE::uuid, $q$select public.payroll_rule_delete_draft((select id from public.payroll_rules where kind='bir' and published_at is null), 'wrong table')$q$);
select pg_temp.ok(not exists (select 1 from public.payroll_rules where kind='bir' and published_at is null), 'a draft can be deleted');

-- ---- audit ------------------------------------------------------------
select pg_temp.ok((select count(*) from public.payroll_rule_audit where kind='philhealth' and action='published' and reason='Circular 2026-99' and actor_id = :FB::uuid) = 1,
  'audit records who published and why');
select pg_temp.ok(exists (select 1 from public.payroll_rule_audit where kind='philhealth' and action='closed'), 'audit records the closed version');
select pg_temp.ok(exists (select 1 from public.payroll_rule_audit where kind='bir' and action='draft_deleted' and reason='wrong table' and actor_name='Fe Finance Edit'),
  'audit records deleted drafts with the reason');
select pg_temp.ok(pg_temp.seen(:FE::uuid, 'select * from public.payroll_rule_audit') > 0, 'Payroll Rules staff can read the audit trail');
select pg_temp.fails($q$delete from public.payroll_rule_audit$q$, 'append-only', 'the audit trail can''t be deleted');

-- ---- pay setup --------------------------------------------------------
select pg_temp.fails_as(:HV::uuid, $q$insert into public.payroll_employees (profile_id, base_rate) values ('00000000-0000-0000-0000-0000000000b1', 695)$q$,
  'row-level security', 'Payroll Setup (view) can''t add pay setup');
select pg_temp.run(:HE::uuid, $q$insert into public.payroll_employees (profile_id, employee_no, rate_type, base_rate, rest_days) values
  ('00000000-0000-0000-0000-0000000000b1', 'E-001', 'DAILY', 695, '{0,0}'),
  ('00000000-0000-0000-0000-0000000000b2', 'E-002', 'DAILY', 720, '{0}'),
  ('ad000000-0000-0000-0000-00000000000c', 'E-003', 'MONTHLY', 28000, '{0,6}')$q$);
select pg_temp.ok((select rest_days = '{0}' and created_by = :HE::uuid from public.payroll_employees where profile_id = :T::uuid), 'rest days tidied; creator stamped');
select pg_temp.fails_as(:HE::uuid, $q$insert into public.payroll_employees (profile_id, base_rate) values ('00000000-0000-0000-0000-0000000000a1', 1)$q$,
  'technicians and office staff', 'the Super Admin account can''t be put on payroll');
select pg_temp.fails_as(:HE::uuid, $q$insert into public.payroll_employees (profile_id, base_rate) values ('ad000000-0000-0000-0000-00000000000f', 1)$q$,
  'technicians and office staff', 'customers can''t be put on payroll');
select pg_temp.fails_as(:HE::uuid, $q$insert into public.payroll_employees (profile_id, base_rate, employee_no) values ('00000000-0000-0000-0000-0000000000b3', 1, 'e-001')$q$,
  'duplicate', 'employee numbers are unique');
select pg_temp.fails_as(:HE::uuid, $q$update public.payroll_employees set is_mwe = true where profile_id = '00000000-0000-0000-0000-0000000000b1'$q$,
  'check constraint', 'a minimum wage earner needs the regional minimum wage');
select pg_temp.run(:HE::uuid, $q$update public.payroll_employees set base_rate = 710 where profile_id = '00000000-0000-0000-0000-0000000000b1'$q$);
select pg_temp.run(:HE::uuid, $q$update public.payroll_employees set notes = 'no rate change' where profile_id = '00000000-0000-0000-0000-0000000000b1'$q$);
select pg_temp.ok((select count(*) = 2 and max(base_rate) = 710 from public.payroll_rate_history where profile_id = :T::uuid), 'rate history keeps each rate change (and only those)');
select pg_temp.fails($q$update public.payroll_rate_history set base_rate = 1$q$, 'append-only', 'rate history can''t be edited');

select pg_temp.ok(pg_temp.seen(:T::uuid,  'select * from public.payroll_employees') = 1, 'a technician sees only their own pay setup');
select pg_temp.ok(pg_temp.seen(:FE::uuid, 'select * from public.payroll_employees') = 1, 'an office staff member sees only their own pay setup');
select pg_temp.ok(pg_temp.seen(:T::uuid,  'select * from public.payroll_rate_history') = 2, '… and their own rate history');
select pg_temp.ok(pg_temp.seen(:HV::uuid, 'select * from public.payroll_employees') = 3, 'Payroll Setup (view) sees everyone''s pay setup');
select pg_temp.ok(pg_temp.seen(:HV::uuid, $q$select * from public.profiles where id in ('ad000000-0000-0000-0000-00000000000c','00000000-0000-0000-0000-0000000000b3')$q$) = 2,
  'Payroll Setup can read office staff and technician names');
select pg_temp.ok(pg_temp.seen(:HV::uuid, $q$select * from public.profiles where role in ('admin','customer')$q$) = 0, '… but not the admin''s or customers''');

-- ---- government IDs ------------------------------------------------------
select pg_temp.run(:HE::uuid, $q$insert into public.payroll_gov_ids (profile_id, tin, sss_no) values
  ('00000000-0000-0000-0000-0000000000b1', ' 123-456-789 ', '34-1234567-8'), ('00000000-0000-0000-0000-0000000000b2', '', '')$q$);
select pg_temp.ok((select tin = '123-456-789' from public.payroll_gov_ids where profile_id = :T::uuid), 'IDs are trimmed');
select pg_temp.ok(pg_temp.seen(:HV::uuid, 'select * from public.payroll_gov_ids') = 0, 'Payroll Setup (view) can''t read government IDs');
select pg_temp.ok(pg_temp.seen(:HE::uuid, 'select * from public.payroll_gov_ids') = 2, 'Payroll Setup (edit) can');
select pg_temp.ok(pg_temp.seen(:T::uuid,  'select * from public.payroll_gov_ids') = 1, 'a technician sees only their own IDs');
select pg_temp.ok(pg_temp.seen(:T2::uuid, $q$select * from public.payroll_gov_ids where profile_id = '00000000-0000-0000-0000-0000000000b1'$q$) = 0,
  '… never someone else''s');
select pg_temp.run(:T::uuid, $q$update public.payroll_gov_ids set tin = '999' where profile_id = '00000000-0000-0000-0000-0000000000b1'$q$);
select pg_temp.ok((select tin = '123-456-789' from public.payroll_gov_ids where profile_id = :T::uuid), 'a technician can''t change their own IDs');
select pg_temp.ok(not exists (select 1 from public.activity_log where entity_type = 'payroll_gov_ids'), 'government IDs are kept out of the activity log');
select pg_temp.ok(exists (select 1 from public.activity_log where entity_type = 'payroll_employees'), 'pay setup changes are in the activity log');

-- ---- holidays --------------------------------------------------------
select pg_temp.fails_as(:HV::uuid, $q$select public.payroll_holidays_prefill(2027)$q$, 'Edit access', 'Payroll Setup (view) can''t pre-fill holidays');
select pg_temp.run(:HE::uuid, $q$select public.payroll_holidays_prefill(2027)$q$);
select pg_temp.ok((select count(*) = 11 from public.payroll_holidays where extract(year from holiday_date) = 2027), 'pre-fill adds the 11 fixed-date holidays');
select pg_temp.run(:HE::uuid, $q$select public.payroll_holidays_prefill(2027)$q$);
select pg_temp.ok((select count(*) = 11 from public.payroll_holidays where extract(year from holiday_date) = 2027), 'running it again adds nothing');
select pg_temp.run(:HE::uuid, $q$insert into public.payroll_holidays (holiday_date, name, kind, scope) values ('2027-08-19', 'Quezon City Day', 'SPECIAL_NON_WORKING', 'Quezon City')$q$);
select pg_temp.ok(pg_temp.seen(:T::uuid,  'select * from public.payroll_holidays') = 12, 'technicians can see the holiday calendar');
select pg_temp.ok(pg_temp.seen(:CU::uuid, 'select * from public.payroll_holidays') = 0, 'customers can''t');
select pg_temp.run(:T::uuid, $q$delete from public.payroll_holidays$q$);
select pg_temp.ok((select count(*) = 12 from public.payroll_holidays), '… and nothing was deleted');

-- ---- settings --------------------------------------------------------
select pg_temp.run(:HE::uuid, $q$update public.payroll_settings set grace_minutes = 10$q$);
select pg_temp.ok((select grace_minutes = 10 from public.payroll_settings), 'Payroll Setup (edit) changes company payroll settings');
select pg_temp.run(:HV::uuid, $q$update public.payroll_settings set grace_minutes = 99$q$);
select pg_temp.ok((select grace_minutes = 10 from public.payroll_settings), '… view access can''t');

rollback;

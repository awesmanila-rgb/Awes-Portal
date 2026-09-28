-- =====================================================================
-- AWES App — Inventory pages move from Purchasing to Administration
--
-- The eight Inventory pages (Stock on Hand, Warehouses, Receive, Issue,
-- Returns, Transfers, Slips & History, Inventory Reports) now belong to the
-- Administration department, like the Super Admin's sidebar. From now on
-- the Administration Head manages who gets them.
--
-- Nobody gains or loses a page:
--   * a top-level staff member who holds any Inventory page joins
--     Administration — as its HEAD if they head Purchasing or if one of
--     their sub-users holds an Inventory page (so they keep managing
--     exactly what they manage today), otherwise as a member;
--   * a sub-user who holds an Inventory page joins Administration under
--     their Head;
--   * existing Purchasing memberships stay (remove any that are no longer
--     needed from Department Staff);
--   * role templates with Inventory pages gain the Administration
--     department;
--   * the Inbox item "Issued PO not yet received" (Receive page) is now an
--     Administration item, so its escalation goes to Administration Heads.
--
-- Requires 20260926_01 … 20261001_01. Safe to re-run: people are moved only
-- the first time (recorded in app_one_time_steps).
-- =====================================================================

begin;

do $$ begin
  if to_regclass('public.request_endorsements') is null then
    raise exception 'Run the earlier migrations (20260926_01 … 20261001_01) first.';
  end if;
end $$;

-- The move itself (a function so the verify probe runs exactly this code)
create or replace function public.inventory_move_to_administration()
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $fn$
declare n_heads int; n_members int; n_subs int; n_tpl int;
begin
  -- 1. The catalog
  update public.app_modules m set department = 'administration', section = 'Inventory', sort = v.sort
    from (values ('inv.stock', 54), ('inv.warehouses', 55), ('inv.receive', 56), ('inv.issue', 57),
                 ('inv.returns', 58), ('inv.transfers', 59), ('inv.slips', 60), ('inv.reports', 61)) v(key, sort)
   where m.key = v.key and (m.department is distinct from 'administration' or m.sort is distinct from v.sort);

  -- 2. Top-level staff holding an Inventory page (Heads first, so their
  --    sub-users can follow)
  insert into public.staff_departments (user_id, department_id, is_head)
  select p.id, 'administration',
         exists (select 1 from public.staff_departments d where d.user_id = p.id and d.department_id = 'purchasing' and d.is_head)
         or exists (select 1 from public.profiles s join public.staff_access sa on sa.user_id = s.id and sa.module_key like 'inv.%'
                     where s.supervisor_id = p.id)
    from public.profiles p
   where p.role = 'staff' and p.supervisor_id is null
     and exists (select 1 from public.staff_access a where a.user_id = p.id and a.module_key like 'inv.%')
  on conflict (user_id, department_id) do update
     set is_head = public.staff_departments.is_head or excluded.is_head;

  -- 3. Sub-users holding an Inventory page
  insert into public.staff_departments (user_id, department_id, is_head)
  select p.id, 'administration', false
    from public.profiles p
   where p.role = 'staff' and p.supervisor_id is not null
     and exists (select 1 from public.staff_access a where a.user_id = p.id and a.module_key like 'inv.%')
  on conflict (user_id, department_id) do nothing;

  -- 4. Role templates
  update public.access_templates t
     set departments = t.departments || '["administration"]'::jsonb, updated_at = now()
   where not (t.departments ? 'administration')
     and exists (select 1 from jsonb_array_elements(t.access) a where a->>'module' like 'inv.%');

  -- 5. Inbox: "Issued PO not yet received"
  update public.inbox_sla set department = 'administration' where kind = 'po_receive' and department is distinct from 'administration';

  select count(*) filter (where is_head), count(*) filter (where not is_head) into n_heads, n_members
    from public.staff_departments where department_id = 'administration';
  return jsonb_build_object('administration_heads', n_heads, 'administration_members', n_members);
end;
$fn$;
revoke execute on function public.inventory_move_to_administration() from public, anon, authenticated;
grant execute on function public.inventory_move_to_administration() to service_role;

-- Move people ONCE per database: re-running this migration later must not
-- re-add Administration memberships or Head roles you've since changed.
create table if not exists public.app_one_time_steps (
  step     text primary key,
  done_at  timestamptz not null default now(),
  result   jsonb
);
alter table public.app_one_time_steps enable row level security;
revoke all on public.app_one_time_steps from anon, authenticated;

create or replace function public.inventory_move_once()
returns boolean
language plpgsql security definer
set search_path = public, pg_temp
as $fn$
declare r jsonb;
begin
  -- the catalog and the Inbox item always follow the current layout
  update public.app_modules m set department = 'administration', section = 'Inventory', sort = v.sort
    from (values ('inv.stock', 54), ('inv.warehouses', 55), ('inv.receive', 56), ('inv.issue', 57),
                 ('inv.returns', 58), ('inv.transfers', 59), ('inv.slips', 60), ('inv.reports', 61)) v(key, sort)
   where m.key = v.key and (m.department is distinct from 'administration' or m.sort is distinct from v.sort);
  update public.inbox_sla set department = 'administration' where kind = 'po_receive' and department is distinct from 'administration';
  if exists (select 1 from public.app_one_time_steps where step = 'inventory_to_administration') then return false; end if;
  r := public.inventory_move_to_administration();
  insert into public.app_one_time_steps (step, result) values ('inventory_to_administration', r);
  return true;
end;
$fn$;
revoke execute on function public.inventory_move_once() from public, anon, authenticated;
grant execute on function public.inventory_move_once() to service_role;

select public.inventory_move_once();

-- 6. A line in the Activity Log
do $$ begin
  perform public.log_activity_as(null, 'catalog.move', 'app_modules', 'inv.*', 'Inventory → Administration',
    jsonb_build_object('staff_in_administration', (select count(*) from public.staff_departments where department_id = 'administration')));
exception when others then null;   -- logging is best-effort
end $$;

commit;

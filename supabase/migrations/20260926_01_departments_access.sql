-- =====================================================================
-- AWES App — Department staff accounts: foundation (Round 1, Phase 1)
--
-- WHAT THIS ADDS
--   * A new profiles.role value, 'staff', for department users. The
--     existing 'admin' account is the Super Admin; is_admin() keeps
--     meaning "full access", so nothing that works today changes.
--   * departments (the 5 departments) and app_modules (one row per page,
--     with its default department) as a fixed catalog.
--   * staff_departments  — which departments a user belongs to, and
--                          whether they are that department's Head.
--   * staff_access       — per page: View / Edit / Approve, an optional
--                          peso approval limit, an optional expiry date.
--   * One level of supervision: profiles.supervisor_id points a sub-user
--     at their Head. A sub-user can never be a Head or have sub-users.
--   * The ceiling rule, enforced HERE in the database, not only in the
--     screens: a sub-user's access can never exceed their Head's, and
--     lowering or removing a Head's access lowers or removes it for the
--     Head's sub-users automatically.
--   * Approval helpers: staff_approval_check() applies the approval level,
--     the peso limit, "no approving your own record", and a recent
--     password re-entry. (Wired into each approve action in Phase 3.)
--   * activity_log — append-only record of who created / changed /
--     deleted what, starting from the moment this migration runs.
--   * po_signatories.user_id — links a PO signatory to a staff login, so
--     approvals can stamp that person's e-signature automatically later.
--
-- WHAT THIS DOES NOT DO YET
--   No existing page is opened to staff yet. Every existing RLS policy
--   still says is_admin(); Phase 3 changes those, one department at a
--   time. Until then a staff login can sign in but sees no business data.
--
-- Additive and idempotent: safe to run more than once.
-- Requires: admin-create-staff Edge Function deployed after this runs.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. profiles: new role + supervision columns
-- ---------------------------------------------------------------------
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role = any (array['admin','technician','customer','staff']));

alter table public.profiles add column if not exists supervisor_id  uuid references public.profiles(id) on delete set null;
alter table public.profiles add column if not exists position       text not null default '';
alter table public.profiles add column if not exists created_by     uuid references public.profiles(id) on delete set null;
alter table public.profiles add column if not exists deactivated_at timestamptz;
alter table public.profiles add column if not exists deactivated_by uuid references public.profiles(id) on delete set null;

create index if not exists profiles_supervisor_idx on public.profiles (supervisor_id) where supervisor_id is not null;
create index if not exists profiles_role_idx       on public.profiles (role);

-- The privilege guard used to revert role/active changes made by the
-- service role too (auth.uid() is null there, so is_admin() is false),
-- which would have silently undone every change admin-create-staff makes.
-- Now: admin and the service role pass; everyone else can't touch any
-- privilege column, including the new supervision columns.
create or replace function public.guard_profile_privileges()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.is_admin() or auth.role() = 'service_role' then
    return new;
  end if;
  new.id             := old.id;
  new.role           := old.role;
  new.active         := old.active;
  new.no_history     := old.no_history;
  new.no_report      := old.no_report;
  new.read_only      := old.read_only;
  new.created_at     := old.created_at;
  new.username       := old.username;
  new.supervisor_id  := old.supervisor_id;
  new.created_by     := old.created_by;
  new.deactivated_at := old.deactivated_at;
  new.deactivated_by := old.deactivated_by;
  return new;
end;
$$;


-- ---------------------------------------------------------------------
-- 2. Catalog: departments + pages
-- ---------------------------------------------------------------------
create table if not exists public.departments (
  id    text primary key,
  name  text not null,
  sort  int  not null default 0
);

insert into public.departments (id, name, sort) values
  ('purchasing',     'Purchasing',           1),
  ('finance',        'Accounting & Finance', 2),
  ('hr',             'Human Resources',      3),
  ('administration', 'Administration',       4),
  ('operations',     'Operations',           5)
on conflict (id) do update set name = excluded.name, sort = excluded.sort;

-- key          stable id the app and RLS use (never rename one)
-- department   default department — only decides where the page is shown
--              on the access screen; it does not limit who can get it
-- approvable   page has an Approve action (Approve level allowed)
-- has_limit    approvals carry a peso amount (approval limit allowed)
-- is_switch    on/off only (e.g. "See peso values"), stored as level 1
create table if not exists public.app_modules (
  key         text primary key,
  department  text not null references public.departments(id),
  section     text not null default '',
  label       text not null,
  sort        int  not null default 0,
  approvable  boolean not null default false,
  has_limit   boolean not null default false,
  is_switch   boolean not null default false,
  check (not has_limit or approvable)
);

insert into public.app_modules (key, department, section, label, sort, approvable, has_limit, is_switch) values
  -- Purchasing
  ('pur.materials',       'purchasing',     'Purchasing', 'Materials Database',          10, false, false, false),
  ('pur.suppliers',       'purchasing',     'Purchasing', 'Supplier Database',           11, false, false, false),
  ('pur.requisitions',    'purchasing',     'Purchasing', 'Material Requisition',        12, true,  false, false),
  ('pur.purchase_orders', 'purchasing',     'Purchasing', 'Purchase Orders',             13, true,  true,  false),
  ('inv.stock',           'purchasing',     'Inventory',  'Stock on Hand',               20, false, false, false),
  ('inv.warehouses',      'purchasing',     'Inventory',  'Warehouses',                  21, false, false, false),
  ('inv.receive',         'purchasing',     'Inventory',  'Receive Stock',               22, false, false, false),
  ('inv.issue',           'purchasing',     'Inventory',  'Issue to Worker',             23, false, false, false),
  ('inv.returns',         'purchasing',     'Inventory',  'Returns',                     24, false, false, false),
  ('inv.transfers',       'purchasing',     'Inventory',  'Transfers',                   25, false, false, false),
  ('inv.slips',           'purchasing',     'Inventory',  'Slips & History',             26, false, false, false),
  ('inv.reports',         'purchasing',     'Inventory',  'Inventory Reports',           27, false, false, false),
  -- Accounting & Finance
  ('fin.cash_advance',    'finance',        'Finance',    'Cash Advance',                30, true,  true,  false),
  ('fin.liquidation',     'finance',        'Finance',    'Liquidation',                 31, true,  true,  false),
  ('fin.reimbursement',   'finance',        'Finance',    'Reimbursement',               32, true,  true,  false),
  ('fin.costs',           'finance',        'Finance',    'See peso values',             33, false, false, true),
  -- Human Resources
  ('hr.attendance',       'hr',             'HR',         'Attendance (DTR)',            40, false, false, false),
  ('hr.leaves',           'hr',             'HR',         'Leave Requests',              41, true,  false, false),
  ('hr.tech_profiles',    'hr',             'HR',         'Technician Profiles',         42, false, false, false),
  -- Administration
  ('adm.customers',       'administration', 'Administration', 'Customers',               50, false, false, false),
  ('adm.equipment',       'administration', 'Administration', 'Customer Equipment',      51, false, false, false),
  ('adm.announcements',   'administration', 'Administration', 'Announcements',           52, false, false, false),
  ('adm.dropdowns',       'administration', 'Administration', 'Dropdown Lists',          53, false, false, false),
  -- Operations
  ('ops.dispatch',        'operations',     'Operations', 'Dispatch / Job Orders',       60, false, false, false),
  ('ops.service_requests','operations',     'Operations', 'Service Requests',            61, false, false, false),
  ('ops.service_reports', 'operations',     'Operations', 'Service Reports',             62, false, false, false),
  ('ops.past_service',    'operations',     'Operations', 'Record Past Service',         63, false, false, false),
  ('ops.tracker',         'operations',     'Operations', 'Live Tracker',                64, false, false, false),
  ('ops.projects',        'operations',     'Operations', 'Projects',                    65, false, false, false),
  ('tools.register',      'operations',     'Tools & Equipment', 'Tool Register',        70, false, false, false),
  ('tools.issue',         'operations',     'Tools & Equipment', 'Issue Tools',          71, false, false, false),
  ('tools.return',        'operations',     'Tools & Equipment', 'Return Tools',         72, false, false, false),
  ('tools.handover',      'operations',     'Tools & Equipment', 'Handover',             73, false, false, false),
  ('tools.defects',       'operations',     'Tools & Equipment', 'Defect Reports',       74, false, false, false),
  ('tools.maintenance',   'operations',     'Tools & Equipment', 'Calibration & Inspection', 75, false, false, false),
  ('tools.slips',         'operations',     'Tools & Equipment', 'Tool Slips',           76, false, false, false),
  ('tools.reports',       'operations',     'Tools & Equipment', 'Tool Reports',         77, false, false, false)
on conflict (key) do update set
  department = excluded.department, section = excluded.section, label = excluded.label,
  sort = excluded.sort, approvable = excluded.approvable,
  has_limit = excluded.has_limit, is_switch = excluded.is_switch;
-- Super Admin only, deliberately NOT in the catalog: Users & Roles,
-- Settings, company/PO settings, the admin password.


-- ---------------------------------------------------------------------
-- 3. Membership, access, re-auth, activity log
-- ---------------------------------------------------------------------
create table if not exists public.staff_departments (
  user_id        uuid not null references public.profiles(id) on delete cascade,
  department_id  text not null references public.departments(id),
  is_head        boolean not null default false,
  created_at     timestamptz not null default now(),
  primary key (user_id, department_id)
);

-- level: 1 = View, 2 = Edit, 3 = Approve (each includes the ones below)
create table if not exists public.staff_access (
  user_id        uuid not null references public.profiles(id) on delete cascade,
  module_key     text not null references public.app_modules(key),
  level          smallint not null check (level between 1 and 3),
  approve_limit  numeric(14,2) check (approve_limit is null or approve_limit >= 0),  -- null = no peso ceiling of its own
  expires_at     timestamptz,                                                          -- null = permanent
  granted_by     uuid references public.profiles(id) on delete set null,
  granted_at     timestamptz not null default now(),
  primary key (user_id, module_key)
);
create index if not exists staff_access_module_idx on public.staff_access (module_key);

-- One row per user: last successful password re-entry (for approvals).
create table if not exists public.staff_reauth (
  user_id      uuid primary key references public.profiles(id) on delete cascade,
  verified_at  timestamptz not null default now()
);

create table if not exists public.activity_log (
  id            bigint generated always as identity primary key,
  at            timestamptz not null default now(),
  actor_id      uuid,                 -- null = system (cron, service jobs)
  actor_name    text not null default '',
  actor_role    text not null default '',
  action        text not null,        -- insert | update | delete | staff.create | …
  entity_type   text not null,        -- table name, or 'staff'
  entity_id     text,
  entity_label  text not null default '',
  details       jsonb not null default '{}'::jsonb
);
create index if not exists activity_log_at_idx     on public.activity_log (at desc);
create index if not exists activity_log_actor_idx  on public.activity_log (actor_id, at desc);
create index if not exists activity_log_entity_idx on public.activity_log (entity_type, entity_id, at desc);


-- ---------------------------------------------------------------------
-- 4. Helper functions
-- ---------------------------------------------------------------------
create or replace function public.perm_rank(p_level text)
returns smallint language sql immutable as $$
  select case lower(coalesce(p_level,''))
           when 'view' then 1 when 'edit' then 2 when 'approve' then 3
           else null end::smallint;
$$;

create or replace function public.perm_label(p_level smallint)
returns text language sql immutable as $$
  select case p_level when 1 then 'view' when 2 then 'edit' when 3 then 'approve' end;
$$;

-- An active staff login whose supervisor (if any) is also active.
create or replace function public.staff_is_active(p_user uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = p_user and p.role = 'staff' and p.active
      and (p.supervisor_id is null or exists (
            select 1 from public.profiles s where s.id = p.supervisor_id and s.active))
  );
$$;

create or replace function public.is_staff()
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$ select public.staff_is_active(auth.uid()); $$;

-- true if the CALLER is the Head directly above p_user
create or replace function public.is_supervisor_of(p_user uuid)
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1 from public.profiles where id = p_user and supervisor_id = auth.uid());
$$;

-- The one check RLS policies will use from Phase 3 on.
-- Super Admin always passes. Staff pass when they hold the page at the
-- given level or higher, the grant hasn't expired, and they're active.
-- Round 2 (20260927_01) installs a newer has_perm() (delegation-aware); re-running
-- this migration after it must not put this older version back.
do $guard$ begin
  if to_regclass('public.staff_delegations') is null then
    execute $ddl$
create or replace function public.has_perm(p_module text, p_level text default 'view')
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $body$
  select public.is_admin() or (
    public.staff_is_active(auth.uid()) and exists (
      select 1 from public.staff_access a
      where a.user_id = auth.uid()
        and a.module_key = p_module
        and a.level >= coalesce(public.perm_rank(p_level), 1)
        and (a.expires_at is null or a.expires_at > now())
    )
  );
$body$;
    $ddl$;
  end if;
end $guard$;

create or replace function public.can_see_costs()
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$ select public.has_perm('fin.costs', 'view'); $$;

create or replace function public.recently_reauthed(p_minutes int default 5)
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.staff_reauth
                 where user_id = auth.uid()
                   and verified_at > now() - make_interval(mins => greatest(p_minutes, 1)));
$$;

-- Returns 'ok' or the reason an approval is refused:
--   not_staff | no_approve_access | own_record | over_limit | reauth_required
-- Super Admin is exempt from every rule here (including own-record),
-- otherwise nobody could approve a PO the Super Admin prepared.
-- Round 2 (20260927_01) installs a newer staff_approval_check() (delegation-aware); re-running
-- this migration after it must not put this older version back.
do $guard$ begin
  if to_regclass('public.staff_delegations') is null then
    execute $ddl$
create or replace function public.staff_approval_check(
  p_module          text,
  p_amount          numeric default null,
  p_creator         uuid    default null,
  p_require_reauth  boolean default true
) returns text
language plpgsql stable security definer
set search_path = public, pg_temp
as $body$
declare a public.staff_access;
begin
  if public.is_admin() then return 'ok'; end if;
  if not public.staff_is_active(auth.uid()) then return 'not_staff'; end if;

  select * into a from public.staff_access
   where user_id = auth.uid() and module_key = p_module;
  if not found or a.level < 3 or (a.expires_at is not null and a.expires_at <= now()) then
    return 'no_approve_access';
  end if;
  if p_creator is not null and p_creator = auth.uid() then return 'own_record'; end if;
  if a.approve_limit is not null and p_amount is not null and p_amount > a.approve_limit then
    return 'over_limit';
  end if;
  if p_require_reauth and not public.recently_reauthed(5) then return 'reauth_required'; end if;
  return 'ok';
end;
$body$;
    $ddl$;
  end if;
end $guard$;

create or replace function public.staff_can_approve(
  p_module text, p_amount numeric default null, p_creator uuid default null
) returns boolean language sql stable
set search_path = public, pg_temp
as $$ select public.staff_approval_check(p_module, p_amount, p_creator, true) = 'ok'; $$;

-- Everything the app needs at sign-in to build the sidebar and screens.
-- Round 2 (20260927_01) installs a newer my_access() (delegation-aware); re-running
-- this migration after it must not put this older version back.
do $guard$ begin
  if to_regclass('public.staff_delegations') is null then
    execute $ddl$
create or replace function public.my_access()
returns jsonb
language sql stable security definer
set search_path = public, pg_temp
as $body$
  select jsonb_build_object(
    'user_id',       p.id,
    'role',          p.role,
    'is_superadmin', p.role = 'admin',
    'active',        coalesce(public.staff_is_active(p.id), false) or p.role = 'admin',
    'position',      p.position,
    'is_head',       exists (select 1 from public.staff_departments d where d.user_id = p.id and d.is_head),
    'supervisor',    (select jsonb_build_object('id', s.id, 'name', s.name)
                        from public.profiles s where s.id = p.supervisor_id),
    'departments',   coalesce((select jsonb_agg(jsonb_build_object('id', d.department_id, 'name', dep.name, 'is_head', d.is_head) order by dep.sort)
                                 from public.staff_departments d join public.departments dep on dep.id = d.department_id
                                where d.user_id = p.id), '[]'::jsonb),
    'access',        coalesce((select jsonb_object_agg(a.module_key, jsonb_build_object(
                                         'level', public.perm_label(a.level),
                                         'approve_limit', a.approve_limit,
                                         'expires_at', a.expires_at))
                                 from public.staff_access a
                                where a.user_id = p.id and (a.expires_at is null or a.expires_at > now())), '{}'::jsonb),
    'see_costs',     p.role = 'admin' or exists (select 1 from public.staff_access a
                                where a.user_id = p.id and a.module_key = 'fin.costs'
                                  and (a.expires_at is null or a.expires_at > now()))
  )
  from public.profiles p
  where p.id = auth.uid();
$body$;
    $ddl$;
  end if;
end $guard$;


-- ---------------------------------------------------------------------
-- 5. Integrity: one level of supervision + the ceiling rule
-- ---------------------------------------------------------------------

-- 5a. profiles: who may be a supervisor / a sub-user
create or replace function public.staff_guard_supervision()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare s public.profiles;
begin
  if new.supervisor_id is null then return new; end if;
  if new.role is distinct from 'staff' then
    raise exception 'Only staff accounts can have a supervisor';
  end if;
  if new.supervisor_id = new.id then
    raise exception 'A user cannot supervise themselves';
  end if;
  select * into s from public.profiles where id = new.supervisor_id;
  if not found or s.role <> 'staff' or not s.active then
    raise exception 'The supervisor must be an active staff account';
  end if;
  if s.supervisor_id is not null then
    raise exception 'One level only: a sub-user cannot supervise other users';
  end if;
  if not exists (select 1 from public.staff_departments where user_id = s.id and is_head) then
    raise exception 'The supervisor must be a department Head';
  end if;
  if exists (select 1 from public.profiles where supervisor_id = new.id) then
    raise exception 'One level only: this user has their own sub-users, so they cannot be placed under a Head';
  end if;
  if exists (select 1 from public.staff_departments where user_id = new.id and is_head) then
    raise exception 'A department Head cannot be placed under another Head';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_staff_guard_supervision on public.profiles;
create trigger trg_staff_guard_supervision
  before insert or update of supervisor_id, role on public.profiles
  for each row execute function public.staff_guard_supervision();

-- 5b. Bring a sub-user's departments and access within their (new) Head's.
create or replace function public.staff_clamp_to_supervisor(p_user uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_sup uuid;
begin
  select supervisor_id into v_sup from public.profiles where id = p_user;
  if v_sup is null then return; end if;

  delete from public.staff_departments d
   where d.user_id = p_user
     and not exists (select 1 from public.staff_departments h
                      where h.user_id = v_sup and h.department_id = d.department_id and h.is_head);

  delete from public.staff_access a
   where a.user_id = p_user
     and not exists (select 1 from public.staff_access h
                      where h.user_id = v_sup and h.module_key = a.module_key
                        and (h.expires_at is null or h.expires_at > now()));

  update public.staff_access a set
    level         = least(a.level, h.level),
    approve_limit = case when h.approve_limit is null then a.approve_limit
                         else least(coalesce(a.approve_limit, h.approve_limit), h.approve_limit) end,
    expires_at    = case when h.expires_at is null then a.expires_at
                         else least(coalesce(a.expires_at, h.expires_at), h.expires_at) end
    from public.staff_access h
   where a.user_id = p_user and h.user_id = v_sup and h.module_key = a.module_key
     and (a.level > h.level
          or (h.approve_limit is not null and (a.approve_limit is null or a.approve_limit > h.approve_limit))
          or (h.expires_at   is not null and (a.expires_at   is null or a.expires_at   > h.expires_at)));
end;
$$;

create or replace function public.staff_after_supervisor_change()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  perform public.staff_clamp_to_supervisor(new.id);
  return null;
end;
$$;

drop trigger if exists trg_staff_after_supervisor_change on public.profiles;
create trigger trg_staff_after_supervisor_change
  after update of supervisor_id on public.profiles
  for each row when (new.supervisor_id is not null and new.supervisor_id is distinct from old.supervisor_id)
  execute function public.staff_after_supervisor_change();

-- 5c. staff_departments
create or replace function public.staff_departments_before()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_role text; v_sup uuid;
begin
  select role, supervisor_id into v_role, v_sup from public.profiles where id = new.user_id;
  if v_role is distinct from 'staff' then
    raise exception 'Departments can only be given to staff accounts';
  end if;
  if v_sup is not null then
    if new.is_head then
      raise exception 'One level only: a sub-user cannot be a department Head';
    end if;
    if not exists (select 1 from public.staff_departments
                    where user_id = v_sup and department_id = new.department_id and is_head) then
      raise exception 'Department "%" is outside the supervisor''s own departments',
        (select name from public.departments where id = new.department_id);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_staff_departments_before on public.staff_departments;
create trigger trg_staff_departments_before
  before insert or update on public.staff_departments
  for each row execute function public.staff_departments_before();

-- A Head who stops heading a department takes their sub-users out of it.
create or replace function public.staff_departments_after()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if old.is_head then
      delete from public.staff_departments d using public.profiles p
       where p.supervisor_id = old.user_id and d.user_id = p.id and d.department_id = old.department_id;
    end if;
    return null;
  end if;
  if old.is_head and not new.is_head then
    delete from public.staff_departments d using public.profiles p
     where p.supervisor_id = new.user_id and d.user_id = p.id and d.department_id = new.department_id;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_staff_departments_after on public.staff_departments;
create trigger trg_staff_departments_after
  after update or delete on public.staff_departments
  for each row execute function public.staff_departments_after();

-- 5d. staff_access: shape rules + the ceiling rule
create or replace function public.staff_access_before()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
declare m public.app_modules; v_role text; v_sup uuid; h public.staff_access;
begin
  select role, supervisor_id into v_role, v_sup from public.profiles where id = new.user_id;
  if v_role is distinct from 'staff' then
    raise exception 'Page access can only be given to staff accounts';
  end if;

  select * into m from public.app_modules where key = new.module_key;
  if m.is_switch then new.level := 1; end if;
  if new.level = 3 and not m.approvable then
    raise exception '"%" has no Approve level', m.label;
  end if;
  if new.level < 3 or not m.has_limit then new.approve_limit := null; end if;

  if v_sup is not null then
    select * into h from public.staff_access where user_id = v_sup and module_key = new.module_key;
    if not found or (h.expires_at is not null and h.expires_at <= now()) then
      raise exception 'Access to "%" is above the supervisor''s own access', m.label;
    end if;
    if new.level > h.level then
      raise exception '"%": % is above the supervisor''s own level (%)',
        m.label, initcap(public.perm_label(new.level)), initcap(public.perm_label(h.level));
    end if;
    if new.level = 3 and h.approve_limit is not null
       and (new.approve_limit is null or new.approve_limit > h.approve_limit) then
      raise exception '"%": approval limit must be at most the supervisor''s (₱%)',
        m.label, to_char(h.approve_limit, 'FM999,999,999,990.00');
    end if;
    if h.expires_at is not null and (new.expires_at is null or new.expires_at > h.expires_at) then
      raise exception '"%": access must end on or before the supervisor''s (%)',
        m.label, to_char(h.expires_at at time zone 'Asia/Manila', 'Mon DD, YYYY');
    end if;
  end if;

  if tg_op = 'INSERT' or new.level is distinct from old.level
     or new.approve_limit is distinct from old.approve_limit
     or new.expires_at is distinct from old.expires_at then
    new.granted_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_staff_access_before on public.staff_access;
create trigger trg_staff_access_before
  before insert or update on public.staff_access
  for each row execute function public.staff_access_before();

-- Lowering or removing a Head's access does the same to their sub-users.
create or replace function public.staff_access_after()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.staff_access a using public.profiles p
     where p.supervisor_id = old.user_id and a.user_id = p.id and a.module_key = old.module_key;
    return null;
  end if;
  update public.staff_access a set
    level         = least(a.level, new.level),
    approve_limit = case when new.approve_limit is null then a.approve_limit
                         else least(coalesce(a.approve_limit, new.approve_limit), new.approve_limit) end,
    expires_at    = case when new.expires_at is null then a.expires_at
                         else least(coalesce(a.expires_at, new.expires_at), new.expires_at) end
    from public.profiles p
   where p.supervisor_id = new.user_id and a.user_id = p.id and a.module_key = new.module_key
     and (a.level > new.level
          or (new.approve_limit is not null and (a.approve_limit is null or a.approve_limit > new.approve_limit))
          or (new.expires_at   is not null and (a.expires_at   is null or a.expires_at   > new.expires_at)));
  return null;
end;
$$;

drop trigger if exists trg_staff_access_after on public.staff_access;
create trigger trg_staff_access_after
  after update or delete on public.staff_access
  for each row execute function public.staff_access_after();


-- ---------------------------------------------------------------------
-- 6. Writers (service role only — called by admin-create-staff)
-- ---------------------------------------------------------------------

-- Replaces a user's departments and page access in one transaction.
-- Upserts + deletes only what changed (never delete-all-then-insert,
-- which would wipe a Head's sub-users through the cascade above).
--   p_departments: [{ "id": "purchasing", "is_head": true }, …]
--   p_access:      [{ "module": "pur.purchase_orders", "level": "approve",
--                     "approve_limit": 50000, "expires_at": null }, …]
create or replace function public.staff_apply_access(
  p_user uuid, p_departments jsonb, p_access jsonb, p_actor uuid
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare r jsonb; v_level smallint; v_mod text;
begin
  if not exists (select 1 from public.profiles where id = p_user and role = 'staff') then
    raise exception 'Not a staff account';
  end if;
  p_departments := coalesce(p_departments, '[]'::jsonb);
  p_access      := coalesce(p_access, '[]'::jsonb);

  -- Departments: removals first (a demoted Head's sub-users leave with it)
  delete from public.staff_departments d
   where d.user_id = p_user
     and d.department_id not in (select x->>'id' from jsonb_array_elements(p_departments) x);
  for r in select * from jsonb_array_elements(p_departments) loop
    if not exists (select 1 from public.departments where id = r->>'id') then
      raise exception 'Unknown department: %', r->>'id';
    end if;
    insert into public.staff_departments (user_id, department_id, is_head)
    values (p_user, r->>'id', coalesce((r->>'is_head')::boolean, false))
    on conflict (user_id, department_id) do update set is_head = excluded.is_head
      where public.staff_departments.is_head is distinct from excluded.is_head;
  end loop;

  -- Access
  delete from public.staff_access a
   where a.user_id = p_user
     and a.module_key not in (select x->>'module' from jsonb_array_elements(p_access) x);
  for r in select * from jsonb_array_elements(p_access) loop
    v_mod := r->>'module';
    if not exists (select 1 from public.app_modules where key = v_mod) then
      raise exception 'Unknown page: %', v_mod;
    end if;
    v_level := public.perm_rank(coalesce(r->>'level', 'view'));
    if v_level is null then raise exception 'Unknown level for %: %', v_mod, r->>'level'; end if;
    insert into public.staff_access (user_id, module_key, level, approve_limit, expires_at, granted_by)
    values (p_user, v_mod, v_level,
            nullif(r->>'approve_limit','')::numeric,
            nullif(r->>'expires_at','')::timestamptz,
            p_actor)
    on conflict (user_id, module_key) do update set
      level = excluded.level, approve_limit = excluded.approve_limit,
      expires_at = excluded.expires_at, granted_by = excluded.granted_by
    where (public.staff_access.level, public.staff_access.approve_limit, public.staff_access.expires_at)
          is distinct from (excluded.level, excluded.approve_limit, excluded.expires_at);
  end loop;

  return jsonb_build_object(
    'departments', coalesce((select jsonb_agg(jsonb_build_object('id', department_id, 'is_head', is_head))
                               from public.staff_departments where user_id = p_user), '[]'::jsonb),
    'access',      coalesce((select jsonb_agg(jsonb_build_object('module', module_key, 'level', public.perm_label(level),
                                                                 'approve_limit', approve_limit, 'expires_at', expires_at))
                               from public.staff_access where user_id = p_user), '[]'::jsonb));
end;
$$;

create or replace function public.staff_record_reauth(p_user uuid)
returns void language sql security definer
set search_path = public, pg_temp
as $$
  insert into public.staff_reauth (user_id, verified_at) values (p_user, now())
  on conflict (user_id) do update set verified_at = now();
$$;

-- Explicit log line with a known actor (the Edge Function's caller —
-- inside a service-role request auth.uid() is null, so the generic
-- trigger below would record those changes as "system").
create or replace function public.log_activity_as(
  p_actor uuid, p_action text, p_entity_type text, p_entity_id text,
  p_label text default '', p_details jsonb default '{}'::jsonb
) returns void language sql security definer
set search_path = public, pg_temp
as $$
  insert into public.activity_log (actor_id, actor_name, actor_role, action, entity_type, entity_id, entity_label, details)
  select p_actor, coalesce(p.name, ''), coalesce(p.role, ''), p_action, p_entity_type, p_entity_id,
         coalesce(p_label, ''), coalesce(p_details, '{}'::jsonb)
    from (select 1) one left join public.profiles p on p.id = p_actor;
$$;


-- ---------------------------------------------------------------------
-- 7. Activity log: generic change trigger
-- ---------------------------------------------------------------------

-- Keeps log rows small: signatures, photos and other large values are
-- replaced by a size marker instead of being copied into the log.
create or replace function public.activity_slim(p jsonb)
returns jsonb language sql immutable as $$
  select coalesce(jsonb_object_agg(k,
           case
             when k ~* '(signature|photo|image|_data$|base64|receipt_file)' and v <> 'null'::jsonb
                  then to_jsonb('[' || length(v::text) || ' bytes]')
             when jsonb_typeof(v) = 'string' and length(v #>> '{}') > 300
                  then to_jsonb(left(v #>> '{}', 300) || '…')
             when jsonb_typeof(v) in ('object','array') and length(v::text) > 1500
                  then to_jsonb('[' || length(v::text) || ' bytes]')
             else v end), '{}'::jsonb)
  from jsonb_each(coalesce(p, '{}'::jsonb)) as e(k, v);
$$;

-- Top-level diff; one level deeper for jsonb objects (dispatch_tickets
-- keeps the whole ticket in a single `data` column).
create or replace function public.activity_diff(o jsonb, n jsonb)
returns jsonb language sql immutable as $$
  select coalesce(jsonb_object_agg(k, d), '{}'::jsonb) from (
    select k,
      case when jsonb_typeof(o->k) = 'object' and jsonb_typeof(n->k) = 'object' then
             (select coalesce(jsonb_object_agg(ik, jsonb_build_object('from', (o->k)->ik, 'to', (n->k)->ik)), '{}'::jsonb)
                from (select jsonb_object_keys(o->k) union select jsonb_object_keys(n->k)) s(ik)
               where ((o->k)->ik) is distinct from ((n->k)->ik))
           else jsonb_build_object('from', o->k, 'to', n->k) end as d
      from (select jsonb_object_keys(o) union select jsonb_object_keys(n)) keys(k)
     where (o->k) is distinct from (n->k)
       and k not in ('updated_at')
  ) x;
$$;

create or replace function public.activity_log_trigger()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_old jsonb; v_new jsonb; v_row jsonb; v_details jsonb; v_actor uuid := auth.uid();
  v_label text;
begin
  begin
    if tg_op = 'INSERT' then
      v_new := to_jsonb(new); v_row := v_new; v_details := public.activity_slim(v_new);
    elsif tg_op = 'UPDATE' then
      v_old := to_jsonb(old); v_new := to_jsonb(new); v_row := v_new;
      v_details := public.activity_diff(v_old, v_new);
      if v_details = '{}'::jsonb then return null; end if;
      -- slim each side of each change
      v_details := (select coalesce(jsonb_object_agg(k, public.activity_slim(v)), '{}'::jsonb)
                      from jsonb_each(v_details) e(k, v));
    else
      v_old := to_jsonb(old); v_row := v_old; v_details := public.activity_slim(v_old);
    end if;

    v_label := coalesce(v_row->>'po_no', v_row->>'mrf_no', v_row->>'sr_no', v_row->>'slip_no',
                        v_row->>'receipt_no', v_row->>'return_no', v_row->>'transfer_no',
                        v_row->>'project_no', v_row->>'defect_no', v_row->>'asset_tag', v_row->>'code',
                        v_row->>'name', v_row->>'title', v_row->'data'->>'custName',
                        v_row->>'cust_name', '');

    insert into public.activity_log (actor_id, actor_name, actor_role, action, entity_type, entity_id, entity_label, details)
    select v_actor, coalesce(p.name, case when v_actor is null then 'System' else '' end), coalesce(p.role, ''),
           lower(tg_op), tg_table_name, v_row->>'id', left(v_label, 200), v_details
      from (select 1) one left join public.profiles p on p.id = v_actor;
  exception when others then
    -- Logging must never block the real change.
    raise warning 'activity_log skipped for %: %', tg_table_name, sqlerrm;
  end;
  return null;
end;
$$;

-- Attach to the business tables that exist in this database. profiles and
-- the staff_* tables are logged explicitly by admin-create-staff instead
-- (with the real actor). High-volume/derived tables are skipped:
-- technician_locations*, stock_movements, counters, messages, push.
do $$
declare t text;
begin
  foreach t in array array[
    'suppliers','supplier_contacts','supplier_materials','materials','material_categories',
    'material_requisitions','purchase_orders','po_signatories','po_settings',
    'warehouses','warehouse_storekeepers','stock_receipts','issue_slips','return_slips','stock_transfers',
    'projects','project_job_orders','tools','tool_slips','tool_defects','tool_maintenance',
    'cash_advance_requests','leave_requests','dtr_records',
    'dispatch_tickets','service_requests','service_reports',
    'customers','customer_equipment','customer_login_links',
    'technician_violations','technician_documents','announcements','app_settings'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists trg_activity_log on public.%I', t);
      execute format('create trigger trg_activity_log after insert or update or delete on public.%I
                      for each row execute function public.activity_log_trigger()', t);
    end if;
  end loop;
end $$;


-- ---------------------------------------------------------------------
-- 8. PO signatories ↔ staff logins
-- ---------------------------------------------------------------------
do $$ begin
  if to_regclass('public.po_signatories') is not null then
    alter table public.po_signatories add column if not exists user_id uuid references public.profiles(id) on delete set null;
    create unique index if not exists po_signatories_user_unique on public.po_signatories (user_id) where user_id is not null;
  end if;
end $$;


-- ---------------------------------------------------------------------
-- 9. RLS + grants
-- ---------------------------------------------------------------------
alter table public.departments       enable row level security;
alter table public.app_modules       enable row level security;
alter table public.staff_departments enable row level security;
alter table public.staff_access      enable row level security;
alter table public.staff_reauth      enable row level security;   -- no policies: functions only
alter table public.activity_log      enable row level security;

drop policy if exists departments_read on public.departments;
create policy departments_read on public.departments for select to authenticated using (true);

drop policy if exists app_modules_read on public.app_modules;
create policy app_modules_read on public.app_modules for select to authenticated using (true);

-- Read: yourself, your own sub-users, or everything as Super Admin.
-- No client writes at all — admin-create-staff (service role) only.
drop policy if exists staff_departments_read on public.staff_departments;
create policy staff_departments_read on public.staff_departments for select to authenticated
  using (user_id = auth.uid() or public.is_admin() or public.is_supervisor_of(user_id));

drop policy if exists staff_access_read on public.staff_access;
create policy staff_access_read on public.staff_access for select to authenticated
  using (user_id = auth.uid() or public.is_admin() or public.is_supervisor_of(user_id));

-- Append-only; nobody can edit or delete a log line from the app.
drop policy if exists activity_log_read on public.activity_log;
create policy activity_log_read on public.activity_log for select to authenticated
  using (public.is_admin() or actor_id = auth.uid() or public.is_supervisor_of(actor_id));

-- Heads can read their own sub-users' profile rows (My Team screen).
drop policy if exists profiles_select_team on public.profiles;
create policy profiles_select_team on public.profiles for select to authenticated
  using (public.is_supervisor_of(id));

revoke all on public.departments, public.app_modules, public.staff_departments,
              public.staff_access, public.staff_reauth, public.activity_log from anon;
grant select on public.departments, public.app_modules, public.staff_departments,
                public.staff_access, public.activity_log to authenticated;
revoke insert, update, delete on public.staff_departments, public.staff_access,
                                 public.activity_log from authenticated;
revoke all on public.staff_reauth from authenticated;
grant all on public.departments, public.app_modules, public.staff_departments,
             public.staff_access, public.staff_reauth, public.activity_log to service_role;

-- Readers: any signed-in user
revoke execute on function public.has_perm(text, text), public.is_staff(), public.is_supervisor_of(uuid),
  public.can_see_costs(), public.recently_reauthed(int), public.my_access(),
  public.staff_approval_check(text, numeric, uuid, boolean), public.staff_can_approve(text, numeric, uuid),
  public.staff_is_active(uuid)
  from public, anon;
grant execute on function public.has_perm(text, text), public.is_staff(), public.is_supervisor_of(uuid),
  public.can_see_costs(), public.recently_reauthed(int), public.my_access(),
  public.staff_approval_check(text, numeric, uuid, boolean), public.staff_can_approve(text, numeric, uuid),
  public.staff_is_active(uuid)
  to authenticated, service_role;

-- Writers: service role only
revoke execute on function public.staff_apply_access(uuid, jsonb, jsonb, uuid),
  public.staff_record_reauth(uuid), public.staff_clamp_to_supervisor(uuid),
  public.log_activity_as(uuid, text, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.staff_apply_access(uuid, jsonb, jsonb, uuid),
  public.staff_record_reauth(uuid), public.staff_clamp_to_supervisor(uuid),
  public.log_activity_as(uuid, text, text, text, text, jsonb)
  to service_role;

commit;

-- ---------------------------------------------------------------------
-- After running
-- ---------------------------------------------------------------------
-- 1. Deploy the Edge Function:
--      supabase functions deploy admin-create-staff
-- 2. Optional check (should list 5 departments and 37 pages):
--      select (select count(*) from departments) d, (select count(*) from app_modules) m;

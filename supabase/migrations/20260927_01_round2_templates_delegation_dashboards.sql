-- =====================================================================
-- AWES App — Round 2: role templates, delegation while away, and
-- department dashboards
--
-- 1. ROLE TEMPLATES (Super Admin)
--    access_templates        a saved set of departments + page levels
--                            (e.g. "Purchasing Clerk").
--    staff_template_links    who is kept in sync with which template.
--    template_save()         create / change a template — every linked
--                            person is updated straight away.
--    template_apply()        give someone a template's access, optionally
--                            linked (kept in sync). Sub-users always get it
--                            cut down to their Head's own access (level,
--                            peso limit, end date) — never above it.
--    Changing a linked person's access by hand unlinks them (the
--    admin-create-staff function does this on update_access).
--
-- 2. DELEGATION WHILE AWAY (Heads, or the Super Admin for anyone)
--    staff_delegations       Head → one of their sub-users, a date range,
--                            and which of the Head's Approve pages.
--    While active (Manila dates, inclusive) the sub-user approves those
--    pages under the Head's own peso limit; still never their own records,
--    still with password re-entry. Nothing to clean up: it simply stops
--    after the end date, or when revoked, or if the Head loses the access.
--
-- 3. DEPARTMENT DASHBOARDS
--    dept_dashboard()        live counts for each department page the
--                            caller can see; peso sums only where the
--                            figures are already shown on that page, or
--                            with "See peso values" for stock / PO value.
--
-- Requires 20260926_01 … _08. Idempotent.
-- =====================================================================

begin;

do $$ begin
  if to_regprocedure('public.staff_approval_assert(text,numeric,uuid)') is null
     or to_regprocedure('public.tl_staff_view()') is null then
    raise exception 'Run 20260926_01 … 20260926_08 first.';
  end if;
end $$;

create or replace function public.manila_today()
returns date language sql stable as $$ select (now() at time zone 'Asia/Manila')::date; $$;

-- =====================================================================
-- 1. Role templates
-- =====================================================================
create table if not exists public.access_templates (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  description  text not null default '',
  departments  jsonb not null default '[]'::jsonb,   -- ["purchasing", …]
  access       jsonb not null default '[]'::jsonb,   -- [{module, level, approve_limit}]
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index if not exists access_templates_name_ci on public.access_templates (lower(name));

create table if not exists public.staff_template_links (
  user_id      uuid primary key references public.profiles(id) on delete cascade,
  template_id  uuid not null references public.access_templates(id) on delete cascade,
  linked_by    uuid references public.profiles(id) on delete set null,
  linked_at    timestamptz not null default now()
);

alter table public.access_templates enable row level security;
alter table public.staff_template_links enable row level security;
drop policy if exists access_templates_read on public.access_templates;
create policy access_templates_read on public.access_templates for select to authenticated
  using (public.is_admin() or public.is_staff());
drop policy if exists staff_template_links_read on public.staff_template_links;
create policy staff_template_links_read on public.staff_template_links for select to authenticated
  using (public.is_admin() or user_id = auth.uid() or public.is_supervisor_of(user_id));
revoke all on public.access_templates, public.staff_template_links from anon;
grant select on public.access_templates, public.staff_template_links to authenticated;
revoke insert, update, delete on public.access_templates, public.staff_template_links from authenticated;

-- The template cut down to what this user may hold.
create or replace function public.template_fit(p_template uuid, p_user uuid, out departments jsonb, out access jsonb)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare t public.access_templates; v_sup uuid; r jsonb; h public.staff_access; lv smallint; lim numeric;
begin
  select * into t from public.access_templates where id = p_template;
  if not found then raise exception 'Template not found.' using errcode = 'P0001'; end if;
  select supervisor_id into v_sup from public.profiles where id = p_user;

  -- departments: keep the person's own Head flags; sub-users only get
  -- departments their Head heads
  select coalesce(jsonb_agg(jsonb_build_object('id', d,
           'is_head', v_sup is null and exists (select 1 from public.staff_departments sd
                                                 where sd.user_id = p_user and sd.department_id = d and sd.is_head))), '[]'::jsonb)
    into departments
    from jsonb_array_elements_text(t.departments) d
   where v_sup is null
      or exists (select 1 from public.staff_departments hd where hd.user_id = v_sup and hd.department_id = d and hd.is_head);

  access := '[]'::jsonb;
  for r in select * from jsonb_array_elements(t.access) loop
    lv := public.perm_rank(r->>'level');
    lim := nullif(r->>'approve_limit', '')::numeric;
    if v_sup is not null then
      select * into h from public.staff_access where user_id = v_sup and module_key = r->>'module'
         and (expires_at is null or expires_at > now());
      if not found then continue; end if;
      lv := least(lv, h.level);
      if h.approve_limit is not null then lim := least(coalesce(lim, h.approve_limit), h.approve_limit); end if;
      access := access || jsonb_build_array(jsonb_build_object('module', r->>'module', 'level', public.perm_label(lv),
                  'approve_limit', lim, 'expires_at', h.expires_at));
    else
      access := access || jsonb_build_array(jsonb_build_object('module', r->>'module', 'level', public.perm_label(lv),
                  'approve_limit', lim, 'expires_at', null));
    end if;
  end loop;
end;
$$;

create or replace function public.template_apply_internal(p_user uuid, p_template uuid, p_link boolean, p_actor uuid)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare f record; res jsonb;
begin
  select * into f from public.template_fit(p_template, p_user);
  res := public.staff_apply_access(p_user, f.departments, f.access, p_actor);
  if p_link then
    insert into public.staff_template_links (user_id, template_id, linked_by) values (p_user, p_template, p_actor)
    on conflict (user_id) do update set template_id = excluded.template_id, linked_by = excluded.linked_by, linked_at = now();
  end if;
  return res;
end;
$$;

-- Super Admin: anyone. Head: their own sub-users.
create or replace function public.template_apply(p_user uuid, p_template uuid, p_link boolean default true)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare res jsonb; lbl text;
begin
  if not (public.is_admin() or (public.is_staff() and public.is_supervisor_of(p_user))) then
    raise exception 'You can only apply templates to your own sub-users.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_user and role = 'staff') then
    raise exception 'Not a staff account.' using errcode = 'P0001';
  end if;
  res := public.template_apply_internal(p_user, p_template, p_link, auth.uid());
  if not p_link then delete from public.staff_template_links where user_id = p_user; end if;
  select username into lbl from public.profiles where id = p_user;
  perform public.log_activity_as(auth.uid(), 'staff.apply_template', 'staff', p_user::text, coalesce(lbl, ''),
    jsonb_build_object('template', (select name from public.access_templates where id = p_template), 'linked', p_link) || res);
  return res;
end;
$$;

-- Super Admin only. Returns the template id; re-applies to linked people.
create or replace function public.template_save(p_id uuid, p_name text, p_description text, p_departments jsonb, p_access jsonb)
returns uuid
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_id uuid; r jsonb; m public.app_modules; lv smallint; clean jsonb := '[]'::jsonb; u record; n int := 0;
begin
  if not public.is_admin() then raise exception 'Only the Super Admin manages templates.' using errcode = '42501'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Give the template a name.' using errcode = 'P0001'; end if;
  for r in select * from jsonb_array_elements(coalesce(p_access, '[]'::jsonb)) loop
    select * into m from public.app_modules where key = r->>'module';
    if not found then raise exception 'Unknown page: %', r->>'module' using errcode = 'P0001'; end if;
    lv := public.perm_rank(r->>'level');
    if lv is null then raise exception 'Unknown level for %', m.label using errcode = 'P0001'; end if;
    if m.is_switch then lv := 1; end if;
    if lv = 3 and not m.approvable then raise exception '"%" has no Approve level', m.label using errcode = 'P0001'; end if;
    clean := clean || jsonb_build_array(jsonb_build_object('module', m.key, 'level', public.perm_label(lv),
               'approve_limit', case when lv = 3 and m.has_limit then nullif(r->>'approve_limit', '')::numeric end));
  end loop;
  if exists (select 1 from jsonb_array_elements_text(coalesce(p_departments, '[]'::jsonb)) d
              where not exists (select 1 from public.departments where id = d)) then
    raise exception 'Unknown department in template.' using errcode = 'P0001';
  end if;
  if p_id is null then
    insert into public.access_templates (name, description, departments, access, created_by)
    values (trim(p_name), coalesce(p_description, ''), coalesce(p_departments, '[]'::jsonb), clean, auth.uid())
    returning id into v_id;
  else
    update public.access_templates set name = trim(p_name), description = coalesce(p_description, ''),
           departments = coalesce(p_departments, '[]'::jsonb), access = clean, updated_at = now()
     where id = p_id returning id into v_id;
    if v_id is null then raise exception 'Template not found.' using errcode = 'P0001'; end if;
    -- keep everyone linked in sync (Heads first, so their sub-users' ceilings are current)
    for u in select l.user_id from public.staff_template_links l join public.profiles p on p.id = l.user_id
              where l.template_id = v_id and p.active order by (p.supervisor_id is not null), p.name loop
      perform public.template_apply_internal(u.user_id, v_id, true, auth.uid());
      n := n + 1;
    end loop;
  end if;
  perform public.log_activity_as(auth.uid(), case when p_id is null then 'template.create' else 'template.update' end,
    'template', v_id::text, trim(p_name), jsonb_build_object('access', clean, 'departments', p_departments, 'people_updated', n));
  return v_id;
end;
$$;

create or replace function public.template_delete(p_id uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare nm text;
begin
  if not public.is_admin() then raise exception 'Only the Super Admin manages templates.' using errcode = '42501'; end if;
  delete from public.access_templates where id = p_id returning name into nm;   -- links go with it; people keep their access
  if nm is not null then
    perform public.log_activity_as(auth.uid(), 'template.delete', 'template', p_id::text, nm, '{}'::jsonb);
  end if;
end;
$$;

-- =====================================================================
-- 2. Delegation while away
-- =====================================================================
create table if not exists public.staff_delegations (
  id          uuid primary key default gen_random_uuid(),
  from_user   uuid not null references public.profiles(id) on delete cascade,
  to_user     uuid not null references public.profiles(id) on delete cascade,
  starts_on   date not null,
  ends_on     date not null,
  modules     text[] not null,
  note        text not null default '',
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  revoked_by  uuid references public.profiles(id) on delete set null,
  check (ends_on >= starts_on),
  check (from_user <> to_user),
  check (cardinality(modules) > 0)
);
create index if not exists staff_delegations_to_idx on public.staff_delegations (to_user) where revoked_at is null;

alter table public.staff_delegations enable row level security;
drop policy if exists staff_delegations_read on public.staff_delegations;
create policy staff_delegations_read on public.staff_delegations for select to authenticated
  using (public.is_admin() or from_user = auth.uid() or to_user = auth.uid()
         or public.is_supervisor_of(from_user) or public.is_supervisor_of(to_user));
revoke all on public.staff_delegations from anon;
grant select on public.staff_delegations to authenticated;
revoke insert, update, delete on public.staff_delegations from authenticated;

-- The delegator's Approve row this user may borrow right now (or none)
create or replace function public.staff_delegated_access(p_user uuid, p_module text)
returns public.staff_access
language sql stable security definer
set search_path = public, pg_temp
as $$
  select a.* from public.staff_delegations d
    join public.staff_access a on a.user_id = d.from_user and a.module_key = p_module and a.level = 3
                              and (a.expires_at is null or a.expires_at > now())
   where d.to_user = p_user and d.revoked_at is null
     and public.manila_today() between d.starts_on and d.ends_on
     and p_module = any (d.modules)
     and public.staff_is_active(d.from_user)
   order by a.approve_limit is null desc, a.approve_limit desc
   limit 1;
$$;

-- has_perm: own access, or Approve borrowed through an active delegation
create or replace function public.has_perm(p_module text, p_level text default 'view')
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select public.is_admin() or (
    public.staff_is_active(auth.uid()) and (
      exists (select 1 from public.staff_access a
               where a.user_id = auth.uid() and a.module_key = p_module
                 and a.level >= coalesce(public.perm_rank(p_level), 1)
                 and (a.expires_at is null or a.expires_at > now()))
      or (public.staff_delegated_access(auth.uid(), p_module)).user_id is not null
    )
  );
$$;

-- Approval check: own Approve or delegated Approve (the higher limit wins)
create or replace function public.staff_approval_check(
  p_module text, p_amount numeric default null, p_creator uuid default null, p_require_reauth boolean default true
) returns text
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare a public.staff_access; d public.staff_access; ok_own boolean; ok_del boolean; lim numeric; unlimited boolean;
begin
  if public.is_admin() then return 'ok'; end if;
  if not public.staff_is_active(auth.uid()) then return 'not_staff'; end if;
  select * into a from public.staff_access where user_id = auth.uid() and module_key = p_module;
  ok_own := found and a.level = 3 and (a.expires_at is null or a.expires_at > now());
  d := public.staff_delegated_access(auth.uid(), p_module);
  ok_del := d.user_id is not null;
  if not ok_own and not ok_del then return 'no_approve_access'; end if;
  if p_creator is not null and p_creator = auth.uid() then return 'own_record'; end if;
  unlimited := (ok_own and a.approve_limit is null) or (ok_del and d.approve_limit is null);
  lim := greatest(case when ok_own then a.approve_limit end, case when ok_del then d.approve_limit end);
  if not unlimited and p_amount is not null and p_amount > lim then return 'over_limit'; end if;
  if p_require_reauth and not public.recently_reauthed(5) then return 'reauth_required'; end if;
  return 'ok';
end;
$$;

-- over_limit message: quote the limit that applies (own or delegated)
create or replace function public.staff_approval_assert(p_module text, p_amount numeric, p_creator uuid)
returns void
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  r text := public.staff_approval_check(p_module, p_amount, p_creator, true);
  lab text := coalesce((select label from public.app_modules where key = p_module), p_module);
  lim numeric;
begin
  if r = 'ok' then return; end if;
  if r = 'own_record' then
    raise exception 'You can''t approve your own % — another approver has to.', regexp_replace(lower(lab), 's$', '') using errcode = '42501';
  elsif r = 'over_limit' then
    select greatest((select approve_limit from public.staff_access where user_id = auth.uid() and module_key = p_module and level = 3),
                    (public.staff_delegated_access(auth.uid(), p_module)).approve_limit) into lim;
    raise exception 'This is above your approval limit of ₱% — someone with a higher limit has to approve it.',
      to_char(lim, 'FM999,999,999,990.00') using errcode = '42501';
  elsif r = 'reauth_required' then
    raise exception 'Enter your password to confirm this approval.' using errcode = '42501', hint = 'reauth_required';
  else
    raise exception 'You don''t have Approve access for %.', lab using errcode = '42501';
  end if;
end;
$$;

-- my_access(): delegated Approve shows up as the page at "approve", with
-- the Head's limit and name (the screens show Approve buttons from this)
create or replace function public.my_access()
returns jsonb
language sql stable security definer
set search_path = public, pg_temp
as $$
  with own as (
    select a.module_key, a.level, a.approve_limit, a.expires_at, null::text as delegated_from, null::date as delegated_until
      from public.staff_access a
     where a.user_id = auth.uid() and (a.expires_at is null or a.expires_at > now())
  ), del as (
    select distinct on (m) m as module_key, 3::smallint as level, a.approve_limit, null::timestamptz as expires_at,
           fp.name as delegated_from, d.ends_on as delegated_until
      from public.staff_delegations d
      cross join lateral unnest(d.modules) m
      join public.staff_access a on a.user_id = d.from_user and a.module_key = m and a.level = 3
                                and (a.expires_at is null or a.expires_at > now())
      join public.profiles fp on fp.id = d.from_user
     where d.to_user = auth.uid() and d.revoked_at is null
       and public.manila_today() between d.starts_on and d.ends_on
       and public.staff_is_active(d.from_user)
     order by m, a.approve_limit is null desc, a.approve_limit desc
  ), merged as (
    select coalesce(o.module_key, x.module_key) module_key,
           greatest(o.level, x.level) as level,
           case when x.module_key is not null and (o.level is null or o.level < 3) then x.approve_limit
                when x.module_key is not null and (o.approve_limit is null or x.approve_limit is null) then null
                when x.module_key is not null then greatest(o.approve_limit, x.approve_limit)
                else o.approve_limit end as approve_limit,
           o.expires_at,
           case when x.module_key is not null and (o.level is null or o.level < 3) then x.delegated_from end as delegated_from,
           case when x.module_key is not null and (o.level is null or o.level < 3) then x.delegated_until end as delegated_until
      from own o full join del x on x.module_key = o.module_key
  )
  select jsonb_build_object(
    'user_id',       p.id,
    'role',          p.role,
    'is_superadmin', p.role = 'admin',
    'active',        coalesce(public.staff_is_active(p.id), false) or p.role = 'admin',
    'position',      p.position,
    'is_head',       exists (select 1 from public.staff_departments d where d.user_id = p.id and d.is_head),
    'supervisor',    (select jsonb_build_object('id', s.id, 'name', s.name) from public.profiles s where s.id = p.supervisor_id),
    'departments',   coalesce((select jsonb_agg(jsonb_build_object('id', d.department_id, 'name', dep.name, 'is_head', d.is_head) order by dep.sort)
                                 from public.staff_departments d join public.departments dep on dep.id = d.department_id
                                where d.user_id = p.id), '[]'::jsonb),
    'access',        coalesce((select jsonb_object_agg(module_key, jsonb_strip_nulls(jsonb_build_object(
                                         'level', public.perm_label(level), 'approve_limit', approve_limit, 'expires_at', expires_at,
                                         'delegated_from', delegated_from, 'delegated_until', delegated_until)))
                                 from merged), '{}'::jsonb),
    'see_costs',     p.role = 'admin' or exists (select 1 from merged where module_key = 'fin.costs'),
    'template',      (select jsonb_build_object('id', t.id, 'name', t.name) from public.staff_template_links l
                        join public.access_templates t on t.id = l.template_id where l.user_id = p.id)
  )
  from public.profiles p
  where p.id = auth.uid();
$$;

-- Create a delegation. Super Admin: any staff → any active staff.
-- Head: themselves → one of their own sub-users. Only pages the Head holds
-- at Approve; at most 90 days.
create or replace function public.delegation_create(p_to uuid, p_starts date, p_ends date, p_modules text[],
                                                    p_note text default '', p_from uuid default null)
returns uuid
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_from uuid := coalesce(p_from, auth.uid()); v_id uuid; bad text;
begin
  if not public.is_admin() then
    if v_from <> auth.uid() then raise exception 'You can only delegate your own approvals.' using errcode = '42501'; end if;
    if not public.is_supervisor_of(p_to) then raise exception 'You can only delegate to one of your own sub-users.' using errcode = '42501'; end if;
  end if;
  if not public.staff_is_active(v_from) or not public.staff_is_active(p_to) then
    raise exception 'Both people must have active staff accounts.' using errcode = 'P0001';
  end if;
  if p_starts is null or p_ends is null or p_ends < p_starts then raise exception 'Choose a valid date range.' using errcode = 'P0001'; end if;
  if p_ends < public.manila_today() then raise exception 'That date range is already over.' using errcode = 'P0001'; end if;
  if p_ends - p_starts > 90 then raise exception 'A delegation can last at most 90 days.' using errcode = 'P0001'; end if;
  if coalesce(cardinality(p_modules), 0) = 0 then raise exception 'Choose at least one page to delegate.' using errcode = 'P0001'; end if;
  select string_agg(coalesce(am.label, m), ', ') into bad from unnest(p_modules) m left join public.app_modules am on am.key = m
   where not exists (select 1 from public.staff_access a where a.user_id = v_from and a.module_key = m and a.level = 3
                      and (a.expires_at is null or a.expires_at > now()));
  if bad is not null then raise exception 'Only pages held at Approve can be delegated (not: %).', bad using errcode = 'P0001'; end if;
  insert into public.staff_delegations (from_user, to_user, starts_on, ends_on, modules, note, created_by)
  values (v_from, p_to, p_starts, p_ends, (select array_agg(distinct m) from unnest(p_modules) m), coalesce(p_note, ''), auth.uid())
  returning id into v_id;
  perform public.log_activity_as(auth.uid(), 'delegation.create', 'staff', p_to::text,
    coalesce((select username from public.profiles where id = p_to), ''),
    jsonb_build_object('from', (select name from public.profiles where id = v_from), 'starts_on', p_starts, 'ends_on', p_ends, 'modules', p_modules));
  return v_id;
end;
$$;

create or replace function public.delegation_revoke(p_id uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare d public.staff_delegations;
begin
  select * into d from public.staff_delegations where id = p_id;
  if not found then raise exception 'Delegation not found.' using errcode = 'P0001'; end if;
  if not (public.is_admin() or d.from_user = auth.uid() or d.created_by = auth.uid()) then
    raise exception 'Only the person who delegated can end it.' using errcode = '42501';
  end if;
  update public.staff_delegations set revoked_at = now(), revoked_by = auth.uid() where id = p_id and revoked_at is null;
  perform public.log_activity_as(auth.uid(), 'delegation.revoke', 'staff', d.to_user::text,
    coalesce((select username from public.profiles where id = d.to_user), ''), jsonb_build_object('modules', d.modules));
end;
$$;

-- =====================================================================
-- 3. Department dashboards
-- =====================================================================
create or replace function public.dept_dashboard()
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  out jsonb := '[]'::jsonb; money boolean := public.can_see_costs(); today date := public.manila_today();
  n bigint; s numeric;
begin
  -- helper: append one figure
  -- (department, page to open, label, value, tone: 'warn' draws attention)
  -- ---- Purchasing ----
  if public.has_perm('pur.requisitions') then
    select count(*) into n from public.material_requisitions where status = 'submitted';
    out := out || jsonb_build_array(jsonb_build_object('dept','purchasing','module','pur.requisitions','label','Requisitions to review','value',n,'tone',case when n>0 then 'warn' end));
  end if;
  if public.has_perm('pur.purchase_orders') then
    select count(*) into n from public.purchase_orders where status = 'draft';
    out := out || jsonb_build_array(jsonb_build_object('dept','purchasing','module','pur.purchase_orders','label','Draft POs','value',n,'tone',case when n>0 then 'warn' end));
    select count(*), coalesce(sum(total), 0) into n, s from public.purchase_orders
     where status = 'issued' and (issued_at at time zone 'Asia/Manila')::date >= date_trunc('month', today)::date;
    out := out || jsonb_build_array(jsonb_build_object('dept','purchasing','module','pur.purchase_orders','label','POs issued this month','value',n,
             'money', case when money then s end));
  end if;
  -- ---- Inventory ----
  if public.has_perm('inv.receive') then
    select jsonb_array_length(coalesce(public.inv_pos_to_receive(), '[]'::jsonb)) into n;
    out := out || jsonb_build_array(jsonb_build_object('dept','purchasing','module','inv.receive','label','POs waiting to be received','value',n,'tone',case when n>0 then 'warn' end));
  end if;
  if public.has_perm('inv.reports') then
    select count(*) into n from public.inv_rpt_reorder(90) where reorder;
    out := out || jsonb_build_array(jsonb_build_object('dept','purchasing','module','inv.reports','label','Materials to reorder','value',n,'tone',case when n>0 then 'warn' end));
  end if;
  if public.has_perm('inv.stock') and money then
    select coalesce(sum(qty_on_hand * coalesce(avg_cost, 0)), 0) into s from public.stock_balances;
    out := out || jsonb_build_array(jsonb_build_object('dept','purchasing','module','inv.stock','label','Stock value (all warehouses)','money',s));
  end if;
  -- ---- Accounting & Finance ----
  if public.has_perm('fin.cash_advance') then
    select count(*), coalesce(sum(nullif(data->>'amount','')::numeric), 0) into n, s from public.cash_advance_requests
     where status = 'pending' and public.cash_module(data) = 'fin.cash_advance';
    out := out || jsonb_build_array(jsonb_build_object('dept','finance','module','fin.cash_advance','label','Advances to approve','value',n,'money',s,'tone',case when n>0 then 'warn' end));
    select count(*) into n from public.cash_advance_requests
     where status = 'approved' and public.cash_module(data) = 'fin.cash_advance' and not coalesce((data->>'disbursed')::boolean, false);
    out := out || jsonb_build_array(jsonb_build_object('dept','finance','module','fin.cash_advance','label','Approved, cash not yet given','value',n,'tone',case when n>0 then 'warn' end));
  end if;
  if public.has_perm('fin.liquidation') then
    select count(*) into n from public.cash_advance_requests
     where public.cash_module(data) = 'fin.cash_advance' and data->'liquidation'->>'status' = 'pending';
    out := out || jsonb_build_array(jsonb_build_object('dept','finance','module','fin.liquidation','label','Liquidations to review','value',n,'tone',case when n>0 then 'warn' end));
    select count(*), coalesce(sum(nullif(data->>'amountGiven','')::numeric), 0) into n, s from public.cash_advance_requests
     where public.cash_module(data) = 'fin.cash_advance' and coalesce((data->>'disbursed')::boolean, false)
       and (data->'liquidation' is null or jsonb_typeof(data->'liquidation') <> 'object')
       and nullif(data->>'dateGiven','')::date < today - 7;
    out := out || jsonb_build_array(jsonb_build_object('dept','finance','module','fin.liquidation','label','Not liquidated after 7 days','value',n,'money',s,'tone',case when n>0 then 'warn' end));
  end if;
  if public.has_perm('fin.reimbursement') then
    select count(*), coalesce(sum(nullif(data->>'amount','')::numeric), 0) into n, s from public.cash_advance_requests
     where status = 'pending' and public.cash_module(data) = 'fin.reimbursement';
    out := out || jsonb_build_array(jsonb_build_object('dept','finance','module','fin.reimbursement','label','Reimbursements to approve','value',n,'money',s,'tone',case when n>0 then 'warn' end));
  end if;
  -- ---- Human Resources ----
  if public.has_perm('hr.attendance') then
    select count(distinct technician_id) into n from public.dtr_records where date = today and coalesce(data->>'timeIn','') <> '';
    out := out || jsonb_build_array(jsonb_build_object('dept','hr','module','hr.attendance','label','Timed in today','value',n,
             'of', (select count(*) from public.profiles where role = 'technician' and active)));
  end if;
  if public.has_perm('hr.leaves') then
    select count(*) into n from public.leave_requests where status = 'pending';
    out := out || jsonb_build_array(jsonb_build_object('dept','hr','module','hr.leaves','label','Leave requests to decide','value',n,'tone',case when n>0 then 'warn' end));
    select count(*) into n from public.leave_requests
     -- the app saves dateFrom / dateTo (older rows: from / to)
     where status = 'approved'
       and today between coalesce(nullif(data->>'dateFrom',''), nullif(data->>'from',''))::date
                     and coalesce(nullif(data->>'dateTo',''), nullif(data->>'to',''), nullif(data->>'dateFrom',''), nullif(data->>'from',''))::date;
    out := out || jsonb_build_array(jsonb_build_object('dept','hr','module','hr.leaves','label','On leave today','value',n));
  end if;
  if public.has_perm('hr.tech_profiles') then
    select count(*) into n from public.technician_violations where occurred_on >= date_trunc('month', today)::date;
    out := out || jsonb_build_array(jsonb_build_object('dept','hr','module','hr.tech_profiles','label','Violations this month','value',n));
  end if;
  -- ---- Administration ----
  if public.has_perm('adm.equipment') or public.has_perm('adm.customers') then
    select count(*) into n from public.customer_equipment where next_pm_date is not null and next_pm_date < today;
    out := out || jsonb_build_array(jsonb_build_object('dept','administration','module', case when public.has_perm('adm.equipment') then 'adm.equipment' else 'adm.customers' end,
             'label','Equipment overdue for PM','value',n,'tone',case when n>0 then 'warn' end));
    select count(*) into n from public.customer_equipment where next_pm_date between today and today + 30;
    out := out || jsonb_build_array(jsonb_build_object('dept','administration','module', case when public.has_perm('adm.equipment') then 'adm.equipment' else 'adm.customers' end,
             'label','PM due in the next 30 days','value',n));
  end if;
  if public.has_perm('adm.customers') then
    select count(*) into n from public.customers;
    out := out || jsonb_build_array(jsonb_build_object('dept','administration','module','adm.customers','label','Customers','value',n));
  end if;
  -- ---- Operations ----
  if public.has_perm('ops.dispatch') then
    select count(*) into n from public.dispatch_tickets where status in ('open','acknowledged','preparing','scheduled','in_progress');
    out := out || jsonb_build_array(jsonb_build_object('dept','operations','module','ops.dispatch','label','Open job orders','value',n));
    select count(*) into n from public.dispatch_tickets
     where status in ('open','acknowledged','preparing','scheduled') and nullif(data->>'date','')::date < today;
    out := out || jsonb_build_array(jsonb_build_object('dept','operations','module','ops.dispatch','label','Late job orders','value',n,'tone',case when n>0 then 'warn' end));
  end if;
  if public.has_perm('ops.service_requests') then
    select count(*) into n from public.service_requests where status = 'new';
    out := out || jsonb_build_array(jsonb_build_object('dept','operations','module','ops.service_requests','label','New service requests','value',n,'tone',case when n>0 then 'warn' end));
  end if;
  if public.tl_staff_view() then
    select count(*) into n from public.tools where status = 'issued' and due_back is not null and due_back < today;
    out := out || jsonb_build_array(jsonb_build_object('dept','operations','module', case when public.has_perm('tools.return') then 'tools.return' else 'tools.register' end,
             'label','Tools overdue for return','value',n,'tone',case when n>0 then 'warn' end));
    select count(*) into n from public.tools where status not in ('retired','lost') and next_maint_due is not null and next_maint_due < today;
    out := out || jsonb_build_array(jsonb_build_object('dept','operations','module', case when public.has_perm('tools.maintenance') then 'tools.maintenance' else 'tools.register' end,
             'label','Tools overdue for calibration','value',n,'tone',case when n>0 then 'warn' end));
  end if;
  return out;
end;
$$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
revoke execute on function public.template_fit(uuid, uuid), public.template_apply_internal(uuid, uuid, boolean, uuid),
  public.staff_delegated_access(uuid, text) from public, anon, authenticated;
grant execute on function public.template_fit(uuid, uuid), public.template_apply_internal(uuid, uuid, boolean, uuid),
  public.staff_delegated_access(uuid, text) to service_role;
revoke execute on function public.template_apply(uuid, uuid, boolean), public.template_save(uuid, text, text, jsonb, jsonb),
  public.template_delete(uuid), public.delegation_create(uuid, date, date, text[], text, uuid), public.delegation_revoke(uuid),
  public.dept_dashboard(), public.manila_today() from public, anon;
grant execute on function public.template_apply(uuid, uuid, boolean), public.template_save(uuid, text, text, jsonb, jsonb),
  public.template_delete(uuid), public.delegation_create(uuid, date, date, text[], text, uuid), public.delegation_revoke(uuid),
  public.dept_dashboard(), public.manila_today() to authenticated, service_role;

commit;

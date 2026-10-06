-- =====================================================================
-- AWES App — warehouse rules (materials rules, part 2)
--
--   Stock coming IN  (Receive, Returns): the person chooses ANY active warehouse.
--                    Allowed: Super Admin, any storekeeper (warehouseman), and staff
--                    with Edit on that page.
--   Stock going OUT  (Issue to Worker, the "from" side of a Transfer): only the
--                    person's own warehouses.
--                    Allowed: Super Admin; a storekeeper of THAT warehouse; staff with
--                    Edit on the page who are assigned to that warehouse, or who have
--                    "all warehouses" switched on.
--   Anything else (Tools & Equipment pages, which share inv_require_warehouse):
--                    exactly the rule they had before.
--
-- Office staff are assigned to warehouses in the same table as storekeepers
-- (warehouse_storekeepers). The new table inventory_staff_scope holds the
-- "all warehouses" switch per person. EVERY staff member who holds an Inventory
-- page today is switched to "all warehouses" so nobody loses access; the Super
-- Admin narrows people down afterwards (Employees > person > Warehouses).
--
-- No change to the four posting functions: they already call
-- inv_require_warehouse(warehouse, page). Safe to re-run.
-- =====================================================================
create table if not exists public.inventory_staff_scope (
  user_id         uuid primary key references public.profiles(id) on delete cascade,
  all_warehouses  boolean not null default false,
  updated_by      uuid references public.profiles(id) on delete set null,
  updated_at      timestamptz not null default now()
);
alter table public.inventory_staff_scope enable row level security;
drop policy if exists inv_scope_read on public.inventory_staff_scope;
create policy inv_scope_read on public.inventory_staff_scope for select to authenticated
  using (public.is_admin() or user_id = auth.uid());
-- (no write policies: the Super Admin writes through inv_set_staff_scope() below)

-- everyone who holds an Inventory page keeps working across all warehouses until narrowed
insert into public.inventory_staff_scope (user_id, all_warehouses)
select distinct sa.user_id, true
  from public.staff_access sa
 where sa.module_key in ('inv.stock', 'inv.receive', 'inv.issue', 'inv.returns', 'inv.transfers')
on conflict (user_id) do nothing;

create or replace function public.inv_staff_all_warehouses()
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce((select all_warehouses from public.inventory_staff_scope where user_id = auth.uid()), false);
$$;
revoke execute on function public.inv_staff_all_warehouses() from public, anon;
grant execute on function public.inv_staff_all_warehouses() to authenticated;

create or replace function public.inv_require_warehouse(p_warehouse uuid, p_module text)
returns void
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from public.warehouses where id = p_warehouse and is_active) then
    raise exception 'That warehouse doesn''t exist or is inactive.' using errcode = 'P0001';
  end if;

  if p_module in ('inv.receive', 'inv.returns') then
    -- stock coming IN: any warehouse
    if public.is_admin() or public.inv_is_storekeeper() or public.has_perm(p_module, 'edit') then return; end if;
  elsif p_module in ('inv.issue', 'inv.transfers') then
    -- stock going OUT: only your own warehouses
    if public.is_admin() or public.inv_is_storekeeper_of(p_warehouse) then return; end if;
    if public.has_perm(p_module, 'edit') then
      if public.inv_staff_all_warehouses() then return; end if;
      raise exception 'You can only take stock out of the warehouses you are assigned to.' using errcode = '42501';
    end if;
  else
    -- Tools & Equipment and anything else: unchanged
    if public.inv_can_handle(p_warehouse) or public.has_perm(p_module, 'edit') then return; end if;
  end if;

  if public.is_staff() then
    raise exception 'You need Edit access for % to post this.',
      coalesce((select label from public.app_modules where key = p_module), p_module) using errcode = '42501';
  end if;
  raise exception 'You''re not a storekeeper of that warehouse.' using errcode = '42501';
end;
$$;
revoke execute on function public.inv_require_warehouse(uuid, text) from public, anon;
grant execute on function public.inv_require_warehouse(uuid, text) to authenticated, service_role;

-- Super Admin: set one staff member's warehouses in a single call
create or replace function public.inv_set_staff_scope(p_user uuid, p_all boolean, p_warehouses uuid[])
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'Only the Super Admin can assign warehouses.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_user) then
    raise exception 'That person doesn''t exist.' using errcode = 'P0001';
  end if;
  insert into public.inventory_staff_scope (user_id, all_warehouses, updated_by, updated_at)
  values (p_user, coalesce(p_all, false), auth.uid(), now())
  on conflict (user_id) do update set all_warehouses = excluded.all_warehouses, updated_by = excluded.updated_by, updated_at = now();
  delete from public.warehouse_storekeepers
   where user_id = p_user and warehouse_id <> all (coalesce(p_warehouses, '{}'::uuid[]));
  insert into public.warehouse_storekeepers (warehouse_id, user_id)
  select w.id, p_user from public.warehouses w where w.id = any (coalesce(p_warehouses, '{}'::uuid[]))
  on conflict do nothing;
end;
$$;
revoke execute on function public.inv_set_staff_scope(uuid, boolean, uuid[]) from public, anon;
grant execute on function public.inv_set_staff_scope(uuid, boolean, uuid[]) to authenticated;

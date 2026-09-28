-- ---------------------------------------------------------------------
-- Inventory — Phase 1: foundation
--
--   warehouses               several stock locations
--   warehouse_storekeepers   which staff member keeps which warehouse
--                            (the "Storekeeper" setting in Users & Roles)
--   projects                 big jobs that group many job orders
--   project_job_orders       job order ↔ project (a JO is in at most one)
--   stock_movements          THE LEDGER — every stock change is one row:
--                            opening, adjustment (Phase 1); receipt, issue,
--                            return, transfer, write-off (Phase 2)
--   stock_balances           on hand + weighted average cost per
--                            warehouse & material, kept by the database
--
-- Rules the DATABASE enforces:
--   * stock_movements can never be updated or deleted — mistakes are fixed
--     with a new, opposite movement, so the history is always complete.
--   * Balances and average cost are computed here, not by the app:
--       incoming  new_avg = (on_hand×avg + qty×cost) / (on_hand + qty)
--       outgoing  valued at the current average cost
--   * Stock can't go negative: an outgoing movement larger than what's on
--     hand is refused.
--   * Storekeepers never see money: they read quantities through the
--     *_qty views, only for warehouses assigned to them. Costs, values and
--     project spend stay admin-only.
--
-- Storekeeper is a permission on a staff account, not a separate login
-- role — it's granted by assigning the person to one or more warehouses.
--
-- Depends on 20260923_01 (materials, is_admin, purch_touch_updated_at).
-- Safe to re-run.
-- ---------------------------------------------------------------------

do $$
begin
  if to_regclass('public.materials') is null then
    raise exception 'Run 20260923_01_purchasing_suppliers_materials.sql first.';
  end if;
end $$;

-- =====================================================================
-- Warehouses + storekeepers
-- =====================================================================
create table if not exists public.warehouses (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null,
  name        text not null,
  address     text not null default '',
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
drop trigger if exists warehouses_set_updated_at on public.warehouses;
create trigger warehouses_set_updated_at before update on public.warehouses
  for each row execute function public.purch_touch_updated_at();

create table if not exists public.warehouse_storekeepers (
  warehouse_id  uuid not null references public.warehouses(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (warehouse_id, user_id)
);
create index if not exists warehouse_storekeepers_user_idx on public.warehouse_storekeepers (user_id);

create or replace function public.inv_is_storekeeper_of(p_warehouse uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.warehouse_storekeepers
                 where warehouse_id = p_warehouse and user_id = auth.uid());
$$;
create or replace function public.inv_is_storekeeper()
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.warehouse_storekeepers where user_id = auth.uid());
$$;

-- =====================================================================
-- Projects
-- =====================================================================
create table if not exists public.project_counters (year int primary key, last_no int not null default 0);

create table if not exists public.projects (
  id             uuid primary key default gen_random_uuid(),
  project_no     text unique,                        -- PRJ-YYYY-NNNN, set by trigger
  name           text not null,
  customer_name  text not null default '',
  site_address   text not null default '',
  budget         numeric(14,2) check (budget is null or budget >= 0),
  start_date     date,
  end_date       date,
  status         text not null default 'active'
                   check (status in ('planning','active','on_hold','completed','cancelled')),
  notes          text not null default '',
  created_by     uuid references auth.users(id) default auth.uid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create or replace function public.inv_project_number()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare y int := extract(year from (now() at time zone 'Asia/Manila'))::int; n int;
begin
  insert into public.project_counters as c (year, last_no) values (y, 1)
    on conflict (year) do update set last_no = c.last_no + 1 returning last_no into n;
  new.project_no := 'PRJ-' || y || '-' || lpad(n::text, 4, '0');
  return new;
end;
$$;
drop trigger if exists projects_number on public.projects;
create trigger projects_number before insert on public.projects
  for each row execute function public.inv_project_number();
drop trigger if exists projects_set_updated_at on public.projects;
create trigger projects_set_updated_at before update on public.projects
  for each row execute function public.purch_touch_updated_at();
create or replace function public.inv_project_keep_number()
returns trigger language plpgsql as $$
begin new.project_no := old.project_no; return new; end; $$;
drop trigger if exists projects_keep_number on public.projects;
create trigger projects_keep_number before update on public.projects
  for each row execute function public.inv_project_keep_number();

create table if not exists public.project_job_orders (
  project_id    uuid not null references public.projects(id) on delete cascade,
  job_order_id  text not null unique,              -- dispatch_tickets.id; one project per JO
  added_at      timestamptz not null default now(),
  primary key (project_id, job_order_id)
);

-- =====================================================================
-- Stock ledger + balances
-- =====================================================================
create table if not exists public.stock_balances (
  warehouse_id  uuid not null references public.warehouses(id) on delete restrict,
  material_id   uuid not null references public.materials(id) on delete restrict,
  qty_on_hand   numeric(14,3) not null default 0 check (qty_on_hand >= 0),
  avg_cost      numeric(14,4) not null default 0 check (avg_cost >= 0),
  updated_at    timestamptz not null default now(),
  primary key (warehouse_id, material_id)
);

create table if not exists public.stock_movements (
  id            uuid primary key default gen_random_uuid(),
  doc_type      text not null check (doc_type in
                  ('opening','adjustment','receipt','issue','return','transfer_out','transfer_in','write_off')),
  doc_ref       text not null default '',          -- slip / PO / count number
  doc_id        uuid,                              -- the document row (Phase 2 slips)
  warehouse_id  uuid not null references public.warehouses(id) on delete restrict,
  material_id   uuid not null references public.materials(id) on delete restrict,
  qty           numeric(14,3) not null check (qty <> 0),   -- + into the warehouse, − out of it
  unit_cost     numeric(14,4),                     -- set by trigger for outgoing lines
  value         numeric(14,2),                     -- qty × unit_cost, set by trigger
  balance_after numeric(14,3),                     -- on hand right after this line, set by trigger
  project_id    uuid references public.projects(id) on delete restrict,
  job_order_id  text,
  worker_id     uuid references auth.users(id),
  note          text not null default '',
  created_by    uuid references auth.users(id) default auth.uid(),
  created_at    timestamptz not null default now()
);
create index if not exists stock_movements_item_idx on public.stock_movements (material_id, warehouse_id, created_at desc);
create index if not exists stock_movements_project_idx on public.stock_movements (project_id);
create index if not exists stock_movements_job_idx on public.stock_movements (job_order_id);
create index if not exists stock_movements_doc_idx on public.stock_movements (doc_type, doc_ref);

create or replace function public.inv_apply_movement()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  b record;
  new_qty numeric;
begin
  -- one balance row per warehouse+item; lock it so concurrent postings
  -- (two storekeepers, two devices) can't both spend the same stock
  insert into public.stock_balances (warehouse_id, material_id) values (new.warehouse_id, new.material_id)
    on conflict do nothing;
  select * into b from public.stock_balances
   where warehouse_id = new.warehouse_id and material_id = new.material_id for update;

  new_qty := b.qty_on_hand + new.qty;
  if new_qty < 0 then
    raise exception 'Not enough stock: % on hand, % needed.', trim_scale(b.qty_on_hand), trim_scale(-new.qty) using errcode = 'P0001';
  end if;

  if new.qty > 0 then
    new.unit_cost := coalesce(new.unit_cost, b.avg_cost);
    if new.unit_cost < 0 then raise exception 'Unit cost can''t be negative.' using errcode = 'P0001'; end if;
    update public.stock_balances
       set avg_cost = case when new_qty > 0 then round((b.qty_on_hand * b.avg_cost + new.qty * new.unit_cost) / new_qty, 4) else b.avg_cost end,
           qty_on_hand = new_qty, updated_at = now()
     where warehouse_id = new.warehouse_id and material_id = new.material_id;
  else
    new.unit_cost := b.avg_cost;                   -- outgoing: valued at average cost
    update public.stock_balances set qty_on_hand = new_qty, updated_at = now()
     where warehouse_id = new.warehouse_id and material_id = new.material_id;
  end if;
  new.value := round(new.qty * new.unit_cost, 2);
  new.balance_after := new_qty;
  new.created_by := coalesce(auth.uid(), new.created_by);
  new.created_at := now();
  return new;
end;
$$;
drop trigger if exists stock_movements_apply on public.stock_movements;
create trigger stock_movements_apply before insert on public.stock_movements
  for each row execute function public.inv_apply_movement();

create or replace function public.inv_ledger_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'Stock movements can''t be changed or deleted — post an adjustment instead.' using errcode = 'P0001';
end; $$;
drop trigger if exists stock_movements_immutable on public.stock_movements;
create trigger stock_movements_immutable before update or delete on public.stock_movements
  for each row execute function public.inv_ledger_immutable();

-- Balances are only ever written by the trigger above.
create or replace function public.inv_balances_guard()
returns trigger language plpgsql as $$
begin
  if pg_trigger_depth() <= 1 then
    raise exception 'Stock balances are calculated from movements and can''t be edited directly.' using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end; $$;
drop trigger if exists stock_balances_guard on public.stock_balances;
create trigger stock_balances_guard before insert or update or delete on public.stock_balances
  for each row execute function public.inv_balances_guard();

-- =====================================================================
-- Quantity-only views for storekeepers (no costs, own warehouses only)
-- =====================================================================
create or replace view public.stock_on_hand_qty with (security_invoker = false) as
  select b.warehouse_id, b.material_id, b.qty_on_hand, b.updated_at
    from public.stock_balances b
   where public.is_admin() or public.inv_is_storekeeper_of(b.warehouse_id);

create or replace view public.stock_movements_qty with (security_invoker = false) as
  select m.id, m.doc_type, m.doc_ref, m.warehouse_id, m.material_id, m.qty, m.balance_after,
         m.project_id, m.job_order_id, m.worker_id, m.note, m.created_by, m.created_at
    from public.stock_movements m
   where public.is_admin() or public.inv_is_storekeeper_of(m.warehouse_id);

-- =====================================================================
-- RLS + grants
-- =====================================================================
alter table public.warehouses             enable row level security;
alter table public.warehouse_storekeepers enable row level security;
alter table public.project_counters       enable row level security;
alter table public.projects               enable row level security;
alter table public.project_job_orders     enable row level security;
alter table public.stock_balances         enable row level security;
alter table public.stock_movements        enable row level security;

drop policy if exists warehouses_read on public.warehouses;
create policy warehouses_read on public.warehouses for select to authenticated using (true);
drop policy if exists warehouses_admin on public.warehouses;
create policy warehouses_admin on public.warehouses for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists wh_keepers_read on public.warehouse_storekeepers;
create policy wh_keepers_read on public.warehouse_storekeepers for select to authenticated
  using (public.is_admin() or user_id = auth.uid());
drop policy if exists wh_keepers_admin on public.warehouse_storekeepers;
create policy wh_keepers_admin on public.warehouse_storekeepers for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists projects_read on public.projects;
create policy projects_read on public.projects for select to authenticated
  using (public.is_admin() or public.inv_is_storekeeper());
drop policy if exists projects_admin on public.projects;
create policy projects_admin on public.projects for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists pjo_read on public.project_job_orders;
create policy pjo_read on public.project_job_orders for select to authenticated
  using (public.is_admin() or public.inv_is_storekeeper());
drop policy if exists pjo_admin on public.project_job_orders;
create policy pjo_admin on public.project_job_orders for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- money-bearing tables: admin only (storekeepers use the *_qty views)
drop policy if exists stock_balances_admin_read on public.stock_balances;
create policy stock_balances_admin_read on public.stock_balances for select to authenticated using (public.is_admin());
drop policy if exists stock_movements_admin_read on public.stock_movements;
create policy stock_movements_admin_read on public.stock_movements for select to authenticated using (public.is_admin());
-- Phase 1: opening balances and adjustments are posted by admins.
-- (Phase 2 adds storekeeper postings through validated functions.)
drop policy if exists stock_movements_admin_insert on public.stock_movements;
create policy stock_movements_admin_insert on public.stock_movements for insert to authenticated
  with check (public.is_admin() and doc_type in ('opening', 'adjustment'));

grant select on public.warehouses, public.warehouse_storekeepers, public.projects, public.project_job_orders to authenticated;
grant insert, update, delete on public.warehouses, public.warehouse_storekeepers, public.projects, public.project_job_orders to authenticated;
grant select on public.stock_balances, public.stock_movements to authenticated;
grant insert on public.stock_movements to authenticated;
grant select on public.stock_on_hand_qty, public.stock_movements_qty to authenticated;
revoke all on public.warehouses, public.warehouse_storekeepers, public.project_counters, public.projects,
              public.project_job_orders, public.stock_balances, public.stock_movements,
              public.stock_on_hand_qty, public.stock_movements_qty from anon;
revoke all on public.project_counters from authenticated;
revoke update, delete on public.stock_movements from authenticated;
revoke insert, update, delete on public.stock_balances from authenticated;

do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['warehouses', 'warehouse_storekeepers', 'projects', 'project_job_orders', 'stock_balances', 'stock_movements'] loop
      if not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

NOTIFY pgrst, 'reload schema';

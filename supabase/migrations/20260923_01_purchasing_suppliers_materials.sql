-- ---------------------------------------------------------------------
-- Purchasing module — foundation schema
--
-- Tables:
--   suppliers               supplier master record
--   supplier_contacts       people at each supplier (sales, warehouse, billing)
--   supplier_documents      accreditation papers / quotations (files in Storage)
--   materials               materials & parts catalog (one row per size/variant)
--   supplier_materials      who sells what, at what price  (the price list)
--   supplier_price_history  automatic log of every price change
--
-- View:
--   suppliers_directory     safe columns only (no prices, TIN, bank, terms)
--                           so technicians can look up where to pick up
--
-- Access: everything here is admin-only EXCEPT
--   * materials            — any signed-in user can read ACTIVE rows
--                            (technicians will pick from it on requisitions)
--   * suppliers_directory  — any signed-in user can read
--
-- Nothing is ever hard-deleted from the UI: suppliers and materials are
-- deactivated (is_active = false) because requisitions and POs will point
-- at them. supplier_materials uses ON DELETE RESTRICT for the same reason.
--
-- Depends on public.is_admin() from 20260822_01_fixes_and_hardening.sql.
-- Safe to re-run.
-- ---------------------------------------------------------------------

-- ---------- 0. move the old purchasing tables out of the way ----------
-- The live project had an earlier, unused purchasing/billing attempt:
--   suppliers, materials, purchase_orders, purchase_order_items, po_counters
-- (different columns — no `code`), and other tables such as
-- billing_statements hold foreign keys to them. AWES code uses none of them.
-- Because this file uses CREATE TABLE IF NOT EXISTS, they would silently
-- block the real tables.
--
-- They are RENAMED to legacy_<name>, never dropped:
--   * no data can be lost, and it's reversible
--   * foreign keys pointing at them (e.g. billing_statements) simply follow
--     the renamed table, so nothing else breaks
--   * each table's indexes and owned sequences are renamed too — index
--     names are schema-wide, so an old "suppliers_pkey" would otherwise
--     collide with the new table's primary key
-- Runs only while the old-shape suppliers/materials exist, so re-running
-- this file later never touches the new tables.
do $$
declare
  legacy_set text[] := array['purchase_order_items', 'purchase_orders', 'po_counters', 'materials', 'suppliers'];
  t text;
  n bigint;
  obj record;
  fn text;
begin
  if not exists (
    select 1 from unnest(array['suppliers', 'materials']) as x(tbl)
    where to_regclass('public.' || x.tbl) is not null
      and not exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = x.tbl and column_name = 'code')
  ) then
    return;   -- no old-shape tables: nothing to do
  end if;

  foreach t in array legacy_set loop
    if to_regclass('public.' || t) is not null and to_regclass('public.legacy_' || t) is not null then
      raise exception 'Both public.% and public.legacy_% exist — resolve that by hand first; nothing was renamed.', t, t;
    end if;
  end loop;

  foreach t in array legacy_set loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('select count(*) from public.%I', t) into n;

    -- indexes (includes primary-key / unique constraint indexes)
    for obj in
      select ic.relname as name from pg_index i
      join pg_class ic on ic.oid = i.indexrelid
      where i.indrelid = ('public.' || t)::regclass
    loop
      execute format('alter index public.%I rename to %I', obj.name, left('legacy_' || obj.name, 63));
    end loop;

    -- sequences owned by this table's columns (serial / identity)
    for obj in
      select s.relname as name from pg_depend d
      join pg_class s on s.oid = d.objid and s.relkind = 'S'
      where d.refobjid = ('public.' || t)::regclass and d.deptype in ('a', 'i')
    loop
      execute format('alter sequence public.%I rename to %I', obj.name, left('legacy_' || obj.name, 63));
    end loop;

    execute format('alter table public.%I rename to %I', t, 'legacy_' || t);
    raise notice 'Renamed old table public.% -> public.legacy_% (% rows kept)', t, t, n;
  end loop;

  -- Functions don't follow renames (their code refers to tables by name),
  -- so flag any that mention the old tables — they'd now fail if called.
  for fn in
    select p.oid::regprocedure::text
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public'
      and p.prosrc ~* '(po_counters|purchase_orders?|purchase_order_items)'
  loop
    raise notice 'Function mentions the old purchasing tables (review / drop manually): %', fn;
  end loop;
end;
$$;

-- ---------- shared updated_at trigger ----------
create or replace function public.purch_touch_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- =====================================================================
-- 1. suppliers
-- =====================================================================
create sequence if not exists public.supplier_code_seq start 1;

create table if not exists public.suppliers (
  id              uuid primary key default gen_random_uuid(),
  code            text unique not null
                    default ('SUP-' || lpad(nextval('public.supplier_code_seq')::text, 3, '0')),
  name            text not null,                    -- registered business name
  trade_name      text not null default '',         -- what everyone calls them
  supplies        text[] not null default '{}',     -- Piping, Refrigerant, Electrical, …
  address         text not null default '',
  city            text not null default '',
  tin             text not null default '',
  vat_registered  boolean,                          -- null = unknown
  payment_terms   text not null default 'COD',
  credit_limit    numeric(12,2) check (credit_limit is null or credit_limit >= 0),
  delivers        boolean not null default false,
  bank_details    jsonb not null default '{}',      -- {bank, account_name, account_no, ewallet}
  rating          smallint check (rating is null or rating between 1 and 5),
  remarks         text not null default '',
  is_active       boolean not null default true,
  created_by      uuid references auth.users(id) default auth.uid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
alter sequence public.supplier_code_seq owned by public.suppliers.code;

create index if not exists suppliers_active_name_idx on public.suppliers (is_active, name);

drop trigger if exists suppliers_set_updated_at on public.suppliers;
create trigger suppliers_set_updated_at
  before update on public.suppliers
  for each row execute function public.purch_touch_updated_at();

-- =====================================================================
-- 2. supplier_contacts
-- =====================================================================
create table if not exists public.supplier_contacts (
  id           uuid primary key default gen_random_uuid(),
  supplier_id  uuid not null references public.suppliers(id) on delete cascade,
  name         text not null,
  position     text not null default '',
  mobile       text not null default '',
  email        text not null default '',
  is_primary   boolean not null default false,
  created_at   timestamptz not null default now()
);
create index if not exists supplier_contacts_supplier_idx on public.supplier_contacts (supplier_id);
-- at most one primary contact per supplier
create unique index if not exists supplier_contacts_one_primary
  on public.supplier_contacts (supplier_id) where is_primary;

-- =====================================================================
-- 3. supplier_documents  (+ private Storage bucket)
--    Path convention: {supplier_id}/{timestamp}-{filename}
-- =====================================================================
create table if not exists public.supplier_documents (
  id            uuid primary key default gen_random_uuid(),
  supplier_id   uuid not null references public.suppliers(id) on delete cascade,
  doc_type      text not null default 'Other',   -- BIR 2303, DTI/SEC, Mayor's Permit, Quotation, Price List, Other
  title         text not null default '',
  storage_path  text not null,
  file_name     text not null default '',
  mime_type     text not null default '',
  expires_on    date,                             -- e.g. Mayor's Permit validity
  uploaded_by   uuid references auth.users(id) default auth.uid(),
  created_at    timestamptz not null default now()
);
create index if not exists supplier_documents_supplier_idx on public.supplier_documents (supplier_id);

insert into storage.buckets (id, name, public)
values ('supplier-documents', 'supplier-documents', false)
on conflict (id) do nothing;

drop policy if exists supdoc_admin_select on storage.objects;
create policy supdoc_admin_select on storage.objects
  for select to authenticated
  using (bucket_id = 'supplier-documents' and public.is_admin());

drop policy if exists supdoc_admin_insert on storage.objects;
create policy supdoc_admin_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'supplier-documents' and public.is_admin());

drop policy if exists supdoc_admin_delete on storage.objects;
create policy supdoc_admin_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'supplier-documents' and public.is_admin());

-- =====================================================================
-- 4. materials  (schema only — the Materials Database screen comes next)
-- =====================================================================
create table if not exists public.materials (
  id             uuid primary key default gen_random_uuid(),
  code           text unique not null,              -- e.g. CU-038, REF-R32, CAP-35UF
  name           text not null,
  family         text not null default '',          -- groups sizes: "Copper Tube"
  category       text not null,                     -- same list as suppliers.supplies
  scope          text[] not null default '{}',      -- Aircon / Ventilation / General Scope
  unit           text not null,                     -- issue unit: ft, m, kg, pc, roll…
  pack_unit      text,                              -- purchase unit: roll, box, tank
  pack_qty       numeric check (pack_qty is null or pack_qty > 0),
  brand          text not null default '',
  specs          jsonb not null default '{}',
  standard_cost  numeric(12,2) check (standard_cost is null or standard_cost >= 0),  -- budgeting only
  is_active      boolean not null default true,
  notes          text not null default '',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists materials_active_category_idx on public.materials (is_active, category);
create index if not exists materials_family_idx on public.materials (family);

drop trigger if exists materials_set_updated_at on public.materials;
create trigger materials_set_updated_at
  before update on public.materials
  for each row execute function public.purch_touch_updated_at();

-- =====================================================================
-- 5. supplier_materials  — the price list
-- =====================================================================
create table if not exists public.supplier_materials (
  id                  uuid primary key default gen_random_uuid(),
  supplier_id         uuid not null references public.suppliers(id) on delete restrict,
  material_id         uuid not null references public.materials(id) on delete restrict,
  supplier_item_code  text not null default '',
  price               numeric(12,2) check (price is null or price >= 0),
  price_unit          text,                        -- be explicit: per ft? per roll?
  price_updated_at    date,
  min_order_qty       numeric check (min_order_qty is null or min_order_qty > 0),
  lead_time_days      int check (lead_time_days is null or lead_time_days >= 0),
  is_preferred        boolean not null default false,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (supplier_id, material_id)
);
create index if not exists supplier_materials_material_idx on public.supplier_materials (material_id);
-- only one preferred supplier per material
create unique index if not exists supplier_materials_one_preferred
  on public.supplier_materials (material_id) where is_preferred;

drop trigger if exists supplier_materials_set_updated_at on public.supplier_materials;
create trigger supplier_materials_set_updated_at
  before update on public.supplier_materials
  for each row execute function public.purch_touch_updated_at();

-- =====================================================================
-- 6. supplier_price_history — written automatically, never by the app
-- =====================================================================
create table if not exists public.supplier_price_history (
  id                   uuid primary key default gen_random_uuid(),
  supplier_material_id uuid not null references public.supplier_materials(id) on delete cascade,
  price                numeric(12,2),
  price_unit           text,
  changed_at           timestamptz not null default now(),
  changed_by           uuid references auth.users(id)
);
create index if not exists supplier_price_history_sm_idx
  on public.supplier_price_history (supplier_material_id, changed_at desc);

create or replace function public.log_supplier_price_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT'
     or new.price is distinct from old.price
     or new.price_unit is distinct from old.price_unit then
    insert into public.supplier_price_history (supplier_material_id, price, price_unit, changed_by)
    values (new.id, new.price, new.price_unit, auth.uid());
  end if;
  return new;
end;
$$;

drop trigger if exists supplier_materials_log_price on public.supplier_materials;
create trigger supplier_materials_log_price
  after insert or update on public.supplier_materials
  for each row execute function public.log_supplier_price_change();

-- =====================================================================
-- 7. Row Level Security
-- =====================================================================
alter table public.suppliers              enable row level security;
alter table public.supplier_contacts      enable row level security;
alter table public.supplier_documents     enable row level security;
alter table public.materials              enable row level security;
alter table public.supplier_materials     enable row level security;
alter table public.supplier_price_history enable row level security;

-- admin-only tables
drop policy if exists suppliers_admin_all on public.suppliers;
create policy suppliers_admin_all on public.suppliers
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists supplier_contacts_admin_all on public.supplier_contacts;
create policy supplier_contacts_admin_all on public.supplier_contacts
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists supplier_documents_admin_all on public.supplier_documents;
create policy supplier_documents_admin_all on public.supplier_documents
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists supplier_materials_admin_all on public.supplier_materials;
create policy supplier_materials_admin_all on public.supplier_materials
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- history: admins read; rows only ever come from the trigger
drop policy if exists supplier_price_history_admin_read on public.supplier_price_history;
create policy supplier_price_history_admin_read on public.supplier_price_history
  for select to authenticated using (public.is_admin());

-- materials: everyone signed in reads active items; admin reads all and writes
drop policy if exists materials_read on public.materials;
create policy materials_read on public.materials
  for select to authenticated using (is_active or public.is_admin());

drop policy if exists materials_admin_write on public.materials;
create policy materials_admin_write on public.materials
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Explicit table grants. Supabase normally adds these through default
-- privileges, but stating them keeps this migration correct on its own;
-- RLS above is what actually limits each role.
grant select, insert, update, delete
  on public.suppliers, public.supplier_contacts, public.supplier_documents,
     public.materials, public.supplier_materials
  to authenticated;
grant select on public.supplier_price_history to authenticated;
grant usage, select on sequence public.supplier_code_seq to authenticated;

-- Never reachable without signing in.
revoke all on public.suppliers, public.supplier_contacts, public.supplier_documents,
              public.materials, public.supplier_materials, public.supplier_price_history
  from anon;

-- =====================================================================
-- 8. suppliers_directory — technician-safe lookup
--    Runs as the view owner (bypasses the admin-only RLS on suppliers),
--    so it deliberately exposes only non-sensitive columns and active rows.
-- =====================================================================
create or replace view public.suppliers_directory
with (security_invoker = false) as
  select s.id,
         s.code,
         coalesce(nullif(s.trade_name, ''), s.name) as display_name,
         s.name,
         s.address,
         s.city,
         s.delivers,
         s.supplies
  from public.suppliers s
  where s.is_active;

revoke all on public.suppliers_directory from anon, public;
grant select on public.suppliers_directory to authenticated;

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- Post-run check (optional): should list all six tables with rls = true
--   select relname, relrowsecurity as rls from pg_class
--   where relname in ('suppliers','supplier_contacts','supplier_documents',
--                     'materials','supplier_materials','supplier_price_history');
-- ---------------------------------------------------------------------

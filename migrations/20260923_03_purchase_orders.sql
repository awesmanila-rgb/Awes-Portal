-- ---------------------------------------------------------------------
-- Purchasing — Purchase Orders
--
-- Tables:
--   po_settings              one row: company name/address/logo + PO defaults
--   po_signatories           people who sign POs, each with an e-signature image
--   purchase_order_counters  per-year counter behind PO-YYYY-NNNN
--   purchase_orders          PO header (+ totals, kept by the database)
--   purchase_order_items     PO lines
-- Storage:
--   purchasing-assets        private bucket: logo/…, signatures/…
--
-- Rules the DATABASE enforces (not just the screen):
--   * po_no is assigned on insert: PO-<year>-<0001>, restarting each year.
--   * Totals (subtotal / VAT / total) are recomputed from the items on
--     every change — the app's own math is display only.
--       vat_mode 'exclusive': VAT 12% added on top of (subtotal − discount)
--       vat_mode 'inclusive': prices already include VAT; VAT is extracted
--       vat_mode 'none'     : no VAT (e.g. non-VAT supplier)
--     EWT (expanded withholding tax, 0–15%) is computed on the amount net
--     of VAT and deducted from the total: net_payable = total − ewt_amount.
--   * status: draft → issued → cancelled.  Only DRAFTS can be edited or
--     deleted. An issued PO can only be cancelled (with a reason). Items of
--     a non-draft PO can't be touched.
--   * Issuing needs a supplier, at least one item and an "approved by"
--     signatory. At that moment the supplier, both signatories and the
--     company details are SNAPSHOTTED onto the PO, so an issued PO's PDF
--     never changes when a supplier, signature, logo or address is later
--     edited. (Old logo/signature files are never deleted for that reason.)
--
-- Everything is admin-only (RLS + no anon access). Realtime is enabled for
-- the live-updating screens.
--
-- Depends on 20260923_01 (suppliers, materials, purch_touch_updated_at,
-- is_admin()). Safe to re-run.
-- ---------------------------------------------------------------------

do $$
begin
  if to_regclass('public.suppliers') is null or to_regprocedure('public.purch_touch_updated_at()') is null then
    raise exception 'Run 20260923_01_purchasing_suppliers_materials.sql first.';
  end if;
  -- An older, unrelated purchase_orders table would silently block this one.
  if to_regclass('public.purchase_orders') is not null
     and not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'purchase_orders' and column_name = 'vat_mode') then
    raise exception 'An older public.purchase_orders table exists. Run 20260923_01 first (it renames the old one to legacy_purchase_orders).';
  end if;
end $$;

-- =====================================================================
-- 1. po_settings — single row (id = 1)
-- =====================================================================
create table if not exists public.po_settings (
  id          int primary key default 1 check (id = 1),
  data        jsonb not null default '{}',
  updated_at  timestamptz not null default now()
);
insert into public.po_settings (id, data) values (1, jsonb_build_object(
  'company_name', 'AW Engineering Services',
  'tagline',      'Air Conditioning & Ventilation System',
  'address',      '3F DJET Commercial Bldg., Imelda Ave., Karangalan Vill., Manggahan, Pasig City',
  'phone',        '8441-6497 / 8441-6796',
  'email',        'awes.manila@gmail.com',
  'tin',          '',
  'logo_path',    '',
  'header_style', 'green',
  'deliver_to',   '',
  'vat_mode',     'exclusive',
  'terms',        E'1. Please indicate the PO number on all delivery receipts and invoices.\n2. Deliver only the items and quantities listed in this Purchase Order, on or before the delivery date indicated.\n3. Failure to deliver the specified items on the date indicated shall automatically cancel this order.\n4. Acceptance of the items is subject to their delivery in good condition. AW Engineering Services reserves the right to inspect all deliveries and to reject any item that is damaged or not according to specifications; rejected items shall be returned at the supplier''s expense.\n5. Only the amount stated in this Purchase Order shall be honored. AW Engineering Services must be notified of, and must approve, any change in price before the order is accepted.\n6. Freight and delivery charges are for the supplier''s account unless otherwise stated in this Purchase Order.'
)) on conflict (id) do nothing;

drop trigger if exists po_settings_set_updated_at on public.po_settings;
create trigger po_settings_set_updated_at
  before update on public.po_settings
  for each row execute function public.purch_touch_updated_at();

-- =====================================================================
-- 2. po_signatories
-- =====================================================================
create table if not exists public.po_signatories (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  position        text not null default '',
  signature_path  text not null default '',       -- purchasing-assets/signatures/…
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
drop trigger if exists po_signatories_set_updated_at on public.po_signatories;
create trigger po_signatories_set_updated_at
  before update on public.po_signatories
  for each row execute function public.purch_touch_updated_at();

-- =====================================================================
-- 3. purchase_orders + items
-- =====================================================================
create table if not exists public.purchase_order_counters (
  year     int primary key,
  last_no  int not null default 0
);

create table if not exists public.purchase_orders (
  id                      uuid primary key default gen_random_uuid(),
  po_no                   text unique,                      -- set by trigger
  status                  text not null default 'draft'
                            check (status in ('draft', 'issued', 'cancelled')),
  supplier_id             uuid references public.suppliers(id) on delete restrict,
  po_date                 date not null default ((now() at time zone 'Asia/Manila')::date),
  delivery_date           date,
  deliver_to              text not null default '',
  payment_terms           text not null default '',
  reference               text not null default '',         -- job order / project / requisition
  notes                   text not null default '',         -- terms & conditions printed on the PO
  vat_mode                text not null default 'exclusive'
                            check (vat_mode in ('exclusive', 'inclusive', 'none')),
  discount                numeric(12,2) not null default 0 check (discount >= 0),
  subtotal                numeric(14,2) not null default 0,  -- kept by trigger
  vat_amount              numeric(14,2) not null default 0,  -- kept by trigger
  total                   numeric(14,2) not null default 0,  -- kept by trigger
  ewt_rate                numeric(6,4) not null default 0
                            check (ewt_rate >= 0 and ewt_rate <= 0.15), -- 0.01 = 1% (goods), 0.02 = 2% (services)
  ewt_amount              numeric(14,2) not null default 0,  -- kept by trigger
  net_payable             numeric(14,2) not null default 0,  -- kept by trigger
  prepared_by_id          uuid references public.po_signatories(id) on delete restrict,
  approved_by_id          uuid references public.po_signatories(id) on delete restrict,
  -- frozen at issue:
  supplier_snapshot       jsonb,
  prepared_snapshot       jsonb,
  approved_snapshot       jsonb,
  company_snapshot        jsonb,
  issued_at               timestamptz,
  cancelled_at            timestamptz,
  cancel_reason           text not null default '',
  created_by              uuid references auth.users(id) default auth.uid(),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
-- upgrade path when this file was already run before EWT existed
alter table public.purchase_orders add column if not exists ewt_rate numeric(6,4) not null default 0;
alter table public.purchase_orders add column if not exists ewt_amount numeric(14,2) not null default 0;
alter table public.purchase_orders add column if not exists net_payable numeric(14,2) not null default 0;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'purchase_orders_ewt_rate_check') then
    alter table public.purchase_orders add constraint purchase_orders_ewt_rate_check check (ewt_rate >= 0 and ewt_rate <= 0.15);
  end if;
end $$;
create index if not exists purchase_orders_status_date_idx on public.purchase_orders (status, po_date desc);
create index if not exists purchase_orders_supplier_idx on public.purchase_orders (supplier_id);

create table if not exists public.purchase_order_items (
  id           uuid primary key default gen_random_uuid(),
  po_id        uuid not null references public.purchase_orders(id) on delete cascade,
  line_no      int not null default 1,
  material_id  uuid references public.materials(id) on delete restrict,   -- null = free-text line
  code         text not null default '',
  description  text not null,
  unit         text not null default '',
  qty          numeric(14,3) not null check (qty > 0),
  unit_price   numeric(14,2) not null default 0 check (unit_price >= 0),
  amount       numeric(14,2) generated always as (round(qty * unit_price, 2)) stored,
  created_at   timestamptz not null default now()
);
create index if not exists purchase_order_items_po_idx on public.purchase_order_items (po_id, line_no);

-- ---------- PO number on insert ----------
create or replace function public.po_assign_number()
returns trigger
language plpgsql
security definer                       -- counters table is not directly writable
set search_path = public, pg_temp
as $$
declare
  y int;
  n int;
begin
  if new.po_no is null or new.po_no = '' then
    y := extract(year from coalesce(new.po_date, (now() at time zone 'Asia/Manila')::date))::int;
    insert into public.purchase_order_counters as c (year, last_no) values (y, 1)
      on conflict (year) do update set last_no = c.last_no + 1
      returning last_no into n;
    new.po_no := 'PO-' || y || '-' || lpad(n::text, 4, '0');
  end if;
  new.status := 'draft';               -- every PO starts as a draft
  return new;
end;
$$;
drop trigger if exists purchase_orders_assign_number on public.purchase_orders;
create trigger purchase_orders_assign_number
  before insert on public.purchase_orders
  for each row execute function public.po_assign_number();

-- ---------- totals ----------
drop function if exists public.po_compute_totals(uuid, text, numeric);   -- pre-EWT signature
create or replace function public.po_compute_totals(p_po uuid, p_vat_mode text, p_discount numeric, p_ewt_rate numeric,
                                                    out o_subtotal numeric, out o_vat numeric, out o_total numeric,
                                                    out o_ewt numeric, out o_net numeric)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  net numeric;
  base numeric;   -- amount net of VAT: what EWT is computed on
begin
  select coalesce(sum(amount), 0) into o_subtotal from public.purchase_order_items where po_id = p_po;
  net := greatest(o_subtotal - coalesce(p_discount, 0), 0);
  if p_vat_mode = 'exclusive' then
    o_vat := round(net * 0.12, 2);
    o_total := net + o_vat;
    base := net;
  elsif p_vat_mode = 'inclusive' then
    o_vat := round(net - net / 1.12, 2);
    o_total := net;
    base := net - o_vat;
  else
    o_vat := 0;
    o_total := net;
    base := net;
  end if;
  o_ewt := round(base * coalesce(p_ewt_rate, 0), 2);
  o_net := o_total - o_ewt;
end;
$$;

-- ---------- header guard: locking, issuing, snapshots, totals ----------
create or replace function public.po_before_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  t record;
  pc record;
  allowed text[] := array['status', 'cancelled_at', 'cancel_reason', 'updated_at'];
begin
  if old.status = 'cancelled' then
    raise exception 'PO % is cancelled and can no longer be changed.', old.po_no using errcode = 'P0001';
  end if;

  if old.status = 'issued' then
    if new.status = 'cancelled'
       and (to_jsonb(new) - allowed) = (to_jsonb(old) - allowed) then
      if coalesce(trim(new.cancel_reason), '') = '' then
        raise exception 'A reason is required to cancel an issued PO.' using errcode = 'P0001';
      end if;
      new.cancelled_at := now();
      return new;
    end if;
    raise exception 'PO % is already issued and locked. It can only be cancelled.', old.po_no using errcode = 'P0001';
  end if;

  -- old.status = 'draft'
  new.po_no := old.po_no;              -- the number never changes
  if new.status = 'cancelled' then
    raise exception 'Drafts are deleted, not cancelled.' using errcode = 'P0001';
  end if;

  select * into t from public.po_compute_totals(new.id, new.vat_mode, new.discount, new.ewt_rate);
  new.subtotal := t.o_subtotal; new.vat_amount := t.o_vat; new.total := t.o_total;
  new.ewt_amount := t.o_ewt; new.net_payable := t.o_net;

  if new.status = 'issued' then
    if new.supplier_id is null then
      raise exception 'Choose a supplier before issuing.' using errcode = 'P0001';
    end if;
    if not exists (select 1 from public.purchase_order_items where po_id = new.id) then
      raise exception 'Add at least one item before issuing.' using errcode = 'P0001';
    end if;
    if new.approved_by_id is null then
      raise exception 'Choose who approves this PO before issuing.' using errcode = 'P0001';
    end if;

    select s.*, c.name as c_name, c.position as c_position, c.mobile as c_mobile, c.email as c_email
      into pc
      from public.suppliers s
      left join lateral (
        select * from public.supplier_contacts sc
        where sc.supplier_id = s.id order by sc.is_primary desc, sc.created_at limit 1
      ) c on true
      where s.id = new.supplier_id;
    new.supplier_snapshot := jsonb_build_object(
      'code', pc.code, 'name', pc.name, 'trade_name', pc.trade_name,
      'address', pc.address, 'city', pc.city, 'tin', pc.tin,
      'vat_registered', pc.vat_registered, 'payment_terms', pc.payment_terms,
      'contact_name', coalesce(pc.c_name, ''), 'contact_position', coalesce(pc.c_position, ''),
      'contact_mobile', coalesce(pc.c_mobile, ''), 'contact_email', coalesce(pc.c_email, ''));
    new.prepared_snapshot := (select jsonb_build_object('name', name, 'position', position, 'signature_path', signature_path)
                              from public.po_signatories where id = new.prepared_by_id);
    new.approved_snapshot := (select jsonb_build_object('name', name, 'position', position, 'signature_path', signature_path)
                              from public.po_signatories where id = new.approved_by_id);
    new.company_snapshot  := (select data from public.po_settings where id = 1);
    new.issued_at := now();
  end if;
  return new;
end;
$$;
drop trigger if exists purchase_orders_a_guard on public.purchase_orders;
create trigger purchase_orders_a_guard
  before update on public.purchase_orders
  for each row execute function public.po_before_update();

drop trigger if exists purchase_orders_set_updated_at on public.purchase_orders;
create trigger purchase_orders_set_updated_at
  before update on public.purchase_orders
  for each row execute function public.purch_touch_updated_at();

create or replace function public.po_before_delete()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.status <> 'draft' then
    raise exception 'PO % is %. Only drafts can be deleted — cancel it instead.', old.po_no, old.status using errcode = 'P0001';
  end if;
  return old;
end;
$$;
drop trigger if exists purchase_orders_guard_delete on public.purchase_orders;
create trigger purchase_orders_guard_delete
  before delete on public.purchase_orders
  for each row execute function public.po_before_delete();

-- ---------- items: only on drafts; keep header totals current ----------
create or replace function public.po_items_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  st text;
  pid uuid := coalesce(new.po_id, old.po_id);
begin
  select status into st from public.purchase_orders where id = pid;
  -- st is null while a draft PO's own delete cascades to its items
  if st is not null and st <> 'draft' then
    raise exception 'Items of an issued or cancelled PO can''t be changed.' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and new.po_id <> old.po_id then
    raise exception 'Items can''t be moved to another PO.' using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end;
$$;
drop trigger if exists purchase_order_items_guard on public.purchase_order_items;
create trigger purchase_order_items_guard
  before insert or update or delete on public.purchase_order_items
  for each row execute function public.po_items_guard();

create or replace function public.po_items_touch_parent()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Re-saving the draft header runs po_before_update, which recomputes totals.
  update public.purchase_orders set updated_at = now()
   where id = coalesce(new.po_id, old.po_id) and status = 'draft';
  return null;
end;
$$;
drop trigger if exists purchase_order_items_touch_parent on public.purchase_order_items;
create trigger purchase_order_items_touch_parent
  after insert or update or delete on public.purchase_order_items
  for each row execute function public.po_items_touch_parent();

-- =====================================================================
-- 4. Storage: logo + signatures (private, admin-only)
-- =====================================================================
insert into storage.buckets (id, name, public)
values ('purchasing-assets', 'purchasing-assets', false)
on conflict (id) do nothing;

drop policy if exists purch_assets_admin_select on storage.objects;
create policy purch_assets_admin_select on storage.objects
  for select to authenticated using (bucket_id = 'purchasing-assets' and public.is_admin());
drop policy if exists purch_assets_admin_insert on storage.objects;
create policy purch_assets_admin_insert on storage.objects
  for insert to authenticated with check (bucket_id = 'purchasing-assets' and public.is_admin());
-- no delete policy on purpose: issued POs point at old logo/signature files

-- =====================================================================
-- 5. RLS + grants
-- =====================================================================
alter table public.po_settings             enable row level security;
alter table public.po_signatories          enable row level security;
alter table public.purchase_order_counters enable row level security;
alter table public.purchase_orders         enable row level security;
alter table public.purchase_order_items    enable row level security;

drop policy if exists po_settings_admin_all on public.po_settings;
create policy po_settings_admin_all on public.po_settings
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists po_signatories_admin_all on public.po_signatories;
create policy po_signatories_admin_all on public.po_signatories
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists purchase_orders_admin_all on public.purchase_orders;
create policy purchase_orders_admin_all on public.purchase_orders
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists purchase_order_items_admin_all on public.purchase_order_items;
create policy purchase_order_items_admin_all on public.purchase_order_items
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
-- purchase_order_counters: no policies → only the security-definer trigger touches it

grant select, insert, update on public.po_settings to authenticated;
grant select, insert, update, delete on public.po_signatories, public.purchase_orders, public.purchase_order_items to authenticated;
revoke all on public.po_settings, public.po_signatories, public.purchase_order_counters,
              public.purchase_orders, public.purchase_order_items from anon;
revoke all on public.purchase_order_counters from authenticated;

-- =====================================================================
-- 6. Realtime
-- =====================================================================
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['purchase_orders', 'purchase_order_items', 'po_signatories', 'po_settings'] loop
      if not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

NOTIFY pgrst, 'reload schema';

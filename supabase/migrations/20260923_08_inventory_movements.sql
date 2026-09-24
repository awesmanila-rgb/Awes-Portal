-- ---------------------------------------------------------------------
-- Inventory — Phase 2: movements
--
-- Documents (numbers per year):
--   stock_receipts   RCV-YYYY-NNNN  deliveries in — against a PO or not;
--                                   optionally "direct to site" (charged
--                                   straight to a project / job order)
--   issue_slips      ISS-YYYY-NNNN  materials out to a worker, for a project
--                                   / job order, optionally from an MRF;
--                                   the worker acknowledges on their phone
--   return_slips     RET-YYYY-NNNN  unused materials back (good → stock;
--                                   damaged → recorded, not restocked)
--   stock_transfers  TRF-YYYY-NNNN  between warehouses
--
-- ALL POSTING GOES THROUGH THE inv_post_* FUNCTIONS BELOW. The app can't
-- write these tables or the ledger directly. Each function:
--   * checks the caller is an admin, or the storekeeper of the warehouse;
--   * validates everything (PO status and remaining qty, MRF approval,
--     stock available — the ledger trigger refuses negative stock);
--   * writes the document, its lines and the stock_movements in ONE
--     transaction — any error and nothing is posted.
-- Costs are worked out HERE, never sent by a storekeeper:
--   receipt against a PO  unit price, less the PO discount share, net of VAT
--                         if the PO is VAT-inclusive, ÷ pack size when the PO
--                         line is in the purchase unit (1 roll = 50 ft)
--   issue / transfer      average cost (ledger trigger)
--   direct to site        the delivery's own cost; the warehouse average
--                         is left exactly as it was
--   return                the cost it was issued at, when the issue slip is
--                         given; else the current average cost
-- Slips carry quantities only; money lives in stock_movements (admin-only).
--
-- Depends on 20260923_03, _06 and _07. Safe to re-run.
-- ---------------------------------------------------------------------

do $$
begin
  if to_regclass('public.stock_movements') is null or to_regclass('public.material_requisitions') is null then
    raise exception 'Run 20260923_06 and 20260923_07 first.';
  end if;
end $$;

-- ---------- columns on existing tables ----------
alter table public.purchase_order_items add column if not exists qty_received numeric(14,3) not null default 0;
alter table public.material_requisition_items add column if not exists qty_issued numeric(14,3) not null default 0;
alter table public.material_requisition_items drop constraint if exists material_requisition_items_fulfilled_by_check;
alter table public.material_requisition_items add constraint material_requisition_items_fulfilled_by_check
  check (fulfilled_by is null or fulfilled_by in ('po', 'tech_buy', 'stock'));

-- ---------- ledger trigger: pass-through cost for direct-to-site deliveries ----------
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
  elsif current_setting('awes.inv_passthrough', true) = 'on' and new.unit_cost is not null then
    -- Direct-to-site delivery (set only by inv_post_receipt): the goods pass
    -- straight through, charged at THEIR cost. Removing exactly that value
    -- puts the average of the stock left behind back where it was.
    update public.stock_balances
       set avg_cost = case when new_qty > 0 then greatest(round((b.qty_on_hand * b.avg_cost + new.qty * new.unit_cost) / new_qty, 4), 0) else b.avg_cost end,
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

-- ---------- existing rules, with a narrow exception for posting ----------
create or replace function public.mr_items_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  admin boolean := public.is_admin();
  h record;
begin
  select status, requested_by into h from public.material_requisitions where id = coalesce(new.mr_id, old.mr_id);
  if h is null then return coalesce(new, old); end if;        -- parent draft being deleted (cascade)
  -- Inventory posting functions (validated, security definer) may record
  -- stock fulfilment on approved lines — and nothing else.
  if current_setting('awes.inv_posting', true) = 'on' then
    if tg_op = 'UPDATE' and h.status in ('approved', 'fulfilled')
       and (to_jsonb(new) - array['fulfilled_by', 'qty_issued']) = (to_jsonb(old) - array['fulfilled_by', 'qty_issued']) then
      return new;
    end if;
    raise exception 'Inventory posting may only record fulfilment on approved requests.' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and new.mr_id <> old.mr_id then
    raise exception 'Items can''t be moved to another request.' using errcode = 'P0001';
  end if;

  if not admin then
    if h.requested_by <> auth.uid() then raise exception 'Not your request.' using errcode = '42501'; end if;
    if h.status not in ('draft', 'returned') then
      raise exception 'Items can only be changed while the request is a draft or returned.' using errcode = 'P0001';
    end if;
    if tg_op <> 'DELETE' then
      new.qty_approved := case when tg_op = 'UPDATE' then old.qty_approved else null end;
      new.fulfilled_by := case when tg_op = 'UPDATE' then old.fulfilled_by else null end;
      new.po_id        := case when tg_op = 'UPDATE' then old.po_id else null end;
    end if;
    return coalesce(new, old);
  end if;

  -- admin: edit lines freely until approval; after approval only fulfilment
  if h.status in ('approved', 'fulfilled') then
    if tg_op <> 'UPDATE' or (to_jsonb(new) - array['fulfilled_by', 'po_id', 'qty_issued']) <> (to_jsonb(old) - array['fulfilled_by', 'po_id', 'qty_issued']) then
      raise exception 'An approved request''s items are locked — only fulfilment can change.' using errcode = 'P0001';
    end if;
  elsif h.status in ('rejected', 'cancelled') then
    raise exception 'This request is closed.' using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end;
$$;

create or replace function public.mr_before_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  admin boolean := public.is_admin();
  locked text[] := array['approved', 'rejected', 'cancelled', 'fulfilled'];
  sys text[] := array['status', 'updated_at', 'fulfilled_at', 'cancelled_at'];
begin
  if current_setting('awes.inv_posting', true) = 'on' then
    if old.status in ('approved', 'fulfilled') and new.status in ('approved', 'fulfilled')
       and (to_jsonb(new) - sys) = (to_jsonb(old) - sys) then
      if new.status = 'fulfilled' and old.status <> 'fulfilled' then new.fulfilled_at := now(); end if;
      if new.status = 'approved' then new.fulfilled_at := null; end if;
      return new;
    end if;
    raise exception 'Inventory posting may only update fulfilment status.' using errcode = 'P0001';
  end if;
  new.mrf_no := old.mrf_no;
  new.requested_by := old.requested_by;
  new.requester_name := old.requester_name;
  new.created_at := old.created_at;

  if not admin then
    if old.requested_by <> auth.uid() then
      raise exception 'Not your request.' using errcode = '42501';
    end if;
    -- review fields are never the technician's to set
    new.review_note := old.review_note; new.reviewed_by := old.reviewed_by;
    new.reviewer_name := old.reviewer_name; new.reviewed_at := old.reviewed_at;
    new.fulfilled_at := old.fulfilled_at;
    if new.status = 'cancelled' and old.status in ('draft', 'submitted', 'returned') then
      new.cancelled_at := now();
      return new;
    end if;
    if old.status not in ('draft', 'returned') then
      raise exception 'This request is % and can no longer be changed.', old.status using errcode = 'P0001';
    end if;
    if new.status not in ('draft', 'returned', 'submitted') then
      raise exception 'Only an admin can mark a request as %.', new.status using errcode = 'P0001';
    end if;
    if new.status = 'submitted' then
      if not exists (select 1 from public.material_requisition_items where mr_id = new.id) then
        raise exception 'Add at least one item before submitting.' using errcode = 'P0001';
      end if;
      new.submitted_at := now();
    elsif new.status = 'returned' and old.status = 'draft' then
      new.status := 'draft';
    end if;
    return new;
  end if;

  -- ---- admin ----
  if old.status = any(locked) then
    -- only fulfilment bookkeeping moves on after approval
    if old.status in ('approved', 'fulfilled') and new.status in ('approved', 'fulfilled', 'cancelled')
       and (to_jsonb(new) - sys) = (to_jsonb(old) - sys) then
      if new.status = 'cancelled' and old.status <> 'cancelled' then new.cancelled_at := now(); end if;
      if new.status = 'fulfilled' and old.status <> 'fulfilled' then new.fulfilled_at := now(); end if;
      if new.status = 'approved' then new.fulfilled_at := null; end if;
      return new;
    end if;
    raise exception 'Request % is % and locked.', old.mrf_no, old.status using errcode = 'P0001';
  end if;

  if new.status is distinct from old.status then
    if new.status in ('approved', 'rejected', 'returned') then
      if old.status <> 'submitted' then
        raise exception 'Only a submitted request can be %.', new.status using errcode = 'P0001';
      end if;
      if new.status in ('rejected', 'returned') and coalesce(trim(new.review_note), '') = '' then
        raise exception 'Give the technician a reason.' using errcode = 'P0001';
      end if;
      new.reviewed_by := auth.uid();
      new.reviewer_name := coalesce((select name from public.profiles where id = auth.uid()), 'Admin');
      new.reviewed_at := now();
      if new.status = 'approved' then
        -- anything the admin didn't adjust is approved as requested
        update public.material_requisition_items set qty_approved = qty_requested
         where mr_id = new.id and qty_approved is null;
      end if;
    elsif new.status = 'cancelled' then
      new.cancelled_at := now();
    elsif new.status = 'submitted' and old.status in ('draft', 'returned') then
      new.submitted_at := now();
    elsif new.status = 'fulfilled' then
      raise exception 'A request becomes fulfilled when all its lines are covered.' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.mr_refresh_fulfilment(p_mr uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  st text;
  open_lines int;
begin
  select status into st from public.material_requisitions where id = p_mr;
  if st not in ('approved', 'fulfilled') then return; end if;
  select count(*) into open_lines
    from public.material_requisition_items i
    left join public.purchase_orders p on p.id = i.po_id
   where i.mr_id = p_mr
     and coalesce(i.qty_approved, i.qty_requested) > 0
     -- coalesce: a NULL here would make the line "unknown" and silently
     -- drop it from the count, closing the request too early
     and not (coalesce(i.fulfilled_by, '') = 'tech_buy'
              or (coalesce(i.fulfilled_by, '') = 'stock' and coalesce(i.qty_issued, 0) >= coalesce(i.qty_approved, i.qty_requested))
              or (i.po_id is not null and coalesce(p.status, '') <> 'cancelled'));
  if open_lines = 0 and st = 'approved' then
    update public.material_requisitions set status = 'fulfilled' where id = p_mr;
  elsif open_lines > 0 and st = 'fulfilled' then
    update public.material_requisitions set status = 'approved' where id = p_mr;
  end if;
end;
$$;

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
  -- Receiving (inventory posting function) records deliveries on an
  -- issued PO's lines — qty_received only; everything else stays locked.
  if current_setting('awes.inv_posting', true) = 'on' then
    if tg_op = 'UPDATE' and st = 'issued'
       -- 'amount' is a generated column: it's still empty in NEW at this point
       -- (it's computed after the trigger), and it follows qty × unit_price,
       -- which ARE compared — so leaving it out lets nothing else through.
       and (to_jsonb(new) - array['qty_received', 'amount']) = (to_jsonb(old) - array['qty_received', 'amount']) then
      return new;
    end if;
    raise exception 'Receiving may only record received quantities on an issued PO.' using errcode = 'P0001';
  end if;
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

-- Storekeepers can read approved requests (to issue from stock) — read only.
drop policy if exists mr_select_storekeeper on public.material_requisitions;
create policy mr_select_storekeeper on public.material_requisitions
  for select to authenticated using (public.inv_is_storekeeper() and status in ('approved', 'fulfilled'));
drop policy if exists mr_items_select_storekeeper on public.material_requisition_items;
create policy mr_items_select_storekeeper on public.material_requisition_items
  for select to authenticated using (public.inv_is_storekeeper() and exists (
    select 1 from public.material_requisitions m where m.id = mr_id and m.status in ('approved', 'fulfilled')));

-- =====================================================================
-- Numbering
-- =====================================================================
create table if not exists public.inv_counters (doc text not null, year int not null, last_no int not null default 0, primary key (doc, year));
create or replace function public.inv_next_no(p_prefix text)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare y int := extract(year from (now() at time zone 'Asia/Manila'))::int; n int;
begin
  insert into public.inv_counters as c (doc, year, last_no) values (p_prefix, y, 1)
    on conflict (doc, year) do update set last_no = c.last_no + 1 returning last_no into n;
  return p_prefix || '-' || y || '-' || lpad(n::text, 4, '0');
end; $$;

-- =====================================================================
-- Document tables (quantities only — no money)
-- =====================================================================
create table if not exists public.stock_receipts (
  id                  uuid primary key default gen_random_uuid(),
  receipt_no          text unique not null,
  warehouse_id        uuid not null references public.warehouses(id),
  po_id               uuid references public.purchase_orders(id),
  supplier_id         uuid references public.suppliers(id),
  supplier_ref        text not null default '',      -- DR / invoice no.
  direct_project_id   uuid references public.projects(id),
  direct_job_order_id text,
  note                text not null default '',
  received_by         uuid references auth.users(id) default auth.uid(),
  received_by_name    text not null default '',
  created_at          timestamptz not null default now()
);
create table if not exists public.stock_receipt_items (
  id            uuid primary key default gen_random_uuid(),
  receipt_id    uuid not null references public.stock_receipts(id) on delete restrict,
  line_no       int not null,
  material_id   uuid not null references public.materials(id),
  po_item_id    uuid references public.purchase_order_items(id),
  qty           numeric(14,3) not null check (qty > 0),     -- in the item's unit (ft)
  qty_po_units  numeric(14,3),                              -- as on the PO (roll)
  po_unit       text not null default ''
);
create table if not exists public.issue_slips (
  id                  uuid primary key default gen_random_uuid(),
  slip_no             text unique not null,
  warehouse_id        uuid not null references public.warehouses(id),
  worker_id           uuid not null references auth.users(id),
  worker_name         text not null default '',
  project_id          uuid references public.projects(id),
  job_order_id        text,
  mr_id               uuid references public.material_requisitions(id),
  note                text not null default '',
  status              text not null default 'issued' check (status in ('issued', 'acknowledged')),
  ack_at              timestamptz,
  ack_signature_path  text not null default '',
  issued_by           uuid references auth.users(id) default auth.uid(),
  issued_by_name      text not null default '',
  created_at          timestamptz not null default now()
);
create index if not exists issue_slips_worker_idx on public.issue_slips (worker_id, created_at desc);
create table if not exists public.issue_slip_items (
  id           uuid primary key default gen_random_uuid(),
  slip_id      uuid not null references public.issue_slips(id) on delete restrict,
  line_no      int not null,
  material_id  uuid not null references public.materials(id),
  qty          numeric(14,3) not null check (qty > 0),
  mr_item_id   uuid references public.material_requisition_items(id)
);
create table if not exists public.return_slips (
  id                uuid primary key default gen_random_uuid(),
  return_no         text unique not null,
  warehouse_id      uuid not null references public.warehouses(id),
  worker_id         uuid references auth.users(id),
  worker_name       text not null default '',
  project_id        uuid references public.projects(id),
  job_order_id      text,
  issue_slip_id     uuid references public.issue_slips(id),
  note              text not null default '',
  received_by       uuid references auth.users(id) default auth.uid(),
  received_by_name  text not null default '',
  created_at        timestamptz not null default now()
);
create table if not exists public.return_slip_items (
  id           uuid primary key default gen_random_uuid(),
  return_id    uuid not null references public.return_slips(id) on delete restrict,
  line_no      int not null,
  material_id  uuid not null references public.materials(id),
  qty          numeric(14,3) not null check (qty > 0),
  condition    text not null default 'good' check (condition in ('good', 'damaged'))
);
create table if not exists public.stock_transfers (
  id                 uuid primary key default gen_random_uuid(),
  transfer_no        text unique not null,
  from_warehouse_id  uuid not null references public.warehouses(id),
  to_warehouse_id    uuid not null references public.warehouses(id),
  note               text not null default '',
  created_by         uuid references auth.users(id) default auth.uid(),
  created_by_name    text not null default '',
  created_at         timestamptz not null default now(),
  check (from_warehouse_id <> to_warehouse_id)
);
create table if not exists public.stock_transfer_items (
  id           uuid primary key default gen_random_uuid(),
  transfer_id  uuid not null references public.stock_transfers(id) on delete restrict,
  line_no      int not null,
  material_id  uuid not null references public.materials(id),
  qty          numeric(14,3) not null check (qty > 0)
);

-- =====================================================================
-- Helpers
-- =====================================================================
create or replace function public.inv_can_handle(p_warehouse uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public.is_admin() or public.inv_is_storekeeper_of(p_warehouse);
$$;
create or replace function public.inv_my_name()
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select name from public.profiles where id = auth.uid()), '');
$$;
create or replace function public.inv_require_warehouse(p_warehouse uuid)
returns void language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from public.warehouses where id = p_warehouse and is_active) then
    raise exception 'That warehouse doesn''t exist or is inactive.' using errcode = 'P0001';
  end if;
  if not public.inv_can_handle(p_warehouse) then
    raise exception 'You''re not a storekeeper of that warehouse.' using errcode = '42501';
  end if;
end; $$;

-- =====================================================================
-- RECEIVE
-- p: {warehouse_id, po_id?, supplier_id?, supplier_ref?, note?,
--     direct_project_id?, direct_job_order_id?,
--     lines:[{po_item_id?, material_id?, qty, unit_cost?}]}
--   against a PO: qty is in the PO line's unit; cost comes from the PO
--   without a PO: qty in the item's unit; unit_cost honoured for admins
--                 only (a storekeeper's receipt is valued at average cost)
-- =====================================================================
create or replace function public.inv_post_receipt(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  wh uuid := (p->>'warehouse_id')::uuid;
  po record; poi record; mat record;
  l jsonb; i int := 0;
  rid uuid; rno text;
  v_qty numeric; base numeric; conv numeric; cost numeric; vf numeric; df numeric;
  dproj uuid := nullif(p->>'direct_project_id', '')::uuid;
  djob text := nullif(p->>'direct_job_order_id', '');
  direct boolean;
begin
  select * into po from public.purchase_orders where false;   -- empty row: "no PO" without an unassigned record
  perform public.inv_require_warehouse(wh);
  direct := dproj is not null or djob is not null;
  if direct and not public.is_admin() then
    raise exception 'Only an admin can receive straight to a project.' using errcode = '42501';
  end if;
  if jsonb_array_length(coalesce(p->'lines', '[]')) = 0 then
    raise exception 'Add at least one line.' using errcode = 'P0001';
  end if;
  if p->>'po_id' is not null then
    select * into po from public.purchase_orders where id = (p->>'po_id')::uuid;
    if po is null then raise exception 'PO not found.' using errcode = 'P0001'; end if;
    if po.status <> 'issued' then
      raise exception 'Only issued POs can be received (% is %).', po.po_no, po.status using errcode = 'P0001';
    end if;
    vf := case when po.vat_mode = 'inclusive' then 1 / 1.12 else 1 end;
    df := case when po.subtotal > 0 then greatest(po.subtotal - po.discount, 0) / po.subtotal else 1 end;
  end if;
  perform set_config('awes.inv_posting', 'on', true);

  rno := public.inv_next_no('RCV');
  insert into public.stock_receipts (receipt_no, warehouse_id, po_id, supplier_id, supplier_ref, direct_project_id, direct_job_order_id, note, received_by_name)
  values (rno, wh, po.id, coalesce(po.supplier_id, nullif(p->>'supplier_id', '')::uuid), coalesce(p->>'supplier_ref', ''),
          dproj, djob, coalesce(p->>'note', ''), public.inv_my_name())
  returning id into rid;

  for l in select * from jsonb_array_elements(p->'lines') loop
    i := i + 1;
    v_qty := (l->>'qty')::numeric;
    if v_qty is null or v_qty <= 0 then raise exception 'Line %: enter a quantity above 0.', i using errcode = 'P0001'; end if;
    if po.id is not null then
      select * into poi from public.purchase_order_items where id = (l->>'po_item_id')::uuid and po_id = po.id for update;
      if poi is null then raise exception 'Line %: not a line of %.', i, po.po_no using errcode = 'P0001'; end if;
      if v_qty > poi.qty - poi.qty_received then
        raise exception '%: only % % left to receive on %.', poi.description, trim_scale(poi.qty - poi.qty_received), poi.unit, po.po_no using errcode = 'P0001';
      end if;
      select * into mat from public.materials where id = coalesce(poi.material_id, nullif(l->>'material_id', '')::uuid);
      if mat is null then
        raise exception '"%" isn''t in the Materials Database — choose which catalog item it is before receiving.', poi.description using errcode = 'P0001';
      end if;
      conv := case when mat.pack_qty > 0 and lower(trim(poi.unit)) = lower(trim(coalesce(mat.pack_unit, ''))) then mat.pack_qty else 1 end;
      base := v_qty * conv;
      cost := poi.unit_price * vf * df / conv;
      update public.purchase_order_items set qty_received = qty_received + v_qty where id = poi.id;
      insert into public.stock_receipt_items (receipt_id, line_no, material_id, po_item_id, qty, qty_po_units, po_unit)
      values (rid, i, mat.id, poi.id, base, v_qty, poi.unit);
    else
      select * into mat from public.materials where id = (l->>'material_id')::uuid;
      if mat is null then raise exception 'Line %: choose an item.', i using errcode = 'P0001'; end if;
      base := v_qty;
      cost := case when public.is_admin() then nullif(l->>'unit_cost', '')::numeric else null end;
      insert into public.stock_receipt_items (receipt_id, line_no, material_id, qty) values (rid, i, mat.id, base);
    end if;
    insert into public.stock_movements (doc_type, doc_ref, doc_id, warehouse_id, material_id, qty, unit_cost, note)
    values ('receipt', rno, rid, wh, mat.id, base, cost, coalesce(p->>'supplier_ref', ''))
    returning unit_cost into cost;                   -- the cost actually booked (average if none given)
    if direct then
      perform set_config('awes.inv_passthrough', 'on', true);
      insert into public.stock_movements (doc_type, doc_ref, doc_id, warehouse_id, material_id, qty, unit_cost, project_id, job_order_id, note)
      values ('issue', rno, rid, wh, mat.id, -base, cost, dproj, djob, 'Delivered direct to site');
      perform set_config('awes.inv_passthrough', 'off', true);
    end if;
  end loop;
  return jsonb_build_object('id', rid, 'receipt_no', rno);
end; $$;

-- =====================================================================
-- ISSUE  p: {warehouse_id, worker_id, project_id?, job_order_id?, mr_id?, note?,
--            lines:[{material_id, qty, mr_item_id?}]}
-- =====================================================================
create or replace function public.inv_post_issue(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  wh uuid := (p->>'warehouse_id')::uuid;
  wk uuid := nullif(p->>'worker_id', '')::uuid;
  wname text;
  mr record; mi record;
  proj uuid := nullif(p->>'project_id', '')::uuid;
  job text := nullif(p->>'job_order_id', '');
  l jsonb; i int := 0; sid uuid; sno text; v_qty numeric; mat uuid;
begin
  select * into mr from public.material_requisitions where false;
  perform public.inv_require_warehouse(wh);
  select name into wname from public.profiles where id = wk and coalesce(active, true);
  if wname is null then raise exception 'Choose who the materials are issued to.' using errcode = 'P0001'; end if;
  if jsonb_array_length(coalesce(p->'lines', '[]')) = 0 then raise exception 'Add at least one line.' using errcode = 'P0001'; end if;
  if p->>'mr_id' is not null then
    select * into mr from public.material_requisitions where id = (p->>'mr_id')::uuid;
    if mr is null or mr.status not in ('approved', 'fulfilled') then
      raise exception 'That request isn''t approved.' using errcode = 'P0001';
    end if;
    job := coalesce(job, mr.job_order_id);
  end if;
  if proj is null and job is not null then
    select project_id into proj from public.project_job_orders where job_order_id = job;
  end if;
  perform set_config('awes.inv_posting', 'on', true);
  sno := public.inv_next_no('ISS');
  insert into public.issue_slips (slip_no, warehouse_id, worker_id, worker_name, project_id, job_order_id, mr_id, note, issued_by_name)
  values (sno, wh, wk, wname, proj, job, mr.id, coalesce(p->>'note', ''), public.inv_my_name())
  returning id into sid;
  for l in select * from jsonb_array_elements(p->'lines') loop
    i := i + 1;
    v_qty := (l->>'qty')::numeric; mat := (l->>'material_id')::uuid;
    if v_qty is null or v_qty <= 0 then raise exception 'Line %: enter a quantity above 0.', i using errcode = 'P0001'; end if;
    if not exists (select 1 from public.materials where id = mat) then raise exception 'Line %: choose an item.', i using errcode = 'P0001'; end if;
    if l->>'mr_item_id' is not null then
      select * into mi from public.material_requisition_items where id = (l->>'mr_item_id')::uuid and mr_id = mr.id for update;
      if mi is null then raise exception 'Line %: not a line of that request.', i using errcode = 'P0001'; end if;
      if mi.material_id is distinct from mat then raise exception 'Line %: item doesn''t match the request.', i using errcode = 'P0001'; end if;
      if mi.qty_issued + v_qty > coalesce(mi.qty_approved, mi.qty_requested) then
        raise exception '%: only % left to issue on %.', mi.description, trim_scale(coalesce(mi.qty_approved, mi.qty_requested) - mi.qty_issued), mr.mrf_no using errcode = 'P0001';
      end if;
      update public.material_requisition_items
         set qty_issued = qty_issued + v_qty,
             fulfilled_by = case when qty_issued + v_qty >= coalesce(qty_approved, qty_requested) then 'stock' else fulfilled_by end
       where id = mi.id;
    end if;
    insert into public.issue_slip_items (slip_id, line_no, material_id, qty, mr_item_id) values (sid, i, mat, v_qty, nullif(l->>'mr_item_id', '')::uuid);
    -- the ledger trigger refuses this if there isn't enough stock
    insert into public.stock_movements (doc_type, doc_ref, doc_id, warehouse_id, material_id, qty, project_id, job_order_id, worker_id)
    values ('issue', sno, sid, wh, mat, -v_qty, proj, job, wk);
  end loop;
  return jsonb_build_object('id', sid, 'slip_no', sno);
end; $$;

-- =====================================================================
-- RETURN  p: {warehouse_id, worker_id?, project_id?, job_order_id?, issue_slip_id?, note?,
--             lines:[{material_id, qty, condition}]}
-- =====================================================================
create or replace function public.inv_post_return(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  wh uuid := (p->>'warehouse_id')::uuid;
  wk uuid := nullif(p->>'worker_id', '')::uuid;
  iss record;
  proj uuid := nullif(p->>'project_id', '')::uuid;
  job text := nullif(p->>'job_order_id', '');
  l jsonb; i int := 0; rid uuid; rno text; v_qty numeric; mat uuid; cond text; cost numeric; outq numeric;
begin
  select * into iss from public.issue_slips where false;
  perform public.inv_require_warehouse(wh);
  if jsonb_array_length(coalesce(p->'lines', '[]')) = 0 then raise exception 'Add at least one line.' using errcode = 'P0001'; end if;
  if p->>'issue_slip_id' is not null then
    select * into iss from public.issue_slips where id = (p->>'issue_slip_id')::uuid;
    if iss is null then raise exception 'Issue slip not found.' using errcode = 'P0001'; end if;
    wk := coalesce(wk, iss.worker_id); proj := coalesce(proj, iss.project_id); job := coalesce(job, iss.job_order_id);
  end if;
  if proj is null and job is not null then select project_id into proj from public.project_job_orders where job_order_id = job; end if;
  rno := public.inv_next_no('RET');
  insert into public.return_slips (return_no, warehouse_id, worker_id, worker_name, project_id, job_order_id, issue_slip_id, note, received_by_name)
  values (rno, wh, wk, coalesce((select name from public.profiles where id = wk), ''), proj, job, iss.id, coalesce(p->>'note', ''), public.inv_my_name())
  returning id into rid;
  for l in select * from jsonb_array_elements(p->'lines') loop
    i := i + 1;
    v_qty := (l->>'qty')::numeric; mat := (l->>'material_id')::uuid; cond := coalesce(nullif(l->>'condition', ''), 'good');
    if v_qty is null or v_qty <= 0 then raise exception 'Line %: enter a quantity above 0.', i using errcode = 'P0001'; end if;
    if iss.id is not null then
      select coalesce(sum(qty), 0) into outq from public.issue_slip_items where slip_id = iss.id and material_id = mat;
      if outq = 0 then raise exception 'Line %: that item wasn''t on %.', i, iss.slip_no using errcode = 'P0001'; end if;
      if v_qty + coalesce((select sum(ri.qty) from public.return_slip_items ri join public.return_slips r on r.id = ri.return_id
                          where r.issue_slip_id = iss.id and ri.material_id = mat), 0) > outq then
        raise exception 'Line %: more than was issued on %.', i, iss.slip_no using errcode = 'P0001';
      end if;
      select unit_cost into cost from public.stock_movements where doc_id = iss.id and material_id = mat and doc_type = 'issue' limit 1;
    else
      cost := null;
    end if;
    insert into public.return_slip_items (return_id, line_no, material_id, qty, condition) values (rid, i, mat, v_qty, cond);
    -- good items go back on the shelf and are credited to the project;
    -- damaged ones are recorded only (they stay charged to the project)
    if cond = 'good' then
      insert into public.stock_movements (doc_type, doc_ref, doc_id, warehouse_id, material_id, qty, unit_cost, project_id, job_order_id, worker_id)
      values ('return', rno, rid, wh, mat, v_qty, cost, proj, job, wk);
    end if;
  end loop;
  return jsonb_build_object('id', rid, 'return_no', rno);
end; $$;

-- =====================================================================
-- TRANSFER  p: {from_warehouse_id, to_warehouse_id, note?, lines:[{material_id, qty}]}
-- =====================================================================
create or replace function public.inv_post_transfer(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  f uuid := (p->>'from_warehouse_id')::uuid; t uuid := (p->>'to_warehouse_id')::uuid;
  l jsonb; i int := 0; tid uuid; tno text; v_qty numeric; mat uuid; cost numeric;
begin
  perform public.inv_require_warehouse(f);
  if f = t then raise exception 'Choose a different destination warehouse.' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.warehouses where id = t and is_active) then
    raise exception 'The destination warehouse doesn''t exist or is inactive.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(coalesce(p->'lines', '[]')) = 0 then raise exception 'Add at least one line.' using errcode = 'P0001'; end if;
  tno := public.inv_next_no('TRF');
  insert into public.stock_transfers (transfer_no, from_warehouse_id, to_warehouse_id, note, created_by_name)
  values (tno, f, t, coalesce(p->>'note', ''), public.inv_my_name()) returning id into tid;
  for l in select * from jsonb_array_elements(p->'lines') loop
    i := i + 1; v_qty := (l->>'qty')::numeric; mat := (l->>'material_id')::uuid;
    if v_qty is null or v_qty <= 0 then raise exception 'Line %: enter a quantity above 0.', i using errcode = 'P0001'; end if;
    insert into public.stock_transfer_items (transfer_id, line_no, material_id, qty) values (tid, i, mat, v_qty);
    insert into public.stock_movements (doc_type, doc_ref, doc_id, warehouse_id, material_id, qty)
      values ('transfer_out', tno, tid, f, mat, -v_qty) returning unit_cost into cost;
    insert into public.stock_movements (doc_type, doc_ref, doc_id, warehouse_id, material_id, qty, unit_cost)
      values ('transfer_in', tno, tid, t, mat, v_qty, cost);
  end loop;
  return jsonb_build_object('id', tid, 'transfer_no', tno);
end; $$;

-- =====================================================================
-- ACKNOWLEDGE (the worker, on their phone)
-- =====================================================================
create or replace function public.inv_ack_issue(p_slip uuid, p_signature_path text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare s record;
begin
  select * into s from public.issue_slips where id = p_slip for update;
  if s is null or s.worker_id <> auth.uid() then raise exception 'That slip isn''t yours.' using errcode = '42501'; end if;
  if s.status = 'acknowledged' then return; end if;
  if coalesce(p_signature_path, '') = '' or split_part(p_signature_path, '/', 1) <> auth.uid()::text then
    raise exception 'Sign to acknowledge.' using errcode = 'P0001';
  end if;
  update public.issue_slips set status = 'acknowledged', ack_at = now(), ack_signature_path = p_signature_path where id = p_slip;
end; $$;

-- =====================================================================
-- Lookups for storekeepers (no prices)
-- =====================================================================
create or replace function public.inv_open_job_orders()
returns table (id text, cust_name text, site_address text)
language sql stable security definer set search_path = public, pg_temp as $$
  select d.id, coalesce(d.data->>'custName', ''), coalesce(d.data->>'siteAddress', '')
    from public.dispatch_tickets d
   where (public.is_admin() or public.inv_is_storekeeper())
     and coalesce(d.data->>'status', d.status, 'open') not in ('completed', 'closed', 'cancelled')
   order by d.created_at desc limit 500;
$$;
create or replace function public.inv_pos_to_receive()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', po.id, 'po_no', po.po_no, 'po_date', po.po_date, 'reference', po.reference,
           'supplier', coalesce(nullif(s.trade_name, ''), s.name),
           'items', (select jsonb_agg(jsonb_build_object('id', i.id, 'line_no', i.line_no, 'material_id', i.material_id,
                       'code', i.code, 'description', i.description, 'unit', i.unit, 'qty', i.qty, 'qty_received', i.qty_received) order by i.line_no)
                     from public.purchase_order_items i where i.po_id = po.id)
         ) order by po.po_date desc), '[]'::jsonb)
    from public.purchase_orders po left join public.suppliers s on s.id = po.supplier_id
   where (public.is_admin() or public.inv_is_storekeeper())
     and po.status = 'issued'
     and exists (select 1 from public.purchase_order_items i where i.po_id = po.id and i.qty_received < i.qty);
$$;
-- What a worker currently holds: issued − returned, per item and job.
create or replace function public.inv_worker_holdings(p_worker uuid)
returns table (material_id uuid, project_id uuid, job_order_id text, issued numeric, returned numeric, holding numeric)
language sql stable security definer set search_path = public, pg_temp as $$
  with o as (
    select it.material_id, s.project_id, s.job_order_id, sum(it.qty) q
      from public.issue_slips s join public.issue_slip_items it on it.slip_id = s.id
     where s.worker_id = p_worker group by 1, 2, 3),
  r as (
    select it.material_id, s.project_id, s.job_order_id, sum(it.qty) q
      from public.return_slips s join public.return_slip_items it on it.return_id = s.id
     where s.worker_id = p_worker group by 1, 2, 3)
  select o.material_id, o.project_id, o.job_order_id, o.q, coalesce(r.q, 0), o.q - coalesce(r.q, 0)
    from o left join r on r.material_id = o.material_id and r.project_id is not distinct from o.project_id
                     and r.job_order_id is not distinct from o.job_order_id
   where (public.is_admin() or public.inv_is_storekeeper() or p_worker = auth.uid())
     and o.q - coalesce(r.q, 0) > 0;
$$;

-- =====================================================================
-- Storage: acknowledgement signatures (worker writes own folder)
-- =====================================================================
insert into storage.buckets (id, name, public) values ('inventory-signatures', 'inventory-signatures', false) on conflict (id) do nothing;
drop policy if exists inv_sig_select on storage.objects;
create policy inv_sig_select on storage.objects for select to authenticated
  using (bucket_id = 'inventory-signatures' and (public.is_admin() or public.inv_is_storekeeper() or (storage.foldername(name))[1] = auth.uid()::text));
drop policy if exists inv_sig_insert on storage.objects;
create policy inv_sig_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'inventory-signatures' and (storage.foldername(name))[1] = auth.uid()::text);

-- =====================================================================
-- RLS: read-only for people involved; writes only via the functions
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array['inv_counters','stock_receipts','stock_receipt_items','issue_slips','issue_slip_items',
                           'return_slips','return_slip_items','stock_transfers','stock_transfer_items'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete on public.%I from authenticated', t);
  end loop;
end $$;
revoke all on public.inv_counters from authenticated;

drop policy if exists rcv_read on public.stock_receipts;
create policy rcv_read on public.stock_receipts for select to authenticated using (public.inv_can_handle(warehouse_id));
drop policy if exists rcv_items_read on public.stock_receipt_items;
create policy rcv_items_read on public.stock_receipt_items for select to authenticated
  using (exists (select 1 from public.stock_receipts r where r.id = receipt_id and public.inv_can_handle(r.warehouse_id)));
drop policy if exists iss_read on public.issue_slips;
create policy iss_read on public.issue_slips for select to authenticated using (public.inv_can_handle(warehouse_id) or worker_id = auth.uid());
drop policy if exists iss_items_read on public.issue_slip_items;
create policy iss_items_read on public.issue_slip_items for select to authenticated
  using (exists (select 1 from public.issue_slips s where s.id = slip_id and (public.inv_can_handle(s.warehouse_id) or s.worker_id = auth.uid())));
drop policy if exists ret_read on public.return_slips;
create policy ret_read on public.return_slips for select to authenticated using (public.inv_can_handle(warehouse_id) or worker_id = auth.uid());
drop policy if exists ret_items_read on public.return_slip_items;
create policy ret_items_read on public.return_slip_items for select to authenticated
  using (exists (select 1 from public.return_slips s where s.id = return_id and (public.inv_can_handle(s.warehouse_id) or s.worker_id = auth.uid())));
drop policy if exists trf_read on public.stock_transfers;
create policy trf_read on public.stock_transfers for select to authenticated
  using (public.inv_can_handle(from_warehouse_id) or public.inv_can_handle(to_warehouse_id));
drop policy if exists trf_items_read on public.stock_transfer_items;
create policy trf_items_read on public.stock_transfer_items for select to authenticated
  using (exists (select 1 from public.stock_transfers t where t.id = transfer_id and (public.inv_can_handle(t.from_warehouse_id) or public.inv_can_handle(t.to_warehouse_id))));

grant select on public.stock_receipts, public.stock_receipt_items, public.issue_slips, public.issue_slip_items,
                public.return_slips, public.return_slip_items, public.stock_transfers, public.stock_transfer_items to authenticated;
revoke all on function public.inv_post_receipt(jsonb), public.inv_post_issue(jsonb), public.inv_post_return(jsonb),
                       public.inv_post_transfer(jsonb), public.inv_ack_issue(uuid, text), public.inv_open_job_orders(),
                       public.inv_pos_to_receive(), public.inv_worker_holdings(uuid), public.inv_next_no(text) from public, anon;
grant execute on function public.inv_post_receipt(jsonb), public.inv_post_issue(jsonb), public.inv_post_return(jsonb),
                          public.inv_post_transfer(jsonb), public.inv_ack_issue(uuid, text), public.inv_open_job_orders(),
                          public.inv_pos_to_receive(), public.inv_worker_holdings(uuid) to authenticated;

do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['stock_receipts','issue_slips','return_slips','stock_transfers'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

NOTIFY pgrst, 'reload schema';

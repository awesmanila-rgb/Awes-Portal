-- =====================================================================
-- AWES App — workers buy and receive materials (materials rules, part 3)
--
--  * COLLECTOR: the person who will collect the materials for a request. The
--    requester names one (optional; defaults to the requester) and the office can
--    change it. They are told when goods arrive, the Issue screen pre-fills them, and
--    they may record a receipt. They do NOT gain access to the request itself.
--  * BUYER: for a line marked "tech buys", the office names WHO buys it — any worker
--    (defaults to the requester). The buyer records what they bought: store, quantity,
--    price, date and a receipt photo (mr_record_purchase).
--  * WORKER RECEIPT: the requester or collector of a request line that is on an ISSUED
--    PO records "I received this" (po_worker_receive). It counts toward the PO being
--    complete (qty_received) but adds NOTHING to warehouse stock — the goods are with
--    the worker. Warehouse stock goes up only through the storekeeper's / office's receipt.
--  * Purchased Items report: now also lists worker receipts (by the day recorded) and
--    worker purchases (by purchase date), next to warehouse receipts.
--
-- Nothing here is writable directly: the tables have read policies only and are written
-- by the functions below. Safe to re-run. Depends on 20260923_06/_08, 20261020_01, 20261022_01.
-- =====================================================================

-- ---------- who can be named (names only) ----------
create or replace function public.worker_names()
returns table (id uuid, name text, role text)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select p.id, p.name, p.role
    from public.profiles p
   where coalesce(p.active, true) and p.role in ('technician', 'staff')
     and exists (select 1 from public.profiles me where me.id = auth.uid() and me.role in ('technician', 'staff', 'admin'))
   order by p.name;
$$;
revoke execute on function public.worker_names() from public, anon;
grant execute on function public.worker_names() to authenticated;

-- ---------- collector ----------
create table if not exists public.material_requisition_collectors (
  mr_id         uuid primary key references public.material_requisitions(id) on delete cascade,
  collector_id  uuid not null references public.profiles(id) on delete cascade,
  set_by        uuid references public.profiles(id) on delete set null,
  set_at        timestamptz not null default now()
);
alter table public.material_requisition_collectors enable row level security;
drop policy if exists mr_collector_read on public.material_requisition_collectors;
create policy mr_collector_read on public.material_requisition_collectors for select to authenticated
  using (public.is_admin() or public.has_perm('pur.requisitions', 'view') or collector_id = auth.uid() or public.inv_is_storekeeper()
         or exists (select 1 from public.material_requisitions m where m.id = mr_id and m.requested_by = auth.uid()));

create or replace function public.mr_set_collector(p_mr uuid, p_collector uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare m record;
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  select * into m from public.material_requisitions where id = p_mr;
  if m is null then raise exception 'That request doesn''t exist.' using errcode = 'P0001'; end if;
  if not (public.is_admin() or public.has_perm('pur.requisitions', 'edit') or coalesce(m.requested_by = auth.uid(), false)) then
    raise exception 'Only the requester or the office can choose who collects.' using errcode = '42501';
  end if;
  if m.status in ('cancelled', 'rejected') then
    raise exception 'This request is closed.' using errcode = 'P0001';
  end if;
  if p_collector is null or p_collector = m.requested_by then
    delete from public.material_requisition_collectors where mr_id = p_mr;     -- the requester collects
    return;
  end if;
  if not exists (select 1 from public.profiles where id = p_collector and coalesce(active, true) and role in ('technician', 'staff')) then
    raise exception 'Choose an active worker.' using errcode = 'P0001';
  end if;
  insert into public.material_requisition_collectors (mr_id, collector_id, set_by) values (p_mr, p_collector, auth.uid())
  on conflict (mr_id) do update set collector_id = excluded.collector_id, set_by = excluded.set_by, set_at = now();
end;
$$;
revoke execute on function public.mr_set_collector(uuid, uuid) from public, anon;
grant execute on function public.mr_set_collector(uuid, uuid) to authenticated;

-- ---------- buyer (tech-buy lines) ----------
create table if not exists public.mr_item_buyers (
  mr_item_id  uuid primary key references public.material_requisition_items(id) on delete cascade,
  buyer_id    uuid not null references public.profiles(id) on delete cascade,
  set_by      uuid references public.profiles(id) on delete set null,
  set_at      timestamptz not null default now()
);
alter table public.mr_item_buyers enable row level security;
drop policy if exists mr_item_buyer_read on public.mr_item_buyers;
create policy mr_item_buyer_read on public.mr_item_buyers for select to authenticated
  using (public.is_admin() or public.has_perm('pur.requisitions', 'view') or buyer_id = auth.uid()
         or exists (select 1 from public.material_requisition_items i join public.material_requisitions m on m.id = i.mr_id
                     where i.id = mr_item_id and m.requested_by = auth.uid()));

create or replace function public.mr_item_buyer(p_item uuid)
returns uuid
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce((select buyer_id from public.mr_item_buyers where mr_item_id = p_item),
                  (select m.requested_by from public.material_requisition_items i join public.material_requisitions m on m.id = i.mr_id where i.id = p_item));
$$;
revoke execute on function public.mr_item_buyer(uuid) from public, anon;
grant execute on function public.mr_item_buyer(uuid) to authenticated;

create or replace function public.mr_set_buyer(p_item uuid, p_buyer uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare i record;
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if not (public.is_admin() or public.has_perm('pur.requisitions', 'edit')) then
    raise exception 'Only the office can choose who buys.' using errcode = '42501';
  end if;
  select * into i from public.material_requisition_items where id = p_item;
  if i is null then raise exception 'That line doesn''t exist.' using errcode = 'P0001'; end if;
  if coalesce(i.fulfilled_by, '') <> 'tech_buy' then
    raise exception 'Only a line marked "tech buys" has a buyer.' using errcode = 'P0001';
  end if;
  if p_buyer is null then
    delete from public.mr_item_buyers where mr_item_id = p_item;
    return;
  end if;
  if not exists (select 1 from public.profiles where id = p_buyer and coalesce(active, true) and role in ('technician', 'staff')) then
    raise exception 'Choose an active worker.' using errcode = 'P0001';
  end if;
  insert into public.mr_item_buyers (mr_item_id, buyer_id, set_by) values (p_item, p_buyer, auth.uid())
  on conflict (mr_item_id) do update set buyer_id = excluded.buyer_id, set_by = excluded.set_by, set_at = now();
end;
$$;
revoke execute on function public.mr_set_buyer(uuid, uuid) from public, anon;
grant execute on function public.mr_set_buyer(uuid, uuid) to authenticated;

-- ---------- worker purchases ----------
create table if not exists public.worker_purchases (
  id            uuid primary key default gen_random_uuid(),
  mr_id         uuid not null references public.material_requisitions(id) on delete restrict,
  mr_item_id    uuid not null references public.material_requisition_items(id) on delete restrict,
  material_id   uuid,
  code          text not null default '',
  description   text not null,
  unit          text not null default '',
  buyer_id      uuid not null references public.profiles(id),
  buyer_name    text not null default '',
  purchased_on  date not null default ((now() at time zone 'Asia/Manila')::date),
  store         text not null default '',
  qty           numeric(14,3) not null check (qty > 0),
  unit_price    numeric(14,2) not null default 0 check (unit_price >= 0),
  amount        numeric(14,2) generated always as (round(qty * unit_price, 2)) stored,
  receipt_path  text not null default '',
  note          text not null default '',
  job_order_id  text,
  created_at    timestamptz not null default now()
);
create index if not exists worker_purchases_item_idx on public.worker_purchases (mr_item_id);
create index if not exists worker_purchases_date_idx on public.worker_purchases (purchased_on);
alter table public.worker_purchases enable row level security;
drop policy if exists worker_purchases_read on public.worker_purchases;
create policy worker_purchases_read on public.worker_purchases for select to authenticated
  using (public.is_admin() or public.has_perm('pur.requisitions', 'view') or public.has_perm('pur.purchased_items', 'view')
         or buyer_id = auth.uid()
         or exists (select 1 from public.material_requisitions m where m.id = mr_id and m.requested_by = auth.uid()));

create or replace function public.mr_record_purchase(p jsonb)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  i record; m record; v_qty numeric; v_price numeric; v_date date; v_bought numeric; v_path text; v_id uuid;
  v_today date := (now() at time zone 'Asia/Manila')::date;
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  select * into i from public.material_requisition_items where id = nullif(p->>'mr_item_id', '')::uuid;
  if i is null then raise exception 'That line doesn''t exist.' using errcode = 'P0001'; end if;
  select * into m from public.material_requisitions where id = i.mr_id;
  if coalesce(i.fulfilled_by, '') <> 'tech_buy' or m.status not in ('approved', 'fulfilled') then
    raise exception 'This item isn''t waiting for you to buy.' using errcode = 'P0001';
  end if;
  if not (coalesce(public.mr_item_buyer(i.id) = auth.uid(), false) or public.is_admin() or public.has_perm('pur.requisitions', 'edit')) then
    raise exception 'Only the person assigned to buy this can record the purchase.' using errcode = '42501';
  end if;
  v_qty := (p->>'qty')::numeric; v_price := coalesce(nullif(p->>'unit_price', '')::numeric, 0);
  if v_qty is null or v_qty <= 0 then raise exception 'Enter how many you bought.' using errcode = 'P0001'; end if;
  if v_price < 0 then raise exception 'The price can''t be negative.' using errcode = 'P0001'; end if;
  v_date := coalesce(nullif(p->>'purchased_on', '')::date, v_today);
  if v_date > v_today then raise exception 'The purchase date is in the future.' using errcode = 'P0001'; end if;
  select coalesce(sum(qty), 0) into v_bought from public.worker_purchases where mr_item_id = i.id;
  if v_bought + v_qty > coalesce(i.qty_approved, i.qty_requested) then
    raise exception '%: only % left to buy (approved %).', i.description,
      trim_scale(greatest(coalesce(i.qty_approved, i.qty_requested) - v_bought, 0)), trim_scale(coalesce(i.qty_approved, i.qty_requested)) using errcode = 'P0001';
  end if;
  v_path := coalesce(p->>'receipt_path', '');
  if v_path <> '' and split_part(v_path, '/', 1) <> auth.uid()::text then
    raise exception 'The receipt photo has to be your own upload.' using errcode = 'P0001';
  end if;
  insert into public.worker_purchases (mr_id, mr_item_id, material_id, code, description, unit, buyer_id, buyer_name, purchased_on, store, qty, unit_price, receipt_path, note, job_order_id)
  values (m.id, i.id, i.material_id, coalesce(i.code, ''), i.description, coalesce(i.unit, ''), auth.uid(),
          coalesce((select name from public.profiles where id = auth.uid()), ''), v_date, coalesce(trim(p->>'store'), ''), v_qty, v_price, v_path, coalesce(trim(p->>'note'), ''), m.job_order_id)
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'left', greatest(coalesce(i.qty_approved, i.qty_requested) - v_bought - v_qty, 0));
end;
$$;
revoke execute on function public.mr_record_purchase(jsonb) from public, anon;
grant execute on function public.mr_record_purchase(jsonb) to authenticated;

-- ---------- worker receipts ----------
create table if not exists public.worker_receipts (
  id                uuid primary key default gen_random_uuid(),
  po_id             uuid not null references public.purchase_orders(id) on delete restrict,
  po_item_id        uuid not null references public.purchase_order_items(id) on delete restrict,
  mr_item_id        uuid references public.material_requisition_items(id) on delete set null,
  qty               numeric(14,3) not null check (qty > 0),
  unit              text not null default '',
  received_by       uuid not null references public.profiles(id),
  received_by_name  text not null default '',
  note              text not null default '',
  photo_path        text not null default '',
  job_order_id      text,
  created_at        timestamptz not null default now()
);
create index if not exists worker_receipts_item_idx on public.worker_receipts (po_item_id);
alter table public.worker_receipts enable row level security;
drop policy if exists worker_receipts_read on public.worker_receipts;
create policy worker_receipts_read on public.worker_receipts for select to authenticated
  using (public.is_admin() or public.has_perm('pur.purchase_orders', 'view') or public.has_perm('pur.requisitions', 'view')
         or public.has_perm('pur.purchased_items', 'view') or public.inv_is_storekeeper() or received_by = auth.uid());

create or replace function public.po_worker_receive(p jsonb)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  poi record; po record; mi record; v_qty numeric; v_path text; v_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  select * into poi from public.purchase_order_items where id = nullif(p->>'po_item_id', '')::uuid for update;
  if poi is null then raise exception 'That purchase order line doesn''t exist.' using errcode = 'P0001'; end if;
  select * into po from public.purchase_orders where id = poi.po_id;
  if po.status <> 'issued' then
    raise exception 'Only an issued PO can be received (% is %).', po.po_no, po.status using errcode = 'P0001';
  end if;
  -- only someone who asked for these materials, or is to collect them
  select i.* into mi
    from public.material_requisition_items i
    join public.material_requisitions m on m.id = i.mr_id
    left join public.material_requisition_collectors c on c.mr_id = m.id
   where i.po_id = poi.po_id and i.material_id is not distinct from poi.material_id
     and m.status in ('approved', 'fulfilled')
     and (m.requested_by = auth.uid() or c.collector_id = auth.uid())
   order by m.created_at limit 1;
  if mi is null then
    raise exception 'Only the person who asked for these materials, or who is to collect them, can record this receipt.' using errcode = '42501';
  end if;
  v_qty := (p->>'qty')::numeric;
  if v_qty is null or v_qty <= 0 then raise exception 'Enter how many you received.' using errcode = 'P0001'; end if;
  if v_qty > poi.qty - poi.qty_received then
    raise exception '%: only % % left to receive on %.', poi.description, trim_scale(poi.qty - poi.qty_received), poi.unit, po.po_no using errcode = 'P0001';
  end if;
  v_path := coalesce(p->>'photo_path', '');
  if v_path <> '' and split_part(v_path, '/', 1) <> auth.uid()::text then
    raise exception 'The photo has to be your own upload.' using errcode = 'P0001';
  end if;
  perform set_config('awes.inv_posting', 'on', true);      -- same switch the warehouse receipt uses: only qty_received may change
  update public.purchase_order_items set qty_received = qty_received + v_qty where id = poi.id;
  insert into public.worker_receipts (po_id, po_item_id, mr_item_id, qty, unit, received_by, received_by_name, note, photo_path, job_order_id)
  values (po.id, poi.id, mi.id, v_qty, poi.unit, auth.uid(), coalesce((select name from public.profiles where id = auth.uid()), ''),
          coalesce(trim(p->>'note'), ''), v_path, (select job_order_id from public.material_requisitions where id = mi.mr_id))
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'left', poi.qty - poi.qty_received - v_qty);
end;
$$;
revoke execute on function public.po_worker_receive(jsonb) from public, anon;
grant execute on function public.po_worker_receive(jsonb) to authenticated;

-- ---------- Purchased Items: add worker receipts and worker purchases ----------
create or replace function public.purchased_items_report(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_money boolean;
  v_rows  jsonb;
begin
  if not (public.is_admin() or public.has_perm('pur.purchased_items', 'view')) then
    raise exception 'You don''t have access to Purchased Items.' using errcode = '42501';
  end if;
  if p_from is null or p_to is null then
    raise exception 'Choose the dates to cover.' using errcode = 'P0001';
  end if;
  if p_to < p_from then
    raise exception 'The end date is before the start date.' using errcode = 'P0001';
  end if;
  v_money := public.is_admin() or public.has_perm('pur.purchase_orders', 'view') or public.has_perm('fin.costs', 'view');

  select coalesce(jsonb_agg(r order by r->>'received_on', coalesce(r->>'receipt_no', r->>'doc_no'), r->>'po_no', (r->>'line_no')::int), '[]'::jsonb)
    into v_rows
    from (
      -- 1. warehouse receipts against POs
      select jsonb_build_object(
               'source', 'receipt',
               'received_on', (rc.created_at at time zone 'Asia/Manila')::date,
               'receipt_no', rc.receipt_no, 'received_by', rc.received_by_name,
               'where', case when rc.direct_project_id is not null or rc.direct_job_order_id is not null then 'Delivered to site' else coalesce(w.code, '') end,
               'po_id', p.id, 'po_no', p.po_no, 'po_date', p.po_date, 'reference', p.reference,
               'supplier', coalesce(nullif(s.trade_name, ''), nullif(s.name, ''), nullif(p.supplier_snapshot->>'trade_name', ''), nullif(p.supplier_snapshot->>'name', ''), '— no supplier —'),
               'line_no', i.line_no, 'material_id', i.material_id, 'code', i.code, 'description', i.description,
               'unit', coalesce(nullif(ri.po_unit, ''), i.unit), 'qty', coalesce(ri.qty_po_units, ri.qty),
               'unit_price', case when v_money then i.unit_price end,
               'amount', case when v_money then round(coalesce(ri.qty_po_units, ri.qty) * i.unit_price, 2) end
             ) as r
        from public.stock_receipts rc
        join public.stock_receipt_items ri on ri.receipt_id = rc.id and ri.po_item_id is not null
        join public.purchase_order_items i on i.id = ri.po_item_id
        join public.purchase_orders p on p.id = i.po_id
        left join public.suppliers s on s.id = p.supplier_id
        left join public.warehouses w on w.id = rc.warehouse_id
       where (rc.created_at at time zone 'Asia/Manila')::date between p_from and p_to
      union all
      -- 2. a worker recorded "I received this" against a PO line (no warehouse stock)
      select jsonb_build_object(
               'source', 'worker_receipt',
               'received_on', (wr.created_at at time zone 'Asia/Manila')::date,
               'doc_no', 'WR-' || to_char(wr.created_at at time zone 'Asia/Manila', 'YYMMDD') || '-' || upper(substr(wr.id::text, 1, 4)),
               'received_by', wr.received_by_name, 'where', 'Received by ' || wr.received_by_name,
               'po_id', p.id, 'po_no', p.po_no, 'po_date', p.po_date, 'reference', p.reference,
               'supplier', coalesce(nullif(s.trade_name, ''), nullif(s.name, ''), nullif(p.supplier_snapshot->>'trade_name', ''), nullif(p.supplier_snapshot->>'name', ''), '— no supplier —'),
               'line_no', i.line_no, 'material_id', i.material_id, 'code', i.code, 'description', i.description,
               'unit', coalesce(nullif(wr.unit, ''), i.unit), 'qty', wr.qty,
               'unit_price', case when v_money then i.unit_price end,
               'amount', case when v_money then round(wr.qty * i.unit_price, 2) end
             )
        from public.worker_receipts wr
        join public.purchase_order_items i on i.id = wr.po_item_id
        join public.purchase_orders p on p.id = i.po_id
        left join public.suppliers s on s.id = p.supplier_id
       where (wr.created_at at time zone 'Asia/Manila')::date between p_from and p_to
      union all
      -- 3. a worker bought it themselves ("tech buys"), by purchase date
      select jsonb_build_object(
               'source', 'tech_buy',
               'received_on', wp.purchased_on,
               'doc_no', 'TB-' || to_char(wp.purchased_on, 'YYMMDD') || '-' || upper(substr(wp.id::text, 1, 4)),
               'received_by', wp.buyer_name, 'where', 'Bought by ' || wp.buyer_name,
               'po_id', null, 'po_no', null, 'po_date', null, 'reference', m.mrf_no,
               'supplier', coalesce(nullif(wp.store, ''), '— bought by a worker —'),
               'line_no', 0, 'material_id', wp.material_id, 'code', wp.code, 'description', wp.description,
               'unit', wp.unit, 'qty', wp.qty,
               'unit_price', case when v_money then wp.unit_price end,
               'amount', case when v_money then wp.amount end
             )
        from public.worker_purchases wp
        join public.material_requisitions m on m.id = wp.mr_id
       where wp.purchased_on between p_from and p_to
    ) x;

  return jsonb_build_object('money', v_money, 'from', p_from, 'to', p_to, 'rows', v_rows);
end;
$$;
revoke execute on function public.purchased_items_report(date, date) from public, anon;
grant execute on function public.purchased_items_report(date, date) to authenticated;

-- =====================================================================
-- AWES App — site deliveries: a supplier delivers STRAIGHT TO A SITE, and a
-- worker the office assigned receives it there and uploads photos as proof.
--
--   1. Office (Super Admin, or staff with Edit on Receive Stock) ASSIGNS a delivery:
--      supplier (and optionally the issued PO), the site (project / job order / address),
--      the expected date, the expected items, and the worker who will receive it.
--   2. The assigned worker, on their phone, confirms how much of each item arrived and
--      uploads at least one photo. Only that worker can do this; the photos are kept.
--   3. Nothing goes into a warehouse. For lines on a PO, what arrived is added to the PO
--      line's "received" (the PO can complete) and recorded as a worker receipt, so it shows
--      in Purchased Items by the day it was received, "Received by <worker>".
--
-- Photos live in a private bucket (delivery-proofs); a worker writes only into their own folder,
-- nobody can change or delete them, and the office reads them through signed links.
-- Safe to re-run. Depends on 20260923_07/_08 (projects, inv_next_no, PO guard) and 20261024_01 (worker_receipts).
-- =====================================================================
create table if not exists public.site_deliveries (
  id               uuid primary key default gen_random_uuid(),
  delivery_no      text not null unique,
  supplier_id      uuid references public.suppliers(id) on delete set null,
  supplier_name    text not null default '',
  po_id            uuid references public.purchase_orders(id) on delete set null,
  supplier_ref     text not null default '',
  project_id       uuid references public.projects(id) on delete set null,
  job_order_id     text,
  site_label       text not null default '',
  expected_on      date,
  note             text not null default '',
  assigned_to      uuid not null references public.profiles(id),
  assigned_to_name text not null default '',
  assigned_by      uuid references public.profiles(id),
  assigned_by_name text not null default '',
  assigned_at      timestamptz not null default now(),
  status           text not null default 'assigned' check (status in ('assigned', 'received', 'cancelled')),
  received_at      timestamptz,
  receive_note     text not null default '',
  cancelled_at     timestamptz,
  cancel_reason    text not null default ''
);
create index if not exists site_deliveries_worker_idx on public.site_deliveries (assigned_to, status);
create index if not exists site_deliveries_status_idx on public.site_deliveries (status, assigned_at desc);

create table if not exists public.site_delivery_items (
  id            uuid primary key default gen_random_uuid(),
  delivery_id   uuid not null references public.site_deliveries(id) on delete cascade,
  line_no       int not null,
  po_item_id    uuid references public.purchase_order_items(id) on delete set null,
  material_id   uuid references public.materials(id) on delete set null,
  code          text not null default '',
  description   text not null,
  unit          text not null default '',
  qty_expected  numeric(14,3) not null check (qty_expected > 0),
  qty_received  numeric(14,3) check (qty_received is null or qty_received >= 0),
  item_note     text not null default ''
);
create index if not exists site_delivery_items_delivery_idx on public.site_delivery_items (delivery_id);

create table if not exists public.site_delivery_photos (
  id           uuid primary key default gen_random_uuid(),
  delivery_id  uuid not null references public.site_deliveries(id) on delete cascade,
  path         text not null,
  uploaded_by  uuid references public.profiles(id),
  uploaded_at  timestamptz not null default now()
);
create index if not exists site_delivery_photos_delivery_idx on public.site_delivery_photos (delivery_id);

-- ---------- who can read (writes happen only through the functions below) ----------
alter table public.site_deliveries enable row level security;
alter table public.site_delivery_items enable row level security;
alter table public.site_delivery_photos enable row level security;
drop policy if exists site_deliveries_read on public.site_deliveries;
create policy site_deliveries_read on public.site_deliveries for select to authenticated
  using (assigned_to = auth.uid() or public.is_admin() or public.has_perm('inv.receive', 'view') or public.has_perm('pur.purchase_orders', 'view'));
drop policy if exists site_delivery_items_read on public.site_delivery_items;
create policy site_delivery_items_read on public.site_delivery_items for select to authenticated
  using (exists (select 1 from public.site_deliveries d where d.id = delivery_id));
drop policy if exists site_delivery_photos_read on public.site_delivery_photos;
create policy site_delivery_photos_read on public.site_delivery_photos for select to authenticated
  using (exists (select 1 from public.site_deliveries d where d.id = delivery_id));

-- ---------- the private photo bucket ----------
insert into storage.buckets (id, name, public) values ('delivery-proofs', 'delivery-proofs', false) on conflict (id) do nothing;
drop policy if exists dp_select on storage.objects;
create policy dp_select on storage.objects for select to authenticated
  using (bucket_id = 'delivery-proofs' and ((storage.foldername(name))[1] = auth.uid()::text
         or public.is_admin() or public.has_perm('inv.receive', 'view') or public.has_perm('pur.purchase_orders', 'view')));
drop policy if exists dp_insert on storage.objects;
create policy dp_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'delivery-proofs' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------- 1. the office assigns a delivery ----------
create or replace function public.site_delivery_create(p jsonb)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_me text; v_worker public.profiles%rowtype; v_sup public.suppliers%rowtype; v_prj public.projects%rowtype; v_jo jsonb; v_po public.purchase_orders%rowtype;
  v_label text; v_no text; v_id uuid; it jsonb; n int := 0;
  v_mat public.materials%rowtype; v_poi public.purchase_order_items%rowtype; v_pending numeric; v_qty numeric; v_desc text;
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if not (public.is_admin() or public.has_perm('inv.receive', 'edit')) then
    raise exception 'You need Edit access for Receive Stock to assign a delivery.' using errcode = '42501';
  end if;
  select * into v_worker from public.profiles where id = nullif(p->>'assigned_to', '')::uuid and coalesce(active, true) and role in ('technician', 'staff');
  if v_worker.id is null then raise exception 'Choose an active worker to receive it.' using errcode = 'P0001'; end if;
  if jsonb_typeof(p->'items') <> 'array' or jsonb_array_length(p->'items') = 0 then
    raise exception 'Add at least one expected item.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p->'items') > 60 then raise exception 'Too many items on one delivery.' using errcode = 'P0001'; end if;

  if nullif(p->>'supplier_id', '') is not null then
    select * into v_sup from public.suppliers where id = (p->>'supplier_id')::uuid;
  end if;
  if nullif(p->>'po_id', '') is not null then
    select * into v_po from public.purchase_orders where id = (p->>'po_id')::uuid;
    if v_po.id is null or v_po.status <> 'issued' then raise exception 'That purchase order isn''t issued.' using errcode = 'P0001'; end if;
    if v_sup.id is null and v_po.supplier_id is not null then select * into v_sup from public.suppliers where id = v_po.supplier_id; end if;   -- the PO knows its supplier
  end if;
  if nullif(p->>'project_id', '') is not null then select * into v_prj from public.projects where id = (p->>'project_id')::uuid; end if;
  if nullif(p->>'job_order_id', '') is not null then
    select data into v_jo from public.dispatch_tickets where id = p->>'job_order_id';
    if v_jo is null then raise exception 'That job order was not found.' using errcode = 'P0001'; end if;
  end if;
  v_label := nullif(btrim(concat_ws(' · ',
               case when v_prj.id is not null then v_prj.project_no || ' — ' || v_prj.name end,
               case when v_jo is not null then (p->>'job_order_id') || coalesce(' · ' || nullif(v_jo->>'custName', ''), '') end,
               nullif(btrim(coalesce(p->>'site_label', '')), ''))), '');
  if v_label is null then raise exception 'Say where the delivery goes: a project, a job order or the site address.' using errcode = 'P0001'; end if;

  select coalesce(name, '') into v_me from public.profiles where id = auth.uid();
  v_no := public.inv_next_no('SDL');
  insert into public.site_deliveries (delivery_no, supplier_id, supplier_name, po_id, supplier_ref, project_id, job_order_id, site_label, expected_on, note,
                                      assigned_to, assigned_to_name, assigned_by, assigned_by_name)
  values (v_no, v_sup.id, coalesce(nullif(coalesce(v_sup.trade_name, ''), ''), nullif(coalesce(v_sup.name, ''), ''), nullif(btrim(coalesce(p->>'supplier_name', '')), ''), ''),
          v_po.id, btrim(coalesce(p->>'supplier_ref', '')), v_prj.id, nullif(p->>'job_order_id', ''), v_label, nullif(p->>'expected_on', '')::date, btrim(coalesce(p->>'note', '')),
          v_worker.id, coalesce(v_worker.name, ''), auth.uid(), coalesce(v_me, ''))
  returning id into v_id;

  for it in select * from jsonb_array_elements(p->'items') loop
    n := n + 1;
    v_qty := (it->>'qty_expected')::numeric;
    if v_qty is null or v_qty <= 0 then raise exception 'Line %: enter a quantity above 0.', n using errcode = 'P0001'; end if;
    v_mat := null::public.materials; v_poi := null::public.purchase_order_items; v_desc := btrim(coalesce(it->>'description', ''));
    if nullif(it->>'material_id', '') is not null then select * into v_mat from public.materials where id = (it->>'material_id')::uuid; end if;
    if nullif(it->>'po_item_id', '') is not null then
      select * into v_poi from public.purchase_order_items where id = (it->>'po_item_id')::uuid and po_id is not distinct from v_po.id for update;
      if v_poi.id is null then raise exception 'Line %: that purchase order line isn''t on the PO you chose.', n using errcode = 'P0001'; end if;
      select coalesce(sum(i.qty_expected), 0) into v_pending from public.site_delivery_items i join public.site_deliveries d on d.id = i.delivery_id
        where i.po_item_id = v_poi.id and d.status = 'assigned' and d.id <> v_id;
      if v_qty > v_poi.qty - v_poi.qty_received - v_pending then
        raise exception '%: only % left to deliver on %.', v_poi.description, trim_scale(greatest(v_poi.qty - v_poi.qty_received - v_pending, 0)), v_po.po_no using errcode = 'P0001';
      end if;
    end if;
    if v_desc = '' then v_desc := coalesce(v_mat.name, v_poi.description, ''); end if;
    if v_desc = '' then raise exception 'Line %: name the item.', n using errcode = 'P0001'; end if;
    insert into public.site_delivery_items (delivery_id, line_no, po_item_id, material_id, code, description, unit, qty_expected)
    values (v_id, n, v_poi.id, v_mat.id, coalesce(v_mat.code, v_poi.code, ''), v_desc, coalesce(nullif(v_mat.unit, ''), v_poi.unit, btrim(coalesce(it->>'unit', ''))), v_qty);
  end loop;
  return jsonb_build_object('id', v_id, 'delivery_no', v_no, 'assigned_to', v_worker.id);
end;
$$;
revoke execute on function public.site_delivery_create(jsonb) from public, anon;
grant execute on function public.site_delivery_create(jsonb) to authenticated;

-- ---------- 2. the assigned worker confirms what arrived, with photos ----------
create or replace function public.site_delivery_receive(p jsonb)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  d record; ln jsonb; it record; poi record; v_q numeric; v_any boolean := false; v_path text; v_me text; v_first text; v_lines int := 0; v_found boolean;
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  select * into d from public.site_deliveries where id = nullif(p->>'id', '')::uuid for update;
  if d is null then raise exception 'That delivery doesn''t exist.' using errcode = 'P0001'; end if;
  if d.assigned_to <> auth.uid() then raise exception 'Only % can record this delivery.', d.assigned_to_name using errcode = '42501'; end if;
  if d.status <> 'assigned' then raise exception 'This delivery is already %.', d.status using errcode = 'P0001'; end if;
  if jsonb_typeof(p->'photos') <> 'array' or jsonb_array_length(p->'photos') = 0 then
    raise exception 'Add at least one photo as proof of the delivery.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p->'photos') > 12 then raise exception 'Up to 12 photos.' using errcode = 'P0001'; end if;
  for v_path in select jsonb_array_elements_text(p->'photos') loop
    if split_part(v_path, '/', 1) <> auth.uid()::text then raise exception 'The photos have to be your own uploads.' using errcode = 'P0001'; end if;
    v_first := coalesce(v_first, v_path);
  end loop;
  select coalesce(name, '') into v_me from public.profiles where id = auth.uid();

  -- every expected line needs an answer; nothing may exceed what was expected
  for it in select * from public.site_delivery_items where delivery_id = d.id order by line_no loop
    v_found := false;
    for ln in select * from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) loop
      if (ln->>'item_id')::uuid = it.id then
        v_found := true; v_q := coalesce(nullif(ln->>'qty_received', '')::numeric, 0);
        if v_q < 0 then raise exception '%: the quantity can''t be negative.', it.description using errcode = 'P0001'; end if;
        if v_q > it.qty_expected then raise exception '%: only % % were expected.', it.description, trim_scale(it.qty_expected), it.unit using errcode = 'P0001'; end if;
        if v_q > 0 then v_any := true; end if;
        if it.po_item_id is not null and v_q > 0 then
          select * into poi from public.purchase_order_items where id = it.po_item_id for update;
          if poi is not null then
            if v_q > poi.qty - poi.qty_received then raise exception '%: only % % left to receive on the PO.', it.description, trim_scale(poi.qty - poi.qty_received), poi.unit using errcode = 'P0001'; end if;
            perform set_config('awes.inv_posting', 'on', true);
            update public.purchase_order_items set qty_received = qty_received + v_q where id = poi.id;
            insert into public.worker_receipts (po_id, po_item_id, qty, unit, received_by, received_by_name, note, photo_path, job_order_id)
            values (poi.po_id, poi.id, v_q, poi.unit, auth.uid(), coalesce(v_me, ''), 'Site delivery ' || d.delivery_no, coalesce(v_first, ''), d.job_order_id);
          end if;
        end if;
        update public.site_delivery_items set qty_received = v_q, item_note = btrim(coalesce(ln->>'note', '')) where id = it.id;
        v_lines := v_lines + 1;
      end if;
    end loop;
    if not v_found then raise exception '%: say how many arrived (0 if none).', it.description using errcode = 'P0001'; end if;
  end loop;
  if not v_any then raise exception 'Nothing arrived? Tell the office instead of recording this delivery.' using errcode = 'P0001'; end if;

  insert into public.site_delivery_photos (delivery_id, path, uploaded_by)
  select d.id, x, auth.uid() from jsonb_array_elements_text(p->'photos') x;
  update public.site_deliveries set status = 'received', received_at = now(), receive_note = btrim(coalesce(p->>'note', '')) where id = d.id;
  return jsonb_build_object('delivery_no', d.delivery_no, 'lines', v_lines, 'assigned_by', d.assigned_by);
end;
$$;
revoke execute on function public.site_delivery_receive(jsonb) from public, anon;
grant execute on function public.site_delivery_receive(jsonb) to authenticated;

-- ---------- 3. the office cancels one that has not been received ----------
create or replace function public.site_delivery_cancel(p_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare d record;
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if not (public.is_admin() or public.has_perm('inv.receive', 'edit')) then
    raise exception 'You need Edit access for Receive Stock to cancel a delivery.' using errcode = '42501';
  end if;
  select * into d from public.site_deliveries where id = p_id for update;
  if d is null then raise exception 'That delivery doesn''t exist.' using errcode = 'P0001'; end if;
  if d.status <> 'assigned' then raise exception 'Only a delivery that has not been received can be cancelled.' using errcode = 'P0001'; end if;
  if btrim(coalesce(p_reason, '')) = '' then raise exception 'Say why it is cancelled.' using errcode = 'P0001'; end if;
  update public.site_deliveries set status = 'cancelled', cancelled_at = now(), cancel_reason = btrim(p_reason) where id = p_id;
end;
$$;
revoke execute on function public.site_delivery_cancel(uuid, text) from public, anon;
grant execute on function public.site_delivery_cancel(uuid, text) to authenticated;

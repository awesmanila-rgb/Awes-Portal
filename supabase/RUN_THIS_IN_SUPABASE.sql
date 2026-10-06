-- =====================================================================================================
-- AWES App — RUN THIS ONE FILE in the Supabase SQL editor (Dashboard > SQL Editor > New query > paste > Run).
--
-- It contains every migration from 20261020_01 to 20261030_01 in the right order, so nothing is missing from
-- your deployment: purchased items, warehouse rules, worker purchasing/receiving, the materials trail and
-- monitor, site deliveries, item-by-item confirmation, the faster dashboard views, and the dashboard groups /
-- leave alert.
--
-- Every part is safe to run again, so you can run the whole file even if you already ran some of them.
-- If the editor stops on an error, send me the first red line: the part above it has already been applied.
-- It needs the earlier migrations (up to 20261019) that you already have.
--
-- Contains: 20261020_01_purchased_items.sql, 20261021_01_requests_for_all_workers.sql, 20261022_01_purchased_items_received_date.sql, 20261023_01_warehouse_rules.sql, 20261024_01_worker_purchase_receive.sql, 20261025_01_materials_trail_and_issue.sql, 20261026_01_materials_monitor.sql, 20261027_01_site_deliveries.sql, 20261028_01_issue_item_confirmation.sql, 20261029_01_lite_list_views.sql, 20261030_01_dashboard_groups_and_leave_alert.sql
-- =====================================================================================================


-- #####################################################################################################
-- ##  20261020_01_purchased_items.sql
-- #####################################################################################################

-- =====================================================================
-- AWES App — Purchased Items (Purchasing page + PDF)
--
-- One page that lists every item bought, over a month or any date range:
--   date, PO no., supplier, item, quantity, unit, unit price, amount,
--   how much of it has arrived. The page totals it per item or line by line
--   and can print the same view as a PDF.
--
-- Source today: the lines of ISSUED purchase orders, by PO date (drafts and
-- cancelled POs are not purchases and are left out). The result carries a
-- `source` column so items bought directly by a worker ("tech buys") can be
-- added to the same page once those purchases are recorded.
--
-- Access: Super Admin, or staff with the new page "Purchased Items"
-- (pur.purchased_items) — given by the department Head like any other page.
-- Peso values come back only for the Super Admin and for staff who can already
-- see prices (Purchase Orders, or "See peso values"); everyone else gets
-- quantities only (the money columns are NULL).
--
-- No new tables. Safe to re-run.
-- =====================================================================
insert into public.app_modules (key, department, section, label, sort, approvable, has_limit, is_switch) values
  ('pur.purchased_items', 'purchasing', 'Purchasing', 'Purchased Items', 14, false, false, false)
on conflict (key) do update set label = excluded.label, section = excluded.section, sort = excluded.sort, department = excluded.department;

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

  select coalesce(jsonb_agg(r order by r->>'po_date', r->>'po_no', (r->>'line_no')::int), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
               'source',       'po',
               'po_id',        p.id,
               'po_no',        p.po_no,
               'po_date',      p.po_date,
               'reference',    p.reference,
               'supplier',     coalesce(nullif(s.trade_name, ''), nullif(s.name, ''),
                                        nullif(p.supplier_snapshot->>'trade_name', ''), nullif(p.supplier_snapshot->>'name', ''), '— no supplier —'),
               'supplier_id',  p.supplier_id,
               'line_no',      i.line_no,
               'material_id',  i.material_id,
               'code',         i.code,
               'description',  i.description,
               'unit',         i.unit,
               'qty',          i.qty,
               'qty_received', i.qty_received,
               'unit_price',   case when v_money then i.unit_price end,
               'amount',       case when v_money then i.amount end
             ) as r
        from public.purchase_orders p
        join public.purchase_order_items i on i.po_id = p.id
        left join public.suppliers s on s.id = p.supplier_id
       where p.status = 'issued'
         and p.po_date between p_from and p_to
    ) x;

  return jsonb_build_object('money', v_money, 'from', p_from, 'to', p_to, 'rows', v_rows);
end;
$$;
revoke execute on function public.purchased_items_report(date, date) from public, anon;
grant execute on function public.purchased_items_report(date, date) to authenticated;

-- #####################################################################################################
-- ##  20261021_01_requests_for_all_workers.sql
-- #####################################################################################################

-- =====================================================================
-- AWES App — material requests for every worker (rules, part 1)
--
--  1. Anyone who holds Dispatch (View) — the Operations head and Operations staff —
--     may link a material request to ANY job order. Everyone else still links
--     only job orders they are assigned to; people with Material Requisition
--     (Edit) are unchanged.
--  2. Nobody reviews their own request: a non-Super-Admin can't approve, reject
--     or return a request they made, or set approved quantities on it. The
--     Super Admin is exempt (and server-side jobs, which have no signed-in user).
--  3. inv_workers(): everyone who can receive materials — active technicians and
--     office staff (messengers, the Operations head, …) — for the Issue and
--     Return screens, which only listed technicians. Names only; available to the
--     people who post inventory documents.
--
-- Safe to re-run. Depends on 20260926_02 (mr_check_job_order) and the inventory
-- migrations (inv_is_storekeeper).
-- =====================================================================

-- 1. job-order link rule (body of 20260926_02, plus the Dispatch holders)
create or replace function public.mr_check_job_order()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  d jsonb;
begin
  if new.job_order_id is null or new.job_order_id = '' then
    new.job_order_id := null; new.job_order := null;
    return new;
  end if;
  if tg_op = 'UPDATE' and new.job_order_id is not distinct from old.job_order_id and new.job_order is not null then
    return new;
  end if;
  select data into d from public.dispatch_tickets where id = new.job_order_id;
  if d is null then
    raise exception 'Job order % was not found.', new.job_order_id using errcode = 'P0001';
  end if;
  if not public.has_perm('pur.requisitions', 'edit')
     and not public.has_perm('ops.dispatch', 'view')
     and not coalesce((d -> 'assignedWorkerIds') @> to_jsonb(auth.uid()::text), false) then
    raise exception 'You can only request materials for a job order assigned to you.' using errcode = 'P0001';
  end if;
  new.job_order := jsonb_build_object(
    'id', new.job_order_id, 'custName', coalesce(d ->> 'custName', ''),
    'siteAddress', coalesce(d ->> 'siteAddress', ''), 'category', coalesce(d ->> 'category', ''));
  return new;
end;
$function$;

-- 2. nobody reviews their own request
create or replace function public.mr_self_review_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if public.is_admin() or auth.uid() is null then return new; end if;
  if old.requested_by = auth.uid() and old.status = 'submitted' and new.status in ('approved', 'rejected', 'returned') then
    raise exception 'This is your own request, so someone else has to review it.' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists mr_zz_self_review_guard on public.material_requisitions;
create trigger mr_zz_self_review_guard before update on public.material_requisitions
  for each row execute function public.mr_self_review_guard();

create or replace function public.mr_items_self_review_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if public.is_admin() or auth.uid() is null then return new; end if;
  if new.qty_approved is distinct from old.qty_approved
     and exists (select 1 from public.material_requisitions m where m.id = new.mr_id and m.requested_by = auth.uid()) then
    raise exception 'This is your own request, so someone else has to approve the quantities.' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists mr_items_zz_self_review_guard on public.material_requisition_items;
create trigger mr_items_zz_self_review_guard before update on public.material_requisition_items
  for each row execute function public.mr_items_self_review_guard();

-- 3. who can receive materials
create or replace function public.inv_workers()
returns table (id uuid, name text, role text)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select p.id, p.name, p.role
    from public.profiles p
   where coalesce(p.active, true)
     and p.role in ('technician', 'staff')
     and (public.is_admin() or public.inv_is_storekeeper()
          or public.has_perm('inv.issue', 'view') or public.has_perm('inv.returns', 'view') or public.has_perm('inv.receive', 'view'))
   order by p.name;
$$;
revoke execute on function public.inv_workers() from public, anon;
grant execute on function public.inv_workers() to authenticated;

-- #####################################################################################################
-- ##  20261022_01_purchased_items_received_date.sql
-- #####################################################################################################

-- =====================================================================
-- AWES App — Purchased Items: count by the DATE GOODS WERE RECEIVED
--
-- Replaces purchased_items_report() from 20261020_01. Each row is now one RECEIVED
-- line — what actually arrived, on the day it arrived (Philippine date) —
-- instead of one purchase-order line on the PO's date:
--   date received, receipt no., PO no., supplier, item, qty received, unit,
--   unit price, amount (qty received x PO unit price), where it was received.
-- A PO delivered in three parts shows up three times, each on its own day,
-- for what came in that day. A PO nothing has arrived for yet is not listed.
--
-- Source today: warehouse receipts against purchase orders (including goods
-- delivered straight to a site). Receipts with no PO are not purchases on
-- record and are left out. Items a worker bought or received themselves are
-- added by 20261024_01_worker_purchase_receive.sql.
--
-- Same access and same price rules as before. Safe to re-run.
-- =====================================================================
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

  select coalesce(jsonb_agg(r order by r->>'received_on', r->>'receipt_no', r->>'po_no', (r->>'line_no')::int), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
               'source',       'receipt',
               'received_on',  (rc.created_at at time zone 'Asia/Manila')::date,
               'receipt_no',   rc.receipt_no,
               'received_by',  rc.received_by_name,
               'where',        case when rc.direct_project_id is not null or rc.direct_job_order_id is not null then 'Delivered to site'
                                    else coalesce(w.code, '') end,
               'po_id',        p.id,
               'po_no',        p.po_no,
               'po_date',      p.po_date,
               'reference',    p.reference,
               'supplier',     coalesce(nullif(s.trade_name, ''), nullif(s.name, ''),
                                        nullif(p.supplier_snapshot->>'trade_name', ''), nullif(p.supplier_snapshot->>'name', ''), '— no supplier —'),
               'line_no',      i.line_no,
               'material_id',  i.material_id,
               'code',         i.code,
               'description',  i.description,
               'unit',         coalesce(nullif(ri.po_unit, ''), i.unit),
               'qty',          coalesce(ri.qty_po_units, ri.qty),
               'unit_price',   case when v_money then i.unit_price end,
               'amount',       case when v_money then round(coalesce(ri.qty_po_units, ri.qty) * i.unit_price, 2) end
             ) as r
        from public.stock_receipts rc
        join public.stock_receipt_items ri on ri.receipt_id = rc.id and ri.po_item_id is not null
        join public.purchase_order_items i on i.id = ri.po_item_id
        join public.purchase_orders p on p.id = i.po_id
        left join public.suppliers s on s.id = p.supplier_id
        left join public.warehouses w on w.id = rc.warehouse_id
       where (rc.created_at at time zone 'Asia/Manila')::date between p_from and p_to
    ) x;

  return jsonb_build_object('money', v_money, 'from', p_from, 'to', p_to, 'rows', v_rows);
end;
$$;
revoke execute on function public.purchased_items_report(date, date) from public, anon;
grant execute on function public.purchased_items_report(date, date) to authenticated;

-- #####################################################################################################
-- ##  20261023_01_warehouse_rules.sql
-- #####################################################################################################

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

-- #####################################################################################################
-- ##  20261024_01_worker_purchase_receive.sql
-- #####################################################################################################

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

-- #####################################################################################################
-- ##  20261025_01_materials_trail_and_issue.sql
-- #####################################################################################################

-- =====================================================================
-- AWES App — materials trail, and issuing PO goods against the request line
-- (materials rules, part 4)
--
--  1. inv_post_issue(): issuing against a request line no longer overwrites the line's
--     route. Before, a line that was on a PO became "stock" once fully issued, so the
--     request forgot which PO it came from. Now a line on a PO keeps "po" (and a tech-buy
--     line keeps "tech_buy"); only a line with no other route becomes "stock". Everything
--     else is the body from 20260926_03, unchanged.
--  2. mr_trail(request): the per-item trail of a request — route, PO and its status, what
--     arrived (warehouse / worker), what was bought, who was issued how much and whether they
--     signed, what was returned — plus what the caller may do next. Names and quantities only;
--     peso amounts only for people who may see prices.
--  3. mr_progress(requests[]): one number per item (0-6 steps done) for list screens.
--  4. po_notify_targets(po) / slip_notify_targets(slip): who to tell when goods arrive or are
--     returned — the requester AND the collector of each request line on that PO / slip.
--
-- Who may call: the requester, the collector, the office (Requisition View), the Super Admin,
-- and storekeepers for approved requests. Depends on 20260926_03, 20261010_01 (PO approval),
-- 20261024_01. Safe to re-run.
-- =====================================================================

create or replace function public.inv_post_issue(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  perform public.inv_require_warehouse(wh, 'inv.issue');
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
             -- a line covered by a PO (or by the worker buying it) keeps that route when it is issued from stock;
             -- only a line with no other route becomes "stock"
             fulfilled_by = case when po_id is null and coalesce(fulfilled_by, '') <> 'tech_buy'
                                  and qty_issued + v_qty >= coalesce(qty_approved, qty_requested) then 'stock' else fulfilled_by end
       where id = mi.id;
    end if;
    insert into public.issue_slip_items (slip_id, line_no, material_id, qty, mr_item_id) values (sid, i, mat, v_qty, nullif(l->>'mr_item_id', '')::uuid);
    -- the ledger trigger refuses this if there isn't enough stock
    insert into public.stock_movements (doc_type, doc_ref, doc_id, warehouse_id, material_id, qty, project_id, job_order_id, worker_id)
    values ('issue', sno, sid, wh, mat, -v_qty, proj, job, wk);
  end loop;
  return jsonb_build_object('id', sid, 'slip_no', sno);
end; $function$;


-- ---------- who may see a request's trail ----------
create or replace function public.mr_can_see(p_mr uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.material_requisitions m
     where m.id = p_mr
       and (public.is_admin() or public.has_perm('pur.requisitions', 'view') or m.requested_by = auth.uid()
            or exists (select 1 from public.material_requisition_collectors c where c.mr_id = m.id and c.collector_id = auth.uid())
            or (public.inv_is_storekeeper() and m.status in ('approved', 'fulfilled')))
  );
$$;
revoke execute on function public.mr_can_see(uuid) from public, anon;
grant execute on function public.mr_can_see(uuid) to authenticated;

-- ---------- one item's facts + how far it has got (0-6 steps done) ----------
--   1 request sent   2 approved   3 how it's covered (PO issued / bought / in stock)
--   4 goods arrived  5 handed over (issued, or already with the worker)   6 something returned
create or replace function public.mr_item_facts(p_item uuid, p_money boolean)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  i record; m record; v_need numeric; v_route text;
  po jsonb := null; po_qty numeric := 0; po_recv numeric := 0; wk_recv numeric := 0; v_po_item uuid;
  v_bought numeric := 0; v_amount numeric := null; v_buyer uuid; v_buyer_name text;
  v_slips jsonb; v_issued numeric := 0; v_ret_good numeric := 0; v_ret_bad numeric := 0; rec record; g numeric; b numeric;
  v_prog int := 0; v_in_hand numeric := 0; v_me uuid := auth.uid(); v_is_req boolean; v_is_col boolean;
  v_can_receive boolean := false; v_can_buy boolean := false;
begin
  select * into i from public.material_requisition_items where id = p_item;
  select * into m from public.material_requisitions where id = i.mr_id;
  v_need := coalesce(i.qty_approved, i.qty_requested);
  v_route := case when i.qty_approved is not null and i.qty_approved = 0 then 'none' else i.fulfilled_by end;
  v_is_req := coalesce(m.requested_by = v_me, false);
  v_is_col := exists (select 1 from public.material_requisition_collectors c where c.mr_id = m.id and c.collector_id = v_me);

  if i.po_id is not null then
    select jsonb_build_object('id', p.id, 'po_no', p.po_no, 'status', p.status,
                              'waiting_approval', (p.status = 'draft' and p.approval_requested_at is not null),
                              'delivery_date', p.delivery_date),
           coalesce(sum(pi.qty), 0), coalesce(sum(pi.qty_received), 0),
           coalesce((select sum(wr.qty) from public.worker_receipts wr join public.purchase_order_items x on x.id = wr.po_item_id
                      where x.po_id = p.id and x.material_id is not distinct from i.material_id), 0),
           (array_agg(pi.id order by pi.line_no))[1]
      into po, po_qty, po_recv, wk_recv, v_po_item
      from public.purchase_orders p
      left join public.purchase_order_items pi on pi.po_id = p.id and pi.material_id is not distinct from i.material_id
     where p.id = i.po_id group by p.id;
    if po is not null and po->>'status' = 'issued' and po_recv < po_qty and (v_is_req or v_is_col) and m.status in ('approved', 'fulfilled') then
      v_can_receive := true;
    end if;
  end if;

  if v_route = 'tech_buy' then
    select coalesce(sum(qty), 0), case when p_money then coalesce(sum(amount), 0) end into v_bought, v_amount
      from public.worker_purchases where mr_item_id = i.id;
    v_buyer := public.mr_item_buyer(i.id);
    select name into v_buyer_name from public.profiles where id = v_buyer;
    if coalesce(v_buyer = v_me, false) and v_bought < v_need and m.status in ('approved', 'fulfilled') then v_can_buy := true; end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('slip_no', s.slip_no, 'worker', s.worker_name, 'qty', it.qty, 'status', s.status, 'ack_at', s.ack_at, 'on', s.created_at) order by s.created_at), '[]'::jsonb),
         coalesce(sum(it.qty), 0)
    into v_slips, v_issued
    from public.issue_slip_items it join public.issue_slips s on s.id = it.slip_id
   where it.mr_item_id = i.id;
  -- Returns. The Returns screen returns "what a worker holds" and does not record which issue
  -- slip it belongs to, so a return is matched to this item by WORKER + ITEM + JOB (after the
  -- first issue to that worker), capped at what that worker was issued for this line.
  -- A return that names its issue slip (issue_slip_id) is matched exactly.
  for rec in
    select s.worker_id, sum(it.qty) as q, min(s.created_at) as first_at, min(coalesce(s.job_order_id, '')) as job
      from public.issue_slip_items it join public.issue_slips s on s.id = it.slip_id
     where it.mr_item_id = i.id group by s.worker_id
  loop
    select coalesce(sum(case when ri.condition = 'good' then ri.qty end), 0), coalesce(sum(case when ri.condition <> 'good' then ri.qty end), 0)
      into g, b
      from public.return_slip_items ri join public.return_slips r on r.id = ri.return_id
     where r.worker_id = rec.worker_id and ri.material_id is not distinct from i.material_id and r.created_at >= rec.first_at
       and (r.issue_slip_id in (select it2.slip_id from public.issue_slip_items it2 where it2.mr_item_id = i.id)
            or (r.issue_slip_id is null and coalesce(r.job_order_id, '') = rec.job));
    v_ret_good := v_ret_good + least(rec.q, g);
    v_ret_bad  := v_ret_bad + least(greatest(rec.q - least(rec.q, g), 0), b);
  end loop;

  -- how far has it got
  if m.status in ('draft', 'returned') then v_prog := 0;
  elsif m.status in ('rejected', 'cancelled') then v_prog := 1;
  else
    v_prog := case when m.status = 'submitted' then 1 else 2 end;
    if m.status in ('approved', 'fulfilled') and v_route <> 'none' then
      if (v_route = 'po' and po is not null and po->>'status' = 'issued') or v_route = 'tech_buy' or v_route = 'stock' or v_issued > 0 then v_prog := 3; end if;
      v_in_hand := wk_recv + (case when v_route = 'tech_buy' then v_bought else 0 end);
      if (v_route = 'po' and po_recv >= po_qty and po_qty > 0) or (v_route = 'tech_buy' and v_bought >= v_need) or v_route = 'stock' or v_issued >= v_need then v_prog := 4; end if;
      if v_issued >= v_need or (v_route = 'po' and wk_recv >= v_need) or (v_route = 'tech_buy' and v_bought >= v_need) then v_prog := 5; end if;
      if v_ret_good + v_ret_bad > 0 then v_prog := 6; end if;
    end if;
  end if;

  return jsonb_build_object(
    'id', i.id, 'line_no', i.line_no, 'description', i.description, 'code', i.code, 'unit', i.unit, 'material_id', i.material_id,
    'qty_requested', i.qty_requested, 'qty_approved', i.qty_approved, 'qty_need', v_need,
    'route', v_route, 'progress', v_prog,
    'po', po, 'po_item_id', v_po_item, 'po_qty', po_qty, 'po_received', po_recv, 'po_received_by_workers', wk_recv, 'po_received_in_warehouse', po_recv - wk_recv,
    'buyer', case when v_route = 'tech_buy' then jsonb_build_object('id', v_buyer, 'name', v_buyer_name) end,
    'bought_qty', v_bought, 'bought_amount', v_amount,
    'issued_qty', v_issued, 'issued', v_slips, 'returned_good', v_ret_good, 'returned_damaged', v_ret_bad,
    'can_receive', v_can_receive, 'can_buy', v_can_buy
  );
end;
$$;
revoke execute on function public.mr_item_facts(uuid, boolean) from public, anon;

create or replace function public.mr_trail(p_mr uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare m record; v_money boolean; v_coll uuid; v_items jsonb;
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if not public.mr_can_see(p_mr) then raise exception 'You can''t see that request.' using errcode = '42501'; end if;
  select * into m from public.material_requisitions where id = p_mr;
  v_money := public.is_admin() or public.has_perm('pur.purchase_orders', 'view') or public.has_perm('fin.costs', 'view');
  select collector_id into v_coll from public.material_requisition_collectors where mr_id = p_mr;
  select coalesce(jsonb_agg(public.mr_item_facts(i.id, v_money) order by i.line_no), '[]'::jsonb) into v_items
    from public.material_requisition_items i where i.mr_id = p_mr;
  return jsonb_build_object(
    'money', v_money,
    'mr', jsonb_build_object('id', m.id, 'mrf_no', m.mrf_no, 'status', m.status, 'urgency', m.urgency, 'needed_by', m.needed_by,
            'deliver_to', m.deliver_to, 'job_order', m.job_order, 'requested_by', m.requested_by, 'requester_name', m.requester_name,
            'collector', case when v_coll is not null then jsonb_build_object('id', v_coll, 'name', (select name from public.profiles where id = v_coll)) end,
            'submitted_at', m.submitted_at, 'reviewed_at', m.reviewed_at, 'reviewer_name', m.reviewer_name, 'review_note', m.review_note),
    'items', v_items);
end;
$$;
revoke execute on function public.mr_trail(uuid) from public, anon;
grant execute on function public.mr_trail(uuid) to authenticated;

create or replace function public.mr_progress(p_ids uuid[])
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare r jsonb := '{}'::jsonb; x uuid; v_prog jsonb;
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  foreach x in array coalesce(p_ids, '{}'::uuid[]) loop
    continue when not public.mr_can_see(x);
    select coalesce(jsonb_agg((public.mr_item_facts(i.id, false)->>'progress')::int order by i.line_no), '[]'::jsonb) into v_prog
      from public.material_requisition_items i where i.mr_id = x;
    r := r || jsonb_build_object(x::text, v_prog);
  end loop;
  return r;
end;
$$;
revoke execute on function public.mr_progress(uuid[]) from public, anon;
grant execute on function public.mr_progress(uuid[]) to authenticated;

-- ---------- who to tell ----------
create or replace function public.po_notify_targets(p_po uuid)
returns table (user_id uuid, mrf_no text, kind text)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select distinct t.user_id, t.mrf_no, t.kind from (
    select m.requested_by as user_id, m.mrf_no, 'requester'::text as kind
      from public.material_requisition_items i join public.material_requisitions m on m.id = i.mr_id where i.po_id = p_po
    union all
    select c.collector_id, m.mrf_no, 'collector'
      from public.material_requisition_items i join public.material_requisitions m on m.id = i.mr_id
      join public.material_requisition_collectors c on c.mr_id = m.id where i.po_id = p_po
  ) t
  where t.user_id is not null
    and (public.is_admin() or public.inv_is_storekeeper() or public.has_perm('inv.receive', 'view') or public.has_perm('pur.requisitions', 'view'));
$$;
revoke execute on function public.po_notify_targets(uuid) from public, anon;
grant execute on function public.po_notify_targets(uuid) to authenticated;

create or replace function public.slip_notify_targets(p_slip uuid)
returns table (user_id uuid, mrf_no text, kind text)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select distinct t.user_id, t.mrf_no, t.kind from (
    select m.requested_by as user_id, m.mrf_no, 'requester'::text as kind
      from public.issue_slips s join public.material_requisitions m on m.id = s.mr_id where s.id = p_slip
    union all
    select c.collector_id, m.mrf_no, 'collector'
      from public.issue_slips s join public.material_requisitions m on m.id = s.mr_id
      join public.material_requisition_collectors c on c.mr_id = m.id where s.id = p_slip
  ) t
  where t.user_id is not null
    and (public.is_admin() or public.inv_is_storekeeper() or public.has_perm('inv.returns', 'view') or public.has_perm('inv.issue', 'view') or public.has_perm('pur.requisitions', 'view'));
$$;
revoke execute on function public.slip_notify_targets(uuid) from public, anon;
grant execute on function public.slip_notify_targets(uuid) to authenticated;

-- a RETURN: the requester and collector of every request this worker was issued these items for
create or replace function public.return_notify_targets(p_return uuid)
returns table (user_id uuid, mrf_no text, kind text)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select distinct t.user_id, t.mrf_no, t.kind from (
    select m.requested_by as user_id, m.mrf_no, 'requester'::text as kind, m.id as mr_id
      from public.return_slips r
      join public.return_slip_items ri on ri.return_id = r.id
      join public.issue_slips s on s.worker_id = r.worker_id and s.mr_id is not null and s.created_at <= r.created_at
           and (r.issue_slip_id = s.id or (r.issue_slip_id is null and coalesce(s.job_order_id, '') = coalesce(r.job_order_id, '')))
      join public.issue_slip_items it on it.slip_id = s.id and it.material_id = ri.material_id
      join public.material_requisitions m on m.id = s.mr_id
     where r.id = p_return
  ) t
  where t.user_id is not null
    and (public.is_admin() or public.inv_is_storekeeper() or public.has_perm('inv.returns', 'view') or public.has_perm('pur.requisitions', 'view'))
  union
  select c.collector_id, m.mrf_no, 'collector'
    from public.return_slips r
    join public.return_slip_items ri on ri.return_id = r.id
    join public.issue_slips s on s.worker_id = r.worker_id and s.mr_id is not null and s.created_at <= r.created_at
         and (r.issue_slip_id = s.id or (r.issue_slip_id is null and coalesce(s.job_order_id, '') = coalesce(r.job_order_id, '')))
    join public.issue_slip_items it on it.slip_id = s.id and it.material_id = ri.material_id
    join public.material_requisitions m on m.id = s.mr_id
    join public.material_requisition_collectors c on c.mr_id = m.id
   where r.id = p_return
     and (public.is_admin() or public.inv_is_storekeeper() or public.has_perm('inv.returns', 'view') or public.has_perm('pur.requisitions', 'view'));
$$;
revoke execute on function public.return_notify_targets(uuid) from public, anon;
grant execute on function public.return_notify_targets(uuid) to authenticated;

-- #####################################################################################################
-- ##  20261026_01_materials_monitor.sql
-- #####################################################################################################

-- =====================================================================
-- AWES App — Materials Monitor (very simple)
--
-- One row per request, with ONE stage and ONE answer to "who has to act next?":
--
--   approval  To approve          waiting on: the approver
--   buying    Being bought        waiting on: the office (choose how) / purchasing (PO) /
--                                 the supplier (delivery) / the buyer (a worker buying it)
--   ready     Ready to hand over  waiting on: the warehouse (it has arrived, or is in stock)
--   sign      Waiting for signature  waiting on: the person it was issued to
--   done      Done                everything is with the workers and signed
--
-- A request with several items shows the EARLIEST stage any item is still in (what is holding
-- it up), plus a count of items per stage. "days" = days since that stage began (since the
-- request was sent / approved / issued). "late" = needed-by date passed and not done.
-- Same visibility as the trail: the requester, the collector, the office (Requisition View),
-- the Super Admin, and storekeepers for approved requests. Names and counts only — no prices.
--
-- Depends on 20261024_01 and 20261025_01 (mr_can_see, mr_item_facts). Safe to re-run.
-- =====================================================================
create or replace function public.mr_monitor(p_days int default 60)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  m record; i record; f jsonb;
  v_today date := (now() at time zone 'Asia/Manila')::date;
  v_rows jsonb := '[]'::jsonb;
  rank_ int; best int; v_stage text; v_who text; v_since timestamptz; v_item_stage text; v_item_who text; v_item_since timestamptz;
  cnt jsonb; total int; v_collector text; v_last timestamptz; v_issued_on timestamptz;
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;

  for m in
    select * from public.material_requisitions r
     where r.status in ('submitted', 'approved', 'fulfilled')
       and public.mr_can_see(r.id)
       and (r.status <> 'fulfilled' or coalesce(r.reviewed_at, r.submitted_at, r.created_at) >= now() - make_interval(days => greatest(coalesce(p_days, 60), 1)))
     order by coalesce(r.submitted_at, r.created_at) desc
  loop
    cnt := jsonb_build_object('approval', 0, 'buying', 0, 'ready', 0, 'sign', 0, 'done', 0);
    total := 0; best := 99; v_stage := 'done'; v_who := ''; v_since := null;

    if m.status = 'submitted' then
      select count(*) into total from public.material_requisition_items where mr_id = m.id;
      cnt := jsonb_set(cnt, '{approval}', to_jsonb(total));
      v_stage := 'approval'; v_who := 'The approver'; v_since := coalesce(m.submitted_at, m.created_at);
    else
      for i in select * from public.material_requisition_items where mr_id = m.id order by line_no loop
        f := public.mr_item_facts(i.id, false);
        total := total + 1;
        v_issued_on := (select min((x->>'on')::timestamptz) from jsonb_array_elements(coalesce(f->'issued', '[]'::jsonb)) x where x->>'status' = 'issued');
        if f->>'route' = 'none' then
          v_item_stage := 'done'; rank_ := 4; v_item_who := ''; v_item_since := null;
        elsif jsonb_path_exists(coalesce(f->'issued', '[]'::jsonb), '$[*] ? (@.status == "issued")') then
          v_item_stage := 'sign'; rank_ := 3; v_item_who := coalesce((select x->>'worker' from jsonb_array_elements(f->'issued') x where x->>'status' = 'issued' limit 1), 'The worker');
          v_item_since := v_issued_on;
        elsif (f->>'progress')::int >= 5 then
          v_item_stage := 'done'; rank_ := 4; v_item_who := ''; v_item_since := null;
        elsif (f->>'progress')::int = 4 then
          v_item_stage := 'ready'; rank_ := 2; v_item_who := 'The warehouse'; v_item_since := coalesce(m.reviewed_at, m.submitted_at);
        else
          v_item_stage := 'buying'; rank_ := 1; v_item_since := coalesce(m.reviewed_at, m.submitted_at);
          v_item_who := case
            when f->>'route' = 'tech_buy' then coalesce(f->'buyer'->>'name', m.requester_name, 'The buyer')
            when f->>'route' = 'po' and f->'po' is not null and f->'po'->>'status' = 'issued' then 'The supplier (delivery)'
            when f->>'route' = 'po' then 'Purchasing (the PO)'
            when f->>'route' = 'stock' then 'The warehouse'
            else 'The office (choose how to get it)' end;
        end if;
        cnt := jsonb_set(cnt, array[v_item_stage], to_jsonb((cnt->>v_item_stage)::int + 1));
        if rank_ < best then best := rank_; v_stage := v_item_stage; v_who := v_item_who; v_since := v_item_since; end if;
      end loop;
      if total = 0 then v_stage := 'done'; end if;
    end if;

    select name into v_collector from public.profiles where id = (select collector_id from public.material_requisition_collectors where mr_id = m.id);
    v_rows := v_rows || jsonb_build_object(
      'id', m.id, 'mrf_no', m.mrf_no, 'requester_name', m.requester_name, 'requested_by', m.requested_by,
      'collector', v_collector, 'job_order', m.job_order, 'urgency', m.urgency, 'needed_by', m.needed_by, 'status', m.status,
      'stage', v_stage, 'waiting_on', case when v_stage = 'done' then '' else v_who end,
      'since', v_since, 'days', case when v_stage = 'done' or v_since is null then null else greatest(0, v_today - (v_since at time zone 'Asia/Manila')::date) end,
      'late', (v_stage <> 'done' and m.needed_by is not null and m.needed_by < v_today),
      'counts', cnt, 'total', total);
  end loop;

  return jsonb_build_object('today', v_today, 'rows', v_rows);
end;
$$;
revoke execute on function public.mr_monitor(int) from public, anon;
grant execute on function public.mr_monitor(int) to authenticated;

-- #####################################################################################################
-- ##  20261027_01_site_deliveries.sql
-- #####################################################################################################

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

-- #####################################################################################################
-- ##  20261028_01_issue_item_confirmation.sql
-- #####################################################################################################

-- =====================================================================
-- AWES App — the worker confirms an issue ITEM BY ITEM
--
-- Until now a worker could only sign a whole issue slip. Now they tick what they received,
-- say how many (short?) and mark anything damaged. If anything differs, a remark is required and
-- the slip is saved as "received with differences" so the issuer can follow up; the issuer is told.
-- The signature is still required (same pad, same private bucket) — the item check comes first.
--
-- Stock is NOT changed by a difference: the warehouse already booked the full quantity out and
-- the worker's holding still shows it. The slip is flagged; the storekeeper resolves it (a return,
-- or a recount) like any other discrepancy. inv_ack_issue() (sign the whole slip) is kept for older screens.
-- Safe to re-run. Depends on 20260923_08_inventory_movements.sql.
-- =====================================================================
alter table public.issue_slip_items add column if not exists qty_received numeric(14,3) check (qty_received is null or qty_received >= 0);
alter table public.issue_slip_items add column if not exists damaged boolean not null default false;
alter table public.issue_slip_items add column if not exists item_note text not null default '';
alter table public.issue_slips add column if not exists ack_diff boolean not null default false;
alter table public.issue_slips add column if not exists ack_note text not null default '';

create or replace function public.inv_ack_issue_items(p jsonb)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  s public.issue_slips%rowtype; it record; ln jsonb; v_found boolean; v_q numeric; v_dm boolean;
  v_diff boolean := false; v_any boolean := false; v_short numeric := 0; v_dmg int := 0; v_sig text; v_remark text;
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  select * into s from public.issue_slips where id = nullif(p->>'slip_id', '')::uuid for update;
  if s.id is null or s.worker_id <> auth.uid() then raise exception 'That slip isn''t yours.' using errcode = '42501'; end if;
  if s.status = 'acknowledged' then raise exception 'You already confirmed this slip.' using errcode = 'P0001'; end if;
  v_sig := coalesce(p->>'signature_path', '');
  if v_sig = '' or split_part(v_sig, '/', 1) <> auth.uid()::text then raise exception 'Sign to confirm.' using errcode = 'P0001'; end if;
  v_remark := btrim(coalesce(p->>'remark', ''));

  for it in select * from public.issue_slip_items where slip_id = s.id order by line_no loop
    v_found := false;
    for ln in select * from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) loop
      if nullif(ln->>'item_id', '')::uuid = it.id then
        v_found := true;
        v_q := coalesce(nullif(ln->>'qty_received', '')::numeric, 0);
        v_dm := coalesce((ln->>'damaged')::boolean, false);
        if v_q < 0 then raise exception 'The quantity can''t be negative.' using errcode = 'P0001'; end if;
        if v_q > it.qty then raise exception 'You can''t confirm more than was issued (% issued).', trim_scale(it.qty) using errcode = 'P0001'; end if;
        if v_dm and v_q = 0 then raise exception 'A damaged item has to be one you received.' using errcode = 'P0001'; end if;
        if v_q > 0 then v_any := true; end if;
        if v_q < it.qty or v_dm then v_diff := true; end if;
        v_short := v_short + (it.qty - v_q); if v_dm then v_dmg := v_dmg + 1; end if;
        update public.issue_slip_items set qty_received = v_q, damaged = v_dm, item_note = btrim(coalesce(ln->>'note', '')) where id = it.id;
      end if;
    end loop;
    if not v_found then raise exception 'Every item needs an answer (0 if you did not receive it).' using errcode = 'P0001'; end if;
  end loop;
  if not v_any then raise exception 'Received nothing? Tell the storekeeper instead of signing.' using errcode = 'P0001'; end if;
  if v_diff and v_remark = '' then raise exception 'Explain the difference in the remarks.' using errcode = 'P0001'; end if;

  update public.issue_slips set status = 'acknowledged', ack_at = now(), ack_signature_path = v_sig, ack_diff = v_diff, ack_note = v_remark where id = s.id;
  return jsonb_build_object('slip_no', s.slip_no, 'diff', v_diff, 'short_units', v_short, 'damaged_lines', v_dmg, 'issued_by', s.issued_by, 'worker_name', s.worker_name);
end;
$$;
revoke execute on function public.inv_ack_issue_items(jsonb) from public, anon;
grant execute on function public.inv_ack_issue_items(jsonb) to authenticated;

-- #####################################################################################################
-- ##  20261029_01_lite_list_views.sql
-- #####################################################################################################

-- =====================================================================
-- AWES App — faster dashboards: "lite" read-only views
--
-- Why: every service report stores its two signatures inline as base64 pictures, and every cash
-- advance / reimbursement stores its receipt photos inline in `data`. The dashboards and home
-- screens read EVERY row to count and list things, so they downloaded all those pictures (many
-- megabytes, growing every week) and then threw them away on the phone.
--
-- What: two views that return the SAME rows without those pictures. Nothing is moved or deleted;
-- the pictures stay in the real tables and are still fetched one record at a time when someone opens
-- a report or an attachment. security_invoker = true: the views apply the real tables' row-level
-- security for whoever is signed in, so nobody sees a row they could not see before.
--
--   service_reports_lite         every column of service_reports EXCEPT customer_signature, technician_signature
--   cash_advance_requests_lite   every column of cash_advance_requests, with the receipt pictures
--                                (items[].attachmentData, liquidation.items[].attachmentData) replaced by
--                                attachmentData = null, attachmentTruncated = true — exactly what the app
--                                already did after downloading.
-- Re-run this migration after a column is added to either table so the view picks it up. Safe to re-run.
-- Requires PostgreSQL 15+ (Supabase has it).
-- =====================================================================
create or replace function public._strip_attachment_items(items jsonb)
returns jsonb language sql immutable
as $$
  select case when jsonb_typeof(items) = 'array'
    then coalesce((select jsonb_agg(case when coalesce(i->>'attachmentData', '') <> ''
                                         then (i - 'attachmentData') || jsonb_build_object('attachmentData', null, 'attachmentTruncated', true)
                                         else i end)
                     from jsonb_array_elements(items) i), '[]'::jsonb)
    else items end;
$$;

create or replace function public._strip_ca_attachments(d jsonb)
returns jsonb language sql immutable
as $$
  select case
    when d is null then d
    else (case when jsonb_typeof(d->'items') = 'array'
               then jsonb_set(
                      case when jsonb_typeof(d#>'{liquidation,items}') = 'array'
                           then jsonb_set(d, '{liquidation,items}', public._strip_attachment_items(d#>'{liquidation,items}'))
                           else d end,
                      '{items}', public._strip_attachment_items(d->'items'))
               else (case when jsonb_typeof(d#>'{liquidation,items}') = 'array'
                          then jsonb_set(d, '{liquidation,items}', public._strip_attachment_items(d#>'{liquidation,items}'))
                          else d end)
          end)
  end;
$$;

do $$
declare cols text;
begin
  -- service reports: every column except the two signatures
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'service_reports' and column_name not in ('customer_signature', 'technician_signature');
  if cols is not null then
    execute 'drop view if exists public.service_reports_lite';
    execute 'create view public.service_reports_lite with (security_invoker = true) as select ' || cols || ' from public.service_reports';
    execute 'grant select on public.service_reports_lite to authenticated';
  end if;

  -- cash advances / reimbursements: `data` without the receipt pictures
  select string_agg(case when column_name = 'data' then 'public._strip_ca_attachments(data) as data' else quote_ident(column_name) end, ', ' order by ordinal_position) into cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'cash_advance_requests';
  if cols is not null then
    execute 'drop view if exists public.cash_advance_requests_lite';
    execute 'create view public.cash_advance_requests_lite with (security_invoker = true) as select ' || cols || ' from public.cash_advance_requests';
    execute 'grant select on public.cash_advance_requests_lite to authenticated';
  end if;
end $$;

-- #####################################################################################################
-- ##  20261030_01_dashboard_groups_and_leave_alert.sql
-- #####################################################################################################

-- =====================================================================
-- AWES App — dashboard tile groups, and the HR Head's heads-up on leave
--
--  1. Dashboard tiles (dept_dashboard): "Equipment overdue for PM", "PM due in the next 30 days" and "Customers" now belong to
--     OPERATIONS; "Tools overdue for return" and "Tools overdue for calibration" now belong to ADMINISTRATION. Same figures,
--     same permissions, same page each one opens — only the group changed.
--  2. Leave waiting for a Head's endorsement now appears in the Inbox of the HR approvers (anyone with Approve on Leave
--     Requests) as "Leave waiting for endorsement", right away. Before, they saw nothing until it was endorsed. They still
--     cannot decide it until then. The endorsing Head keeps their own "to endorse" item and does not get a duplicate.
-- Safe to re-run. Depends on 20260927_01 (dept_dashboard) and 20261001_01 (inbox functions, endorsements).
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
    out := out || jsonb_build_array(jsonb_build_object('dept','administration','module','inv.receive','label','POs waiting to be received','value',n,'tone',case when n>0 then 'warn' end));
  end if;
  if public.has_perm('inv.reports') then
    select count(*) into n from public.inv_rpt_reorder(90) where reorder;
    out := out || jsonb_build_array(jsonb_build_object('dept','administration','module','inv.reports','label','Materials to reorder','value',n,'tone',case when n>0 then 'warn' end));
  end if;
  if public.has_perm('inv.stock') and money then
    select coalesce(sum(qty_on_hand * coalesce(avg_cost, 0)), 0) into s from public.stock_balances;
    out := out || jsonb_build_array(jsonb_build_object('dept','administration','module','inv.stock','label','Stock value (all warehouses)','money',s));
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
    out := out || jsonb_build_array(jsonb_build_object('dept','operations','module', case when public.has_perm('adm.equipment') then 'adm.equipment' else 'adm.customers' end,
             'label','Equipment overdue for PM','value',n,'tone',case when n>0 then 'warn' end));
    select count(*) into n from public.customer_equipment where next_pm_date between today and today + 30;
    out := out || jsonb_build_array(jsonb_build_object('dept','operations','module', case when public.has_perm('adm.equipment') then 'adm.equipment' else 'adm.customers' end,
             'label','PM due in the next 30 days','value',n));
  end if;
  if public.has_perm('adm.customers') then
    select count(*) into n from public.customers;
    out := out || jsonb_build_array(jsonb_build_object('dept','operations','module','adm.customers','label','Customers','value',n));
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
    out := out || jsonb_build_array(jsonb_build_object('dept','administration','module', case when public.has_perm('tools.return') then 'tools.return' else 'tools.register' end,
             'label','Tools overdue for return','value',n,'tone',case when n>0 then 'warn' end));
    select count(*) into n from public.tools where status not in ('retired','lost') and next_maint_due is not null and next_maint_due < today;
    out := out || jsonb_build_array(jsonb_build_object('dept','administration','module', case when public.has_perm('tools.maintenance') then 'tools.maintenance' else 'tools.register' end,
             'label','Tools overdue for calibration','value',n,'tone',case when n>0 then 'warn' end));
  end if;
  return out;
end;
$$;;

insert into public.inbox_sla (kind, label, department, module, level, warn_hours, escalate_hours, sort) values
  ('leave_waiting', 'Leave waiting for endorsement', 'hr', 'hr.leaves', 'approve', 72, 720, 28)
on conflict (kind) do update set label = excluded.label, department = excluded.department, module = excluded.module, level = excluded.level, sort = excluded.sort;

create or replace function public.inbox_all_items()
returns table (kind text, ref_id text, ref_label text, title text, since timestamptz, owner uuid)
language sql stable security definer
set search_path = public, pg_temp
as $$
  -- Purchasing
  select 'mr_review', m.id::text, coalesce(m.mrf_no, ''), 'From ' || coalesce(nullif(m.requester_name, ''), 'a technician'),
         coalesce(m.submitted_at, m.updated_at), m.requested_by
    from public.material_requisitions m where m.status = 'submitted'
  union all
  select 'mr_fulfil', m.id::text, coalesce(m.mrf_no, ''), 'Approved — ' || coalesce(nullif(m.requester_name, ''), 'a technician') || ' is waiting',
         coalesce(m.reviewed_at, m.updated_at), null::uuid
    from public.material_requisitions m where m.status = 'approved' and m.fulfilled_at is null
  union all
  select 'po_draft', p.id::text, coalesce(p.po_no, ''), coalesce(p.supplier_snapshot->>'name', 'Draft purchase order'), p.created_at, p.created_by
    from public.purchase_orders p where p.status = 'draft'
  union all
  select 'po_receive', p.id::text, coalesce(p.po_no, ''), coalesce(p.supplier_snapshot->>'name', 'Purchase order') || ' — items still to receive',
         coalesce(p.issued_at, p.updated_at), null::uuid
    from public.purchase_orders p
   where p.status = 'issued'
     and exists (select 1 from public.purchase_order_items i where i.po_id = p.id and i.qty_received < i.qty)
  -- Accounting & Finance
  union all
  select 'ca_approve', c.id::text, '₱' || to_char(coalesce(nullif(c.data->>'amount','')::numeric, 0), 'FM999,999,990.00'),
         coalesce(nullif(c.data->>'technicianName',''), nullif(c.data->>'userName',''), 'Cash advance'), c.submitted_at, c.technician_id
    from public.cash_advance_requests c where c.status = 'pending' and public.cash_module(c.data) = 'fin.cash_advance' and not exists (select 1 from public.request_endorsements e where e.request_kind = 'cash' and e.request_id = c.id and e.status <> 'endorsed')
  union all
  select 'ca_release', c.id::text, '₱' || to_char(coalesce(nullif(c.data->>'amount','')::numeric, 0), 'FM999,999,990.00'),
         coalesce(nullif(c.data->>'technicianName',''), nullif(c.data->>'userName',''), 'Cash advance') || ' — cash not yet given',
         coalesce(nullif(c.data->>'decidedAt','')::timestamptz, c.submitted_at), null::uuid
    from public.cash_advance_requests c
   where c.status = 'approved' and public.cash_module(c.data) = 'fin.cash_advance' and not coalesce((c.data->>'disbursed')::boolean, false)
  union all
  select 'liq_submit', c.id::text, '₱' || to_char(coalesce(nullif(c.data->>'amountGiven','')::numeric, 0), 'FM999,999,990.00'),
         coalesce(nullif(c.data->>'technicianName',''), nullif(c.data->>'userName',''), 'Cash advance') || ' — not yet liquidated',
         coalesce(nullif(c.data->>'dateGiven','')::date::timestamptz, nullif(c.data->>'disbursedAt','')::timestamptz), null::uuid
    from public.cash_advance_requests c
   where public.cash_module(c.data) = 'fin.cash_advance' and coalesce((c.data->>'disbursed')::boolean, false)
     and (c.data->'liquidation' is null or jsonb_typeof(c.data->'liquidation') <> 'object')
  union all
  select 'liq_review', c.id::text, '₱' || to_char(coalesce(nullif(c.data->'liquidation'->>'totalAmount','')::numeric, 0), 'FM999,999,990.00'),
         coalesce(nullif(c.data->>'technicianName',''), nullif(c.data->>'userName',''), 'Liquidation'),
         coalesce(nullif(c.data->'liquidation'->>'submittedAt','')::timestamptz, c.submitted_at), c.technician_id
    from public.cash_advance_requests c
   where public.cash_module(c.data) = 'fin.cash_advance' and c.data->'liquidation'->>'status' = 'pending'
  union all
  select 'liq_settle', c.id::text, '₱' || to_char(coalesce(nullif(c.data->'liquidation'->'settlement'->>'amount','')::numeric, 0), 'FM999,999,990.00'),
         coalesce(nullif(c.data->>'technicianName',''), nullif(c.data->>'userName',''), 'Liquidation') || ' — '
           || case c.data->'liquidation'->'settlement'->>'type' when 'return' then 'to return' else 'to reimburse' end,
         coalesce(nullif(c.data->'liquidation'->>'decidedAt','')::timestamptz, c.submitted_at), null::uuid
    from public.cash_advance_requests c
   where public.cash_module(c.data) = 'fin.cash_advance' and c.data->'liquidation'->>'status' = 'approved'
     and c.data->'liquidation'->'settlement' is not null
     and not coalesce((c.data->'liquidation'->'settlement'->>'settled')::boolean, false)
  union all
  select 'rb_approve', c.id::text, '₱' || to_char(coalesce(nullif(c.data->>'amount','')::numeric, 0), 'FM999,999,990.00'),
         coalesce(nullif(c.data->>'technicianName',''), nullif(c.data->>'userName',''), 'Reimbursement'), c.submitted_at, c.technician_id
    from public.cash_advance_requests c where c.status = 'pending' and public.cash_module(c.data) = 'fin.reimbursement' and not exists (select 1 from public.request_endorsements e where e.request_kind = 'cash' and e.request_id = c.id and e.status <> 'endorsed')
  union all
  select 'rb_pay', c.id::text, '₱' || to_char(coalesce(nullif(c.data->>'amount','')::numeric, 0), 'FM999,999,990.00'),
         coalesce(nullif(c.data->>'technicianName',''), nullif(c.data->>'userName',''), 'Reimbursement') || ' — not yet paid',
         coalesce(nullif(c.data->>'decidedAt','')::timestamptz, c.submitted_at), null::uuid
    from public.cash_advance_requests c
   where c.status = 'approved' and public.cash_module(c.data) = 'fin.reimbursement' and not coalesce((c.data->>'disbursed')::boolean, false)
  -- Human Resources
  union all
  select 'leave_decide', l.id::text,
         coalesce(nullif(l.data->>'dateFrom',''), nullif(l.data->>'from',''), ''),
         coalesce(nullif(l.data->>'userName',''), nullif(l.data->>'technicianName',''), (select name from public.profiles where id = l.technician_id), 'Leave')
           || ' — ' || coalesce(nullif(l.data->>'leaveType',''), nullif(l.data->>'type',''), 'leave'),
         l.submitted_at, l.technician_id
    from public.leave_requests l where l.status = 'pending' and not exists (select 1 from public.request_endorsements e where e.request_kind = 'leave' and e.request_id = l.id and e.status <> 'endorsed')
  -- A leave request that is still WAITING for its Head's endorsement: the HR approvers see it straight away
  -- (in their Inbox and on their Needs you now card) instead of only after the endorsement. They cannot decide it yet —
  -- the database still refuses until it is endorsed — this is the heads-up.
  union all
  select 'leave_waiting', l.id::text,
         coalesce(nullif(l.data->>'dateFrom',''), nullif(l.data->>'from',''), ''),
         coalesce(nullif(l.data->>'userName',''), nullif(l.data->>'technicianName',''), (select name from public.profiles where id = l.technician_id), 'Leave')
           || ' — ' || coalesce(nullif(l.data->>'leaveType',''), nullif(l.data->>'type',''), 'leave')
           || ' · waiting for ' || coalesce((select p.name from public.request_endorsements e join public.profiles p on p.id = e.head
                                              where e.request_kind = 'leave' and e.request_id = l.id and e.status = 'pending' limit 1), 'the Head') || '''s endorsement',
         l.submitted_at, l.technician_id
    from public.leave_requests l
   where l.status = 'pending'
     and exists (select 1 from public.request_endorsements e where e.request_kind = 'leave' and e.request_id = l.id and e.status = 'pending')
  -- Operations
  union all
  select 'sr_new', r.id::text, left(r.description, 60), coalesce((select name from public.customers where id = r.customer_id), 'Service request'), r.created_at, null::uuid
    from public.service_requests r where r.status = 'new'
  union all
  select 'jo_late', t.id, t.id, coalesce(nullif(t.data->>'custName',''), nullif(t.data->>'customer',''), 'Job order') || ' — scheduled ' || (t.data->>'date'),
         ((nullif(t.data->>'date','')::date + 1)::timestamp at time zone 'Asia/Manila'), null::uuid
    from public.dispatch_tickets t
   where t.status in ('open', 'acknowledged', 'preparing', 'scheduled')
     and nullif(t.data->>'date','')::date < public.manila_today()
  union all
  select 'tool_defect', d.id::text, coalesce(d.defect_no, ''),
         coalesce((select asset_tag || ' ' || name from public.tools where id = d.tool_id), 'Tool') || ' — ' || left(coalesce(d.description, ''), 60),
         d.created_at, null::uuid
    from public.tool_defects d where d.status = 'open'
  -- A sub-user's request waiting for their Head (the Head acts: endorse / decline)
  union all
  select case when e.request_kind = 'leave' then 'leave_endorse'
              when public.cash_module(c.data) = 'fin.reimbursement' then 'rb_endorse' else 'ca_endorse' end,
         e.request_id::text,
         case when e.request_kind = 'leave' then coalesce(nullif(l.data->>'dateFrom',''), nullif(l.data->>'from',''), '')
              else '₱' || to_char(coalesce(nullif(c.data->>'amount','')::numeric, 0), 'FM999,999,990.00') end,
         coalesce((select name from public.profiles where id = e.requester), 'Your team') || ' — ' ||
           case when e.request_kind = 'leave' then coalesce(nullif(l.data->>'leaveType',''), 'leave')
                when public.cash_module(c.data) = 'fin.reimbursement' then 'reimbursement' else 'cash advance' end,
         e.created_at, e.requester
    from public.request_endorsements e
    left join public.leave_requests l on e.request_kind = 'leave' and l.id = e.request_id
    left join public.cash_advance_requests c on e.request_kind = 'cash' and c.id = e.request_id
   where e.status = 'pending'
     and ((e.request_kind = 'leave' and l.status = 'pending') or (e.request_kind = 'cash' and c.status = 'pending'));
$$;;

create or replace function public.inbox_items()
returns jsonb
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(to_jsonb(x) - 'owner' order by
           case x.state when 'escalated' then 0 when 'overdue' then 1 else 2 end, x.age_hours desc), '[]'::jsonb)
    from public.inbox_items_with_state() x
   where (x.owner is null or x.owner is distinct from auth.uid() or public.is_admin())
     and (public.is_admin()
      -- endorsement items: only the requester's own Head
      or (x.kind like '%\_endorse' escape '\' and public.is_supervisor_of(x.owner))
      or (x.kind not like '%\_endorse' escape '\' and public.has_perm(x.module, x.level)
          and not (x.kind = 'leave_waiting' and public.is_supervisor_of(x.owner))   -- the endorsing Head already has "to endorse"
          and not (x.kind in ('leave_decide', 'ca_approve', 'rb_approve', 'liq_review') and public.staff_is_head(x.owner)))
      or (x.state = 'escalated' and x.kind not like '%\_endorse' escape '\' and public.has_perm(x.module, 'view')
          and not (x.kind in ('leave_decide', 'ca_approve', 'rb_approve', 'liq_review') and public.staff_is_head(x.owner))
          and exists (select 1 from public.staff_departments d where d.user_id = auth.uid() and d.department_id = x.department and d.is_head)));
$$;;

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

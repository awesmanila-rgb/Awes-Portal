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

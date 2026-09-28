-- ---------------------------------------------------------------------
-- Inventory — Reports (read-only; nothing here writes data)
--
--   inv_rpt_balance        per month × warehouse × item:
--                          beginning, + purchased, + returned, − issued,
--                          ± transfers, ± adjustments (opening/count/write-off),
--                          = ending — quantities and values
--   inv_rpt_register       every purchase, issuance and return line in a
--                          period (with slip no., PO, supplier, worker,
--                          project/job; damaged returns included)
--   inv_rpt_project_cost   material cost per project per month (+ budget)
--   inv_rpt_slow_moving    items in stock with no issue for N days
--   inv_rpt_reorder        usage per month, months of stock left, and a
--                          suggested order quantity
--   inv_rpt_unreturned     what each worker still holds, and for how long
--
-- All computed from the stock ledger in one query each. Months follow
-- Philippine time (Asia/Manila), so an 11 pm posting on the 31st lands in
-- the right month.
--
-- Access: admins see everything, including values. Storekeepers see only
-- their own warehouses and NEVER money — every value column comes back
-- NULL for them (and Project Cost is admin-only).
--
-- Depends on 20260923_07 and _08. Safe to re-run.
-- ---------------------------------------------------------------------

do $$
begin
  if to_regclass('public.issue_slips') is null then
    raise exception 'Run 20260923_08_inventory_movements.sql first.';
  end if;
end $$;

create or replace function public.inv_local_date(ts timestamptz)
returns date language sql immutable as $$ select (ts at time zone 'Asia/Manila')::date $$;

-- ---------------------------------------------------------------------
-- 1. Beginning / ending balance per month per item
-- ---------------------------------------------------------------------
create or replace function public.inv_rpt_balance(p_from date, p_to date, p_warehouse uuid default null)
returns table (month date, warehouse_id uuid, material_id uuid,
               beg_qty numeric, purch_qty numeric, ret_qty numeric, iss_qty numeric, trf_qty numeric, adj_qty numeric, end_qty numeric,
               beg_value numeric, purch_value numeric, ret_value numeric, iss_value numeric, trf_value numeric, adj_value numeric, end_value numeric)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  f date := date_trunc('month', p_from)::date;
  t date := date_trunc('month', coalesce(p_to, p_from))::date;
  money boolean := public.is_admin();
begin
  if t < f then raise exception 'The end month is before the start month.' using errcode = 'P0001'; end if;
  if (extract(year from age(t, f)) * 12 + extract(month from age(t, f))) > 35 then
    raise exception 'Choose at most 36 months at a time.' using errcode = 'P0001';
  end if;
  return query
  with mv as (
    select m.warehouse_id wh, m.material_id mat, date_trunc('month', public.inv_local_date(m.created_at))::date mon,
           m.doc_type dt, m.qty q, coalesce(m.value, 0) v
      from public.stock_movements m
     where public.inv_can_handle(m.warehouse_id)
       and (p_warehouse is null or m.warehouse_id = p_warehouse)
       and date_trunc('month', public.inv_local_date(m.created_at))::date <= t),
  months as (select gs::date mon from generate_series(f, t, interval '1 month') gs),
  keys as (select distinct wh, mat from mv),
  agg as (
    select mo.mon, k.wh, k.mat,
      coalesce(sum(mv.q) filter (where mv.mon < mo.mon), 0) bq,
      coalesce(sum(mv.v) filter (where mv.mon < mo.mon), 0) bv,
      coalesce(sum(mv.q) filter (where mv.mon = mo.mon and mv.dt = 'receipt'), 0) pq,
      coalesce(sum(mv.v) filter (where mv.mon = mo.mon and mv.dt = 'receipt'), 0) pv,
      coalesce(sum(mv.q) filter (where mv.mon = mo.mon and mv.dt = 'return'), 0) rq,
      coalesce(sum(mv.v) filter (where mv.mon = mo.mon and mv.dt = 'return'), 0) rv,
      coalesce(-sum(mv.q) filter (where mv.mon = mo.mon and mv.dt = 'issue'), 0) iq,
      coalesce(-sum(mv.v) filter (where mv.mon = mo.mon and mv.dt = 'issue'), 0) iv,
      coalesce(sum(mv.q) filter (where mv.mon = mo.mon and mv.dt in ('transfer_in', 'transfer_out')), 0) tq,
      coalesce(sum(mv.v) filter (where mv.mon = mo.mon and mv.dt in ('transfer_in', 'transfer_out')), 0) tv,
      coalesce(sum(mv.q) filter (where mv.mon = mo.mon and mv.dt in ('opening', 'adjustment', 'write_off')), 0) aq,
      coalesce(sum(mv.v) filter (where mv.mon = mo.mon and mv.dt in ('opening', 'adjustment', 'write_off')), 0) av
    from months mo cross join keys k
    left join mv on mv.wh = k.wh and mv.mat = k.mat and mv.mon <= mo.mon
    group by mo.mon, k.wh, k.mat)
  select a.mon, a.wh, a.mat, a.bq, a.pq, a.rq, a.iq, a.tq, a.aq, a.bq + a.pq + a.rq - a.iq + a.tq + a.aq,
         case when money then a.bv end, case when money then a.pv end, case when money then a.rv end,
         case when money then a.iv end, case when money then a.tv end, case when money then a.av end,
         case when money then a.bv + a.pv + a.rv - a.iv + a.tv + a.av end
    from agg a
   where a.bq <> 0 or a.pq <> 0 or a.rq <> 0 or a.iq <> 0 or a.tq <> 0 or a.aq <> 0
   order by a.mon, a.wh, a.mat;
end; $$;

-- ---------------------------------------------------------------------
-- 2. Purchases, issuances and returns — line register for a period
--    (p_from / p_to are dates, inclusive, Manila time)
-- ---------------------------------------------------------------------
create or replace function public.inv_rpt_register(p_from date, p_to date, p_warehouse uuid default null)
returns table (kind text, at timestamptz, doc_ref text, warehouse_id uuid, material_id uuid, qty numeric,
               unit_cost numeric, value numeric, project_id uuid, job_order_id text,
               worker_name text, supplier text, po_no text, condition text, note text)
language sql stable security definer set search_path = public, pg_temp as $$
  with mv as (
    select m.* from public.stock_movements m
     where public.inv_can_handle(m.warehouse_id)
       and (p_warehouse is null or m.warehouse_id = p_warehouse)
       and public.inv_local_date(m.created_at) between p_from and p_to
       and m.doc_type in ('receipt', 'issue', 'return'))
  -- purchases (receipts, with PO + supplier)
  select 'purchase', mv.created_at, mv.doc_ref, mv.warehouse_id, mv.material_id, mv.qty,
         case when public.is_admin() then mv.unit_cost end, case when public.is_admin() then mv.value end,
         r.direct_project_id, r.direct_job_order_id, null::text,
         coalesce(nullif(s.trade_name, ''), s.name), po.po_no, null::text, r.supplier_ref
    from mv join public.stock_receipts r on r.id = mv.doc_id
    left join public.purchase_orders po on po.id = r.po_id
    left join public.suppliers s on s.id = r.supplier_id
   where mv.doc_type = 'receipt'
  union all
  -- issuances (issue slips, and direct-to-site pass-throughs)
  select 'issue', mv.created_at, mv.doc_ref, mv.warehouse_id, mv.material_id, -mv.qty,
         case when public.is_admin() then mv.unit_cost end, case when public.is_admin() then -mv.value end,
         mv.project_id, mv.job_order_id, coalesce(sl.worker_name, case when sl.id is null then 'Direct to site' end),
         null, null, null, coalesce(nullif(mv.note, ''), sl.note)
    from mv left join public.issue_slips sl on sl.id = mv.doc_id
   where mv.doc_type = 'issue'
  union all
  -- returns in good condition (back into stock)
  select 'return', mv.created_at, mv.doc_ref, mv.warehouse_id, mv.material_id, mv.qty,
         case when public.is_admin() then mv.unit_cost end, case when public.is_admin() then mv.value end,
         mv.project_id, mv.job_order_id, rs.worker_name, null, null, 'good', rs.note
    from mv left join public.return_slips rs on rs.id = mv.doc_id
   where mv.doc_type = 'return'
  union all
  -- damaged returns: recorded on the slip, never restocked (no ledger line)
  select 'return', rs.created_at, rs.return_no, rs.warehouse_id, ri.material_id, ri.qty, null, null,
         rs.project_id, rs.job_order_id, rs.worker_name, null, null, 'damaged', rs.note
    from public.return_slips rs join public.return_slip_items ri on ri.return_id = rs.id
   where ri.condition = 'damaged' and public.inv_can_handle(rs.warehouse_id)
     and (p_warehouse is null or rs.warehouse_id = p_warehouse)
     and public.inv_local_date(rs.created_at) between p_from and p_to
  order by 2, 3;
$$;

-- ---------------------------------------------------------------------
-- 3. Project material cost per month (admin only)
-- ---------------------------------------------------------------------
create or replace function public.inv_rpt_project_cost(p_from date, p_to date)
returns table (project_id uuid, month date, cost numeric)
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(m.project_id, pj.project_id), date_trunc('month', public.inv_local_date(m.created_at))::date,
         -sum(m.value)
    from public.stock_movements m
    left join public.project_job_orders pj on pj.job_order_id = m.job_order_id
   where public.is_admin()
     and m.doc_type in ('issue', 'return')
     and coalesce(m.project_id, pj.project_id) is not null
     and public.inv_local_date(m.created_at) <= p_to
   group by 1, 2;
   -- every month up to p_to: the screen shows p_from..p_to as columns and
   -- also needs the earlier months for the "cost to date" total
$$;

-- ---------------------------------------------------------------------
-- 4. Slow-moving / dead stock
-- ---------------------------------------------------------------------
create or replace function public.inv_rpt_slow_moving()
returns table (warehouse_id uuid, material_id uuid, qty_on_hand numeric, value numeric,
               last_out date, first_in date, days_idle int)
language sql stable security definer set search_path = public, pg_temp as $$
  select b.warehouse_id, b.material_id, b.qty_on_hand,
         case when public.is_admin() then round(b.qty_on_hand * b.avg_cost, 2) end,
         max(public.inv_local_date(m.created_at)) filter (where m.doc_type in ('issue', 'transfer_out')),
         min(public.inv_local_date(m.created_at)) filter (where m.qty > 0),
         ((now() at time zone 'Asia/Manila')::date
           - coalesce(max(public.inv_local_date(m.created_at)) filter (where m.doc_type in ('issue', 'transfer_out')),
                      min(public.inv_local_date(m.created_at)) filter (where m.qty > 0)))::int
    from public.stock_balances b
    join public.stock_movements m on m.warehouse_id = b.warehouse_id and m.material_id = b.material_id
   where b.qty_on_hand > 0 and public.inv_can_handle(b.warehouse_id)
   group by b.warehouse_id, b.material_id, b.qty_on_hand, b.avg_cost;
$$;

-- ---------------------------------------------------------------------
-- 5. Reorder suggestions (company-wide per item, across the caller's
--    warehouses). usage = issues in the last p_days, per 30 days.
--    Reorder when stock covers less than lead time + half a month;
--    suggest enough for lead time + one month.
-- ---------------------------------------------------------------------
create or replace function public.inv_rpt_reorder(p_days int default 90)
returns table (material_id uuid, on_hand numeric, issued_window numeric, usage_per_month numeric,
               months_cover numeric, lead_days int, reorder boolean, suggested_qty numeric,
               supplier_id uuid, supplier text, unit_price numeric)
language sql stable security definer set search_path = public, pg_temp as $$
  with oh as (
    select b.material_id, sum(b.qty_on_hand) q from public.stock_balances b
     where public.inv_can_handle(b.warehouse_id) group by 1),
  used as (
    select m.material_id, -sum(m.qty) q from public.stock_movements m
     where m.doc_type = 'issue' and public.inv_can_handle(m.warehouse_id)
       and m.created_at >= now() - make_interval(days => greatest(p_days, 7))
     group by 1),
  pref as (
    select distinct on (sm.material_id) sm.material_id, sm.supplier_id, sm.lead_time_days, sm.price,
           coalesce(nullif(s.trade_name, ''), s.name) sname
      from public.supplier_materials sm join public.suppliers s on s.id = sm.supplier_id
     where sm.is_active and s.is_active
     order by sm.material_id, sm.is_preferred desc, sm.price asc nulls last),
  base as (
    select coalesce(oh.material_id, used.material_id) mat, coalesce(oh.q, 0) onh, coalesce(used.q, 0) uw,
           round(coalesce(used.q, 0) / (greatest(p_days, 7) / 30.0), 3) upm,
           coalesce(pref.lead_time_days, 7) ld, pref.supplier_id, pref.sname, pref.price
      from oh full join used on used.material_id = oh.material_id
      left join pref on pref.material_id = coalesce(oh.material_id, used.material_id))
  select mat, onh, uw, upm,
         case when upm > 0 then round(onh / upm, 2) end,
         ld,
         upm > 0 and onh < upm * (ld / 30.0 + 0.5),
         case when upm > 0 and onh < upm * (ld / 30.0 + 0.5) then ceil(upm * (ld / 30.0 + 1) - onh) else 0 end,
         case when public.is_admin() then supplier_id end,
         case when public.is_admin() then sname end,
         case when public.is_admin() then price end
    from base
   where public.is_admin() or public.inv_is_storekeeper();
$$;

-- ---------------------------------------------------------------------
-- 6. Unreturned materials by worker: what each person still holds and
--    since when (oldest issue not yet covered by returns — first in,
--    first out).
-- ---------------------------------------------------------------------
create or replace function public.inv_rpt_unreturned()
returns table (worker_id uuid, worker_name text, material_id uuid, project_id uuid, job_order_id text,
               warehouse_id uuid, holding numeric, value numeric, oldest date, days_held int)
language sql stable security definer set search_path = public, pg_temp as $$
  with iss as (
    select s.worker_id, s.worker_name, it.material_id, s.project_id, s.job_order_id, s.warehouse_id, s.created_at, it.qty,
           sum(it.qty) over (partition by s.worker_id, it.material_id, s.project_id, s.job_order_id
                             order by s.created_at, s.id rows unbounded preceding) cum,
           (select m.unit_cost from public.stock_movements m where m.doc_id = s.id and m.material_id = it.material_id and m.doc_type = 'issue' limit 1) cost
      from public.issue_slips s join public.issue_slip_items it on it.slip_id = s.id
     where public.inv_can_handle(s.warehouse_id)),
  ret as (
    select r.worker_id, ri.material_id, r.project_id, r.job_order_id, sum(ri.qty) q
      from public.return_slips r join public.return_slip_items ri on ri.return_id = r.id
     group by 1, 2, 3, 4),
  tot as (
    select worker_id, material_id, project_id, job_order_id, sum(qty) issued, avg(cost) cost
      from iss group by 1, 2, 3, 4),
  oldest as (
    select distinct on (i.worker_id, i.material_id, i.project_id, i.job_order_id)
           i.worker_id, i.worker_name, i.material_id, i.project_id, i.job_order_id, i.warehouse_id, i.created_at
      from iss i left join ret r on r.worker_id = i.worker_id and r.material_id = i.material_id
                                and r.project_id is not distinct from i.project_id and r.job_order_id is not distinct from i.job_order_id
     where i.cum > coalesce(r.q, 0)
     order by i.worker_id, i.material_id, i.project_id, i.job_order_id, i.created_at)
  select o.worker_id, o.worker_name, o.material_id, o.project_id, o.job_order_id, o.warehouse_id,
         t.issued - coalesce(r.q, 0),
         case when public.is_admin() then round((t.issued - coalesce(r.q, 0)) * t.cost, 2) end,
         public.inv_local_date(o.created_at),
         ((now() at time zone 'Asia/Manila')::date - public.inv_local_date(o.created_at))::int
    from oldest o
    join tot t on t.worker_id = o.worker_id and t.material_id = o.material_id
              and t.project_id is not distinct from o.project_id and t.job_order_id is not distinct from o.job_order_id
    left join ret r on r.worker_id = o.worker_id and r.material_id = o.material_id
                   and r.project_id is not distinct from o.project_id and r.job_order_id is not distinct from o.job_order_id
   where t.issued - coalesce(r.q, 0) > 0;
$$;

revoke all on function public.inv_rpt_balance(date, date, uuid), public.inv_rpt_register(date, date, uuid),
                       public.inv_rpt_project_cost(date, date), public.inv_rpt_slow_moving(),
                       public.inv_rpt_reorder(int), public.inv_rpt_unreturned() from public, anon;
grant execute on function public.inv_rpt_balance(date, date, uuid), public.inv_rpt_register(date, date, uuid),
                          public.inv_rpt_project_cost(date, date), public.inv_rpt_slow_moving(),
                          public.inv_rpt_reorder(int), public.inv_rpt_unreturned() to authenticated;

NOTIFY pgrst, 'reload schema';

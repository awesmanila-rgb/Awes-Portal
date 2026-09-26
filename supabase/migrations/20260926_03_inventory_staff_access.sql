-- =====================================================================
-- AWES App — Open INVENTORY to department staff (Round 1, Phase 3b)
--
-- Pages opened: Stock on Hand (inv.stock), Warehouses (inv.warehouses),
-- Receive (inv.receive), Issue to Worker (inv.issue), Returns
-- (inv.returns), Transfers (inv.transfers), Slips & History (inv.slips),
-- Inventory Reports (inv.reports).
--
-- How staff differ from storekeepers:
--   * Storekeepers (unchanged) handle only the warehouses they're assigned
--     to, and always see quantities only.
--   * Staff work across ALL warehouses, per page:
--       View  see that page's documents / figures
--       Edit  post on that page (receive, issue, return, transfer; add or
--             change warehouses; stock counts & opening balances)
--   * Peso values (unit costs, stock value, project cost, supplier prices
--     in reports) only for staff with "See peso values" (fin.costs) —
--     exactly like the Super Admin. Without it staff see quantities only,
--     like a storekeeper.
--
-- Still Super Admin only: assigning storekeepers (Users & Roles), and
-- Projects (opened with Operations).
--
-- Requires 20260926_01 and the inventory migrations 20260923_07 … _09.
-- Idempotent.
-- =====================================================================

begin;

do $$ begin
  if to_regprocedure('public.has_perm(text,text)') is null then
    raise exception 'Run 20260926_01_departments_access.sql first.';
  end if;
  if to_regprocedure('public.inv_post_receipt(jsonb)') is null then
    raise exception 'Run the inventory migrations (20260923_07 … _09) first.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. Warehouse check for posting, per page
-- ---------------------------------------------------------------------
-- The one-argument version (storekeepers + admin) is kept as it was.
create or replace function public.inv_require_warehouse(p_warehouse uuid, p_module text)
returns void
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from public.warehouses where id = p_warehouse and is_active) then
    raise exception 'That warehouse doesn''t exist or is inactive.' using errcode = 'P0001';
  end if;
  if not (public.inv_can_handle(p_warehouse) or public.has_perm(p_module, 'edit')) then
    if public.is_staff() then
      raise exception 'You need Edit access for % to post this.',
        coalesce((select label from public.app_modules where key = p_module), p_module) using errcode = '42501';
    end if;
    raise exception 'You''re not a storekeeper of that warehouse.' using errcode = '42501';   -- as before
  end if;
end;
$$;
revoke execute on function public.inv_require_warehouse(uuid, text) from public, anon;
grant execute on function public.inv_require_warehouse(uuid, text) to authenticated, service_role;


-- ---------------------------------------------------------------------
-- 2. Posting, lookups and reports (current live bodies; only the
--    permission lines changed)
-- ---------------------------------------------------------------------
create or replace function public.inv_post_receipt(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  perform public.inv_require_warehouse(wh, 'inv.receive');
  direct := dproj is not null or djob is not null;
  if direct and not public.has_perm('inv.receive', 'edit') then
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
      cost := case when public.has_perm('inv.receive', 'edit') and public.can_see_costs() then nullif(l->>'unit_cost', '')::numeric else null end;
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
end; $function$;

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
             fulfilled_by = case when qty_issued + v_qty >= coalesce(qty_approved, qty_requested) then 'stock' else fulfilled_by end
       where id = mi.id;
    end if;
    insert into public.issue_slip_items (slip_id, line_no, material_id, qty, mr_item_id) values (sid, i, mat, v_qty, nullif(l->>'mr_item_id', '')::uuid);
    -- the ledger trigger refuses this if there isn't enough stock
    insert into public.stock_movements (doc_type, doc_ref, doc_id, warehouse_id, material_id, qty, project_id, job_order_id, worker_id)
    values ('issue', sno, sid, wh, mat, -v_qty, proj, job, wk);
  end loop;
  return jsonb_build_object('id', sid, 'slip_no', sno);
end; $function$;

create or replace function public.inv_post_return(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  wh uuid := (p->>'warehouse_id')::uuid;
  wk uuid := nullif(p->>'worker_id', '')::uuid;
  iss record;
  proj uuid := nullif(p->>'project_id', '')::uuid;
  job text := nullif(p->>'job_order_id', '');
  l jsonb; i int := 0; rid uuid; rno text; v_qty numeric; mat uuid; cond text; cost numeric; outq numeric;
begin
  select * into iss from public.issue_slips where false;
  perform public.inv_require_warehouse(wh, 'inv.returns');
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
end; $function$;

create or replace function public.inv_post_transfer(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  f uuid := (p->>'from_warehouse_id')::uuid; t uuid := (p->>'to_warehouse_id')::uuid;
  l jsonb; i int := 0; tid uuid; tno text; v_qty numeric; mat uuid; cost numeric;
begin
  perform public.inv_require_warehouse(f, 'inv.transfers');
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
end; $function$;

create or replace function public.inv_pos_to_receive()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', po.id, 'po_no', po.po_no, 'po_date', po.po_date, 'reference', po.reference,
           'supplier', coalesce(nullif(s.trade_name, ''), s.name),
           'items', (select jsonb_agg(jsonb_build_object('id', i.id, 'line_no', i.line_no, 'material_id', i.material_id,
                       'code', i.code, 'description', i.description, 'unit', i.unit, 'qty', i.qty, 'qty_received', i.qty_received) order by i.line_no)
                     from public.purchase_order_items i where i.po_id = po.id)
         ) order by po.po_date desc), '[]'::jsonb)
    from public.purchase_orders po left join public.suppliers s on s.id = po.supplier_id
   where (public.is_admin() or public.inv_is_storekeeper() or public.has_perm('inv.receive', 'view'))
     and po.status = 'issued'
     and exists (select 1 from public.purchase_order_items i where i.po_id = po.id and i.qty_received < i.qty);
$function$;

create or replace function public.inv_open_job_orders()
 RETURNS TABLE(id text, cust_name text, site_address text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select d.id, coalesce(d.data->>'custName', ''), coalesce(d.data->>'siteAddress', '')
    from public.dispatch_tickets d
   where (public.is_admin() or public.inv_is_storekeeper() or public.has_perm('inv.issue', 'view') or public.has_perm('inv.receive', 'view') or public.has_perm('inv.returns', 'view'))
     and coalesce(d.data->>'status', d.status, 'open') not in ('completed', 'closed', 'cancelled')
   order by d.created_at desc limit 500;
$function$;

create or replace function public.inv_worker_holdings(p_worker uuid)
 RETURNS TABLE(material_id uuid, project_id uuid, job_order_id text, issued numeric, returned numeric, holding numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
   where (public.is_admin() or public.inv_is_storekeeper() or public.has_perm('inv.issue', 'view') or public.has_perm('inv.returns', 'view') or p_worker = auth.uid())
     and o.q - coalesce(r.q, 0) > 0;
$function$;

create or replace function public.inv_rpt_balance(p_from date, p_to date, p_warehouse uuid DEFAULT NULL::uuid)
 RETURNS TABLE(month date, warehouse_id uuid, material_id uuid, beg_qty numeric, purch_qty numeric, ret_qty numeric, iss_qty numeric, trf_qty numeric, adj_qty numeric, end_qty numeric, beg_value numeric, purch_value numeric, ret_value numeric, iss_value numeric, trf_value numeric, adj_value numeric, end_value numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  f date := date_trunc('month', p_from)::date;
  t date := date_trunc('month', coalesce(p_to, p_from))::date;
  money boolean := public.can_see_costs();
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
     where (public.inv_can_handle(m.warehouse_id) or public.has_perm('inv.reports', 'view'))
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
end; $function$;

create or replace function public.inv_rpt_register(p_from date, p_to date, p_warehouse uuid DEFAULT NULL::uuid)
 RETURNS TABLE(kind text, at timestamp with time zone, doc_ref text, warehouse_id uuid, material_id uuid, qty numeric, unit_cost numeric, value numeric, project_id uuid, job_order_id text, worker_name text, supplier text, po_no text, condition text, note text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with mv as (
    select m.* from public.stock_movements m
     where (public.inv_can_handle(m.warehouse_id) or public.has_perm('inv.reports', 'view'))
       and (p_warehouse is null or m.warehouse_id = p_warehouse)
       and public.inv_local_date(m.created_at) between p_from and p_to
       and m.doc_type in ('receipt', 'issue', 'return'))
  -- purchases (receipts, with PO + supplier)
  select 'purchase', mv.created_at, mv.doc_ref, mv.warehouse_id, mv.material_id, mv.qty,
         case when public.can_see_costs() then mv.unit_cost end, case when public.can_see_costs() then mv.value end,
         r.direct_project_id, r.direct_job_order_id, null::text,
         coalesce(nullif(s.trade_name, ''), s.name), po.po_no, null::text, r.supplier_ref
    from mv join public.stock_receipts r on r.id = mv.doc_id
    left join public.purchase_orders po on po.id = r.po_id
    left join public.suppliers s on s.id = r.supplier_id
   where mv.doc_type = 'receipt'
  union all
  -- issuances (issue slips, and direct-to-site pass-throughs)
  select 'issue', mv.created_at, mv.doc_ref, mv.warehouse_id, mv.material_id, -mv.qty,
         case when public.can_see_costs() then mv.unit_cost end, case when public.can_see_costs() then -mv.value end,
         mv.project_id, mv.job_order_id, coalesce(sl.worker_name, case when sl.id is null then 'Direct to site' end),
         null, null, null, coalesce(nullif(mv.note, ''), sl.note)
    from mv left join public.issue_slips sl on sl.id = mv.doc_id
   where mv.doc_type = 'issue'
  union all
  -- returns in good condition (back into stock)
  select 'return', mv.created_at, mv.doc_ref, mv.warehouse_id, mv.material_id, mv.qty,
         case when public.can_see_costs() then mv.unit_cost end, case when public.can_see_costs() then mv.value end,
         mv.project_id, mv.job_order_id, rs.worker_name, null, null, 'good', rs.note
    from mv left join public.return_slips rs on rs.id = mv.doc_id
   where mv.doc_type = 'return'
  union all
  -- damaged returns: recorded on the slip, never restocked (no ledger line)
  select 'return', rs.created_at, rs.return_no, rs.warehouse_id, ri.material_id, ri.qty, null, null,
         rs.project_id, rs.job_order_id, rs.worker_name, null, null, 'damaged', rs.note
    from public.return_slips rs join public.return_slip_items ri on ri.return_id = rs.id
   where ri.condition = 'damaged' and (public.inv_can_handle(rs.warehouse_id) or public.has_perm('inv.reports', 'view'))
     and (p_warehouse is null or rs.warehouse_id = p_warehouse)
     and public.inv_local_date(rs.created_at) between p_from and p_to
  order by 2, 3;
$function$;

create or replace function public.inv_rpt_reorder(p_days integer DEFAULT 90)
 RETURNS TABLE(material_id uuid, on_hand numeric, issued_window numeric, usage_per_month numeric, months_cover numeric, lead_days integer, reorder boolean, suggested_qty numeric, supplier_id uuid, supplier text, unit_price numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with oh as (
    select b.material_id, sum(b.qty_on_hand) q from public.stock_balances b
     where (public.inv_can_handle(b.warehouse_id) or public.has_perm('inv.reports', 'view')) group by 1),
  used as (
    select m.material_id, -sum(m.qty) q from public.stock_movements m
     where m.doc_type = 'issue' and (public.inv_can_handle(m.warehouse_id) or public.has_perm('inv.reports', 'view'))
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
         case when public.can_see_costs() then supplier_id end,
         case when public.can_see_costs() then sname end,
         case when public.can_see_costs() then price end
    from base
   where public.is_admin() or public.inv_is_storekeeper() or public.has_perm('inv.reports', 'view');
$function$;

create or replace function public.inv_rpt_slow_moving()
 RETURNS TABLE(warehouse_id uuid, material_id uuid, qty_on_hand numeric, value numeric, last_out date, first_in date, days_idle integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select b.warehouse_id, b.material_id, b.qty_on_hand,
         case when public.can_see_costs() then round(b.qty_on_hand * b.avg_cost, 2) end,
         max(public.inv_local_date(m.created_at)) filter (where m.doc_type in ('issue', 'transfer_out')),
         min(public.inv_local_date(m.created_at)) filter (where m.qty > 0),
         ((now() at time zone 'Asia/Manila')::date
           - coalesce(max(public.inv_local_date(m.created_at)) filter (where m.doc_type in ('issue', 'transfer_out')),
                      min(public.inv_local_date(m.created_at)) filter (where m.qty > 0)))::int
    from public.stock_balances b
    join public.stock_movements m on m.warehouse_id = b.warehouse_id and m.material_id = b.material_id
   where b.qty_on_hand > 0 and (public.inv_can_handle(b.warehouse_id) or public.has_perm('inv.reports', 'view'))
   group by b.warehouse_id, b.material_id, b.qty_on_hand, b.avg_cost;
$function$;

create or replace function public.inv_rpt_unreturned()
 RETURNS TABLE(worker_id uuid, worker_name text, material_id uuid, project_id uuid, job_order_id text, warehouse_id uuid, holding numeric, value numeric, oldest date, days_held integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with iss as (
    select s.worker_id, s.worker_name, it.material_id, s.project_id, s.job_order_id, s.warehouse_id, s.created_at, it.qty,
           sum(it.qty) over (partition by s.worker_id, it.material_id, s.project_id, s.job_order_id
                             order by s.created_at, s.id rows unbounded preceding) cum,
           (select m.unit_cost from public.stock_movements m where m.doc_id = s.id and m.material_id = it.material_id and m.doc_type = 'issue' limit 1) cost
      from public.issue_slips s join public.issue_slip_items it on it.slip_id = s.id
     where (public.inv_can_handle(s.warehouse_id) or public.has_perm('inv.reports', 'view'))),
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
         case when public.can_see_costs() then round((t.issued - coalesce(r.q, 0)) * t.cost, 2) end,
         public.inv_local_date(o.created_at),
         ((now() at time zone 'Asia/Manila')::date - public.inv_local_date(o.created_at))::int
    from oldest o
    join tot t on t.worker_id = o.worker_id and t.material_id = o.material_id
              and t.project_id is not distinct from o.project_id and t.job_order_id is not distinct from o.job_order_id
    left join ret r on r.worker_id = o.worker_id and r.material_id = o.material_id
                   and r.project_id is not distinct from o.project_id and r.job_order_id is not distinct from o.job_order_id
   where t.issued - coalesce(r.q, 0) > 0;
$function$;

create or replace function public.inv_rpt_project_cost(p_from date, p_to date)
 RETURNS TABLE(project_id uuid, month date, cost numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce(m.project_id, pj.project_id), date_trunc('month', public.inv_local_date(m.created_at))::date,
         -sum(m.value)
    from public.stock_movements m
    left join public.project_job_orders pj on pj.job_order_id = m.job_order_id
   where public.can_see_costs() and (public.has_perm('inv.reports', 'view') or public.has_perm('ops.projects', 'view'))
     and m.doc_type in ('issue', 'return')
     and coalesce(m.project_id, pj.project_id) is not null
     and public.inv_local_date(m.created_at) <= p_to
   group by 1, 2;
   -- every month up to p_to: the screen shows p_from..p_to as columns and
   -- also needs the earlier months for the "cost to date" total
$function$;


-- ---------------------------------------------------------------------
-- 3. Quantity views: staff with an inventory page see every warehouse
-- ---------------------------------------------------------------------
create or replace view public.stock_on_hand_qty as
  select warehouse_id, material_id, qty_on_hand, updated_at
    from public.stock_balances b
   where public.is_admin() or public.inv_is_storekeeper_of(warehouse_id)
      or ((select public.has_perm('inv.stock', 'view')) or (select public.has_perm('inv.warehouses', 'view')) or (select public.has_perm('inv.receive', 'view')) or (select public.has_perm('inv.issue', 'view')) or (select public.has_perm('inv.returns', 'view')) or (select public.has_perm('inv.transfers', 'view')) or (select public.has_perm('inv.slips', 'view')) or (select public.has_perm('inv.reports', 'view')));

create or replace view public.stock_movements_qty as
  select id, doc_type, doc_ref, warehouse_id, material_id, qty, balance_after,
         project_id, job_order_id, worker_id, note, created_by, created_at
    from public.stock_movements m
   where public.is_admin() or public.inv_is_storekeeper_of(warehouse_id)
      or ((select public.has_perm('inv.stock', 'view')) or (select public.has_perm('inv.slips', 'view')) or (select public.has_perm('inv.reports', 'view')) or (select public.has_perm('ops.projects', 'view')));


-- ---------------------------------------------------------------------
-- 4. Row-level security
-- ---------------------------------------------------------------------
-- Balances and the movement ledger carry peso values → "See peso values".
drop policy if exists stock_balances_admin_read on public.stock_balances;
drop policy if exists stock_balances_staff_read on public.stock_balances;
create policy stock_balances_staff_read on public.stock_balances for select to authenticated
  using (public.is_admin() or ((select public.can_see_costs()) and ((select public.has_perm('inv.stock', 'view')) or (select public.has_perm('inv.warehouses', 'view')) or (select public.has_perm('inv.reports', 'view')))));

drop policy if exists stock_movements_admin_read on public.stock_movements;
drop policy if exists stock_movements_staff_read on public.stock_movements;
create policy stock_movements_staff_read on public.stock_movements for select to authenticated
  using (public.is_admin() or ((select public.can_see_costs()) and ((select public.has_perm('inv.stock', 'view')) or (select public.has_perm('inv.slips', 'view')) or (select public.has_perm('inv.reports', 'view')) or (select public.has_perm('ops.projects', 'view')))));

-- Opening balances and count adjustments (Stock on Hand → Edit, with costs)
drop policy if exists stock_movements_admin_insert on public.stock_movements;
drop policy if exists stock_movements_staff_insert on public.stock_movements;
create policy stock_movements_staff_insert on public.stock_movements for insert to authenticated
  with check ((public.is_admin() or ((select public.has_perm('inv.stock', 'edit')) and (select public.can_see_costs())))
              and doc_type = any (array['opening', 'adjustment']));

-- Documents: storekeepers of that warehouse (as before), the worker on the
-- slip (as before), or staff with that page or Slips & History.
drop policy if exists rcv_read on public.stock_receipts;
create policy rcv_read on public.stock_receipts for select to authenticated
  using (public.inv_can_handle(warehouse_id) or ((select public.has_perm('inv.receive', 'view')) or (select public.has_perm('inv.slips', 'view')) or (select public.has_perm('inv.reports', 'view'))));
drop policy if exists rcv_items_read on public.stock_receipt_items;
create policy rcv_items_read on public.stock_receipt_items for select to authenticated
  using (exists (select 1 from public.stock_receipts r where r.id = receipt_id
                  and (public.inv_can_handle(r.warehouse_id) or ((select public.has_perm('inv.receive', 'view')) or (select public.has_perm('inv.slips', 'view')) or (select public.has_perm('inv.reports', 'view'))))));

drop policy if exists iss_read on public.issue_slips;
create policy iss_read on public.issue_slips for select to authenticated
  using (public.inv_can_handle(warehouse_id) or worker_id = auth.uid() or ((select public.has_perm('inv.issue', 'view')) or (select public.has_perm('inv.returns', 'view')) or (select public.has_perm('inv.slips', 'view')) or (select public.has_perm('inv.reports', 'view'))));
drop policy if exists iss_items_read on public.issue_slip_items;
create policy iss_items_read on public.issue_slip_items for select to authenticated
  using (exists (select 1 from public.issue_slips s where s.id = slip_id
                  and (public.inv_can_handle(s.warehouse_id) or s.worker_id = auth.uid() or ((select public.has_perm('inv.issue', 'view')) or (select public.has_perm('inv.returns', 'view')) or (select public.has_perm('inv.slips', 'view')) or (select public.has_perm('inv.reports', 'view'))))));

drop policy if exists ret_read on public.return_slips;
create policy ret_read on public.return_slips for select to authenticated
  using (public.inv_can_handle(warehouse_id) or worker_id = auth.uid() or ((select public.has_perm('inv.returns', 'view')) or (select public.has_perm('inv.slips', 'view')) or (select public.has_perm('inv.reports', 'view'))));
drop policy if exists ret_items_read on public.return_slip_items;
create policy ret_items_read on public.return_slip_items for select to authenticated
  using (exists (select 1 from public.return_slips s where s.id = return_id
                  and (public.inv_can_handle(s.warehouse_id) or s.worker_id = auth.uid() or ((select public.has_perm('inv.returns', 'view')) or (select public.has_perm('inv.slips', 'view')) or (select public.has_perm('inv.reports', 'view'))))));

drop policy if exists trf_read on public.stock_transfers;
create policy trf_read on public.stock_transfers for select to authenticated
  using (public.inv_can_handle(from_warehouse_id) or public.inv_can_handle(to_warehouse_id) or ((select public.has_perm('inv.transfers', 'view')) or (select public.has_perm('inv.slips', 'view')) or (select public.has_perm('inv.reports', 'view'))));
drop policy if exists trf_items_read on public.stock_transfer_items;
create policy trf_items_read on public.stock_transfer_items for select to authenticated
  using (exists (select 1 from public.stock_transfers t where t.id = transfer_id
                  and (public.inv_can_handle(t.from_warehouse_id) or public.inv_can_handle(t.to_warehouse_id) or ((select public.has_perm('inv.transfers', 'view')) or (select public.has_perm('inv.slips', 'view')) or (select public.has_perm('inv.reports', 'view'))))));

-- Warehouses: everyone reads (as before); staff with Edit add / change them.
drop policy if exists warehouses_admin on public.warehouses;
drop policy if exists warehouses_staff_write on public.warehouses;
create policy warehouses_staff_write on public.warehouses for all to authenticated
  using ((select public.has_perm('inv.warehouses', 'edit'))) with check ((select public.has_perm('inv.warehouses', 'edit')));

-- Who keeps which warehouse: readable on the Warehouses page; assigning
-- stays with the Super Admin (Users & Roles).
drop policy if exists wh_keepers_read on public.warehouse_storekeepers;
create policy wh_keepers_read on public.warehouse_storekeepers for select to authenticated
  using (public.is_admin() or user_id = auth.uid() or (select public.has_perm('inv.warehouses', 'view')));

-- Projects are picked on receive / issue / return and grouped in reports.
drop policy if exists projects_read on public.projects;
create policy projects_read on public.projects for select to authenticated
  using (public.is_admin() or public.inv_is_storekeeper() or ((select public.has_perm('inv.receive', 'view')) or (select public.has_perm('inv.issue', 'view')) or (select public.has_perm('inv.returns', 'view')) or (select public.has_perm('inv.slips', 'view')) or (select public.has_perm('inv.reports', 'view')) or (select public.has_perm('ops.projects', 'view'))));
drop policy if exists pjo_read on public.project_job_orders;
create policy pjo_read on public.project_job_orders for select to authenticated
  using (public.is_admin() or public.inv_is_storekeeper() or ((select public.has_perm('inv.receive', 'view')) or (select public.has_perm('inv.issue', 'view')) or (select public.has_perm('inv.returns', 'view')) or (select public.has_perm('inv.slips', 'view')) or (select public.has_perm('inv.reports', 'view')) or (select public.has_perm('ops.projects', 'view'))));

-- Worker names (issue to / return from) and storekeeper names.
-- Who may read technician rows (names, photos) — one shared definition,
-- identical in every department migration (20260926_03, _05, _07, _08),
-- so re-running any of them, in any order, gives the same result.
create or replace function public.staff_sees_workers()
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select public.has_perm('inv.issue') or public.has_perm('inv.returns') or public.has_perm('inv.slips')
      or public.has_perm('inv.reports') or public.has_perm('inv.warehouses')
      or public.has_perm('hr.attendance') or public.has_perm('hr.leaves') or public.has_perm('hr.tech_profiles')
      or public.has_perm('ops.dispatch') or public.has_perm('ops.service_requests') or public.has_perm('ops.service_reports')
      or public.has_perm('ops.past_service') or public.has_perm('ops.tracker') or public.has_perm('ops.projects')
      or public.has_perm('tools.register') or public.has_perm('tools.issue') or public.has_perm('tools.return')
      or public.has_perm('tools.handover') or public.has_perm('tools.defects') or public.has_perm('tools.maintenance')
      or public.has_perm('tools.slips') or public.has_perm('tools.reports');
$$;
revoke execute on function public.staff_sees_workers() from public, anon;
grant execute on function public.staff_sees_workers() to authenticated, service_role;
drop policy if exists profiles_select_workers_for_staff on public.profiles;
create policy profiles_select_workers_for_staff on public.profiles for select to authenticated
  using (role = 'technician' and (select public.staff_sees_workers()));

commit;

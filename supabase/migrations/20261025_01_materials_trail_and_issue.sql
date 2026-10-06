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

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

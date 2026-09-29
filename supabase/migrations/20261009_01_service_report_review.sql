-- =====================================================================
-- Operations head review: job orders and service reports
--
-- Builds on the existing flow instead of adding a new one:
--   * A technician filing the last report completes the job order (as
--     before). Reviewing and CLOSING it is now the Operations head's
--     approval step: closing needs Dispatch › Approve (Super Admin always).
--     Staff with Dispatch › Edit still dispatch and manage job orders, but
--     can't close them.
--   * Closing a job order signs off every report filed against it
--     (reviewed_at / reviewed_by / reviewed_by_id) — the "closing signs off its own reports" rule.
--   * Filed reports no close will sign off (Record Past Service, a report
--     filed against a job order that's already closed, or with no job
--     order) wait on Service Reports › Needs Review; Service Reports ›
--     Approve signs them off one by one.
--   * Both show in the Inbox (jo_review, report_signoff) and "Needs you
--     now", overdue after 24h, escalating after 72h.
--   * Filed reports stay uneditable — nothing here reopens a report.
--     Customers see a report in their portal once it's signed off.
--   * Reports filed before this migration are treated as signed off,
--     except those on a job order still waiting to be closed.
--
-- Uses the sign-off columns the live database already has
-- (reviewed_at / reviewed_by / reviewed_by_id, from 20260919_03) and works
-- with guard_service_report_immutable, which lets exactly those columns be
-- recorded on a filed report. Safe to re-run.
-- =====================================================================
begin;

-- ---- 1. access ----------------------------------------------------------
update public.app_modules set approvable = true where key in ('ops.dispatch', 'ops.service_reports');

-- ---- 2. sign-off stamp on reports (already there on the live database) --
alter table public.service_reports
  add column if not exists reviewed_at    timestamptz,
  add column if not exists reviewed_by    text,
  add column if not exists reviewed_by_id uuid;

-- only the database sets it
create or replace function public.service_reports_signoff_guard()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      new.reviewed_at := null; new.reviewed_by := null; new.reviewed_by_id := null;
    else
      -- guard_service_report_immutable lets these change on a filed report;
      -- only the sign-off functions below may actually do it (a technician
      -- can't sign off their own report by writing to the table)
      new.reviewed_at := old.reviewed_at; new.reviewed_by := old.reviewed_by; new.reviewed_by_id := old.reviewed_by_id;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_service_reports_signoff_guard on public.service_reports;
create trigger trg_service_reports_signoff_guard before insert or update on public.service_reports
  for each row execute function public.service_reports_signoff_guard();

-- A filed, unsigned report that no job-order close will sign off
create or replace function public.service_report_needs_signoff(r public.service_reports)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select r.completed and r.reviewed_at is null
     and not exists (
       select 1 from public.dispatch_tickets t
        where t.status in ('open', 'preparing', 'acknowledged', 'in_progress', 'completed', 'scheduled')
          and r.sr_no is not null
          and t.data->'equipmentList' @> jsonb_build_array(jsonb_build_object('reportSrNo', r.sr_no)));
$$;

-- ---- 3. closing a job order: Operations head only; signs off its reports --
create or replace function public.dispatch_close_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status = 'closed' and old.status is distinct from 'closed'
     and not public.has_perm('ops.dispatch', 'approve') then
    raise exception 'Only the Operations head (Dispatch › Approve) can close a job order.' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_dispatch_close_guard on public.dispatch_tickets;
create trigger trg_dispatch_close_guard before update on public.dispatch_tickets
  for each row execute function public.dispatch_close_guard();

create or replace function public.dispatch_close_signoff()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare who uuid := coalesce(nullif(new.data->>'closedById', '')::uuid, auth.uid());
begin
  if new.status = 'closed' and old.status is distinct from 'closed' then
    update public.service_reports
       set reviewed_at = now(), reviewed_by_id = who,
           reviewed_by = coalesce(nullif(new.data->>'closedBy', ''), (select name from public.profiles where id = who), 'Operations')
     where reviewed_at is null and completed
       and sr_no in (select e->>'reportSrNo' from jsonb_array_elements(coalesce(new.data->'equipmentList', '[]'::jsonb)) e
                      where coalesce(e->>'reportSrNo', '') <> '');
  end if;
  return null;
exception when invalid_text_representation then
  return null;
end $$;
drop trigger if exists trg_dispatch_close_signoff on public.dispatch_tickets;
create trigger trg_dispatch_close_signoff after update on public.dispatch_tickets
  for each row execute function public.dispatch_close_signoff();

-- ---- 4. signing off one report (Needs Review) ----------------------------
create or replace function public.service_report_sign_off(p_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.service_reports;
begin
  if not public.has_perm('ops.service_reports', 'approve') then
    raise exception 'You need Service Reports › Approve to sign off reports.' using errcode = '42501';
  end if;
  select * into r from public.service_reports where id = p_id for update;
  if r.id is null then raise exception 'That service report no longer exists.'; end if;
  if not r.completed then raise exception 'This report hasn''t been filed yet.'; end if;
  if r.reviewed_at is not null then raise exception 'This report was already signed off by %.', coalesce(r.reviewed_by, 'someone'); end if;
  if not public.service_report_needs_signoff(r) then
    raise exception 'This report belongs to a job order that isn''t closed yet — it''s signed off when the job order is closed.';
  end if;
  if r.technician_id = auth.uid() and not public.is_admin() then raise exception 'You can''t sign off your own report.'; end if;
  update public.service_reports set reviewed_at = now(), reviewed_by_id = auth.uid(),
         reviewed_by = coalesce((select name from public.profiles where id = auth.uid()), 'Operations')
   where id = p_id;
  perform public.log_activity_as(auth.uid(), 'sign_off', 'service_reports', p_id::text, coalesce(r.sr_no, '') || ' ' || coalesce(r.cust_name, ''), '{}'::jsonb);
end $$;

-- ids for the Needs Review tab
create or replace function public.service_reports_to_sign_off()
returns setof uuid language sql stable security definer set search_path = public, pg_temp as $$
  select r.id from public.service_reports r
   where public.service_report_needs_signoff(r)
     and (public.has_perm('ops.service_reports', 'view') or public.has_perm('adm.customers', 'view'));
$$;

revoke execute on function public.service_report_sign_off(uuid), public.service_reports_to_sign_off(),
  public.service_report_needs_signoff(public.service_reports) from public, anon;
grant execute on function public.service_report_sign_off(uuid), public.service_reports_to_sign_off(),
  public.service_report_needs_signoff(public.service_reports) to authenticated;
revoke execute on function public.service_reports_signoff_guard(), public.dispatch_close_guard(), public.dispatch_close_signoff()
  from public, anon, authenticated;

-- ---- 5. reports filed before this migration --------------------------------
update public.service_reports r set reviewed_at = coalesce(r.created_at, now()), reviewed_by = 'Before sign-off'
 where r.completed and r.reviewed_at is null
   and not exists (select 1 from public.dispatch_tickets t
                    where t.status in ('open', 'preparing', 'acknowledged', 'in_progress', 'completed', 'scheduled')
                      and r.sr_no is not null
                      and t.data->'equipmentList' @> jsonb_build_array(jsonb_build_object('reportSrNo', r.sr_no)));

-- ---- 6. customers see signed-off reports -----------------------------------
drop policy if exists "customers read own reports" on public.service_reports;
create policy "customers read own reports" on public.service_reports for select to authenticated
  using (customer_id in (select l.customer_id from public.customer_login_links l where l.profile_id = auth.uid())
         and reviewed_at is not null);

-- ---- 7. Inbox --------------------------------------------------------------
insert into public.inbox_sla (kind, label, department, module, level, warn_hours, escalate_hours, active, sort) values
  ('jo_review',      'Job order to review and close', 'operations', 'ops.dispatch',        'approve', 24, 72, true, 48),
  ('report_signoff', 'Service report to sign off',     'operations', 'ops.service_reports', 'approve', 24, 72, true, 49)
on conflict (kind) do update set label = excluded.label, module = excluded.module, level = excluded.level;

CREATE OR REPLACE FUNCTION public.inbox_all_items()
 RETURNS TABLE(kind text, ref_id text, ref_label text, title text, since timestamp with time zone, owner uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
     and ((e.request_kind = 'leave' and l.status = 'pending') or (e.request_kind = 'cash' and c.status = 'pending'))
  -- Operations (20261009_01): completed job orders for the Operations head to review and close
  union all
  select 'jo_review', t.id, coalesce(nullif(t.data->>'jobOrderNo', ''), t.id),
         coalesce(nullif(t.data->>'custName', ''), 'Job order') || ' — all units reported',
         coalesce(nullif(t.data->>'completedAt', '')::timestamptz, t.created_at), null::uuid
    from public.dispatch_tickets t where t.status = 'completed'
  -- … and filed reports that no job order close will sign off
  union all
  select 'report_signoff', r.id::text, coalesce(r.sr_no, ''),
         coalesce(nullif(r.cust_name, ''), 'Service report') || ' — ' || coalesce(nullif(r.technician_name, ''), 'technician'),
         r.created_at, r.technician_id
    from public.service_reports r where public.service_report_needs_signoff(r);
$function$;

commit;

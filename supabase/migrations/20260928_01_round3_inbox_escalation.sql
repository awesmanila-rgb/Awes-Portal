-- =====================================================================
-- AWES App — Round 3: cross-department inbox with overdue escalation
--
-- THE INBOX
--   Work already has a state in the data — a requisition "submitted", a PO
--   "draft", an advance "approved, cash not given", a liquidation
--   "pending"… inbox_all_items() reads those states directly (nothing new
--   to keep up to date by hand) and says which page, at which level, has
--   to act next. inbox_items() returns the ones the caller can act on,
--   each with how long it has been waiting and whether it is:
--     waiting    within its response time
--     overdue    past warn_hours      (highlighted for everyone who can act)
--     escalated  past escalate_hours  (the department's Heads are notified;
--                                      at twice that, the Super Admin)
--
-- RESPONSE TIMES
--   inbox_sla — one row per kind of item, editable by the Super Admin
--   (inbox_sla_save). Defaults are seeded below.
--
-- ESCALATION
--   inbox_escalations_due() lists notifications that are due and not yet
--   sent (service role — called by the inbox-escalations Edge Function
--   every 15 minutes); inbox_mark_sent() records them in
--   inbox_escalation_log so each is sent exactly once (same approach as
--   admin_alert_log).
--
-- STAFF PUSH
--   push_subscriptions may now hold role 'staff' (Round 1 kept staff
--   devices from registering until notifications existed for them).
--
-- Requires 20260926_01 … _08 and 20260927_01. Idempotent.
-- =====================================================================

begin;

do $$ begin
  if to_regprocedure('public.manila_today()') is null then
    raise exception 'Run 20260927_01_round2_templates_delegation_dashboards.sql first.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. Response times
-- ---------------------------------------------------------------------
create table if not exists public.inbox_sla (
  kind            text primary key,
  label           text not null,
  department      text not null references public.departments(id),
  module          text not null references public.app_modules(key),
  level           text not null check (level in ('view', 'edit', 'approve')),
  warn_hours      numeric not null check (warn_hours >= 0),
  escalate_hours  numeric not null check (escalate_hours >= warn_hours),
  active          boolean not null default true,
  sort            int not null default 0
);

insert into public.inbox_sla (kind, label, department, module, level, warn_hours, escalate_hours, sort) values
  ('mr_review',    'Requisition to review',                'purchasing',     'pur.requisitions',     'approve',  24,  48, 10),
  ('mr_fulfil',    'Approved requisition to fulfil',       'purchasing',     'pur.requisitions',     'edit',     48,  96, 11),
  ('po_draft',     'Draft PO to issue',                    'purchasing',     'pur.purchase_orders',  'approve',  24,  72, 12),
  ('po_receive',   'Issued PO not yet received',           'purchasing',     'inv.receive',          'edit',    168, 336, 13),
  ('ca_approve',   'Cash advance to approve',              'finance',        'fin.cash_advance',     'approve',   8,  24, 20),
  ('ca_release',   'Approved advance — cash not given',    'finance',        'fin.cash_advance',     'edit',     24,  48, 21),
  ('liq_submit',   'Advance not yet liquidated',           'finance',        'fin.liquidation',      'edit',    168, 336, 22),
  ('liq_review',   'Liquidation to review',                'finance',        'fin.liquidation',      'approve',  24,  72, 23),
  ('liq_settle',   'Liquidation balance to settle',        'finance',        'fin.liquidation',      'edit',     72, 168, 24),
  ('rb_approve',   'Reimbursement to approve',             'finance',        'fin.reimbursement',    'approve',  24,  72, 25),
  ('rb_pay',       'Approved reimbursement to pay',        'finance',        'fin.reimbursement',    'edit',     48,  96, 26),
  ('leave_decide', 'Leave request to decide',              'hr',             'hr.leaves',            'approve',  24,  48, 30),
  ('sr_new',       'New service request',                  'operations',     'ops.service_requests', 'edit',      2,   8, 50),
  ('jo_late',      'Job order past its date',              'operations',     'ops.dispatch',         'edit',      0,  24, 51),
  ('tool_defect',  'Tool defect to decide',                'operations',     'tools.defects',        'edit',     48, 120, 52)
on conflict (kind) do update set label = excluded.label, department = excluded.department,
  module = excluded.module, level = excluded.level, sort = excluded.sort;
  -- (warn / escalate hours and "active" are yours — re-running keeps them)

alter table public.inbox_sla enable row level security;
drop policy if exists inbox_sla_read on public.inbox_sla;
create policy inbox_sla_read on public.inbox_sla for select to authenticated using (public.is_admin() or public.is_staff());
revoke all on public.inbox_sla from anon;
grant select on public.inbox_sla to authenticated;
revoke insert, update, delete on public.inbox_sla from authenticated;

create table if not exists public.inbox_escalation_log (
  key         text primary key,        -- <kind>:<ref id>:L<level>
  kind        text not null,
  ref_id      text not null,
  level       smallint not null,
  recipients  uuid[] not null default '{}',
  sent_at     timestamptz not null default now()
);
alter table public.inbox_escalation_log enable row level security;
revoke all on public.inbox_escalation_log from anon, authenticated;
create index if not exists inbox_escalation_log_sent_idx on public.inbox_escalation_log (sent_at);

-- ---------------------------------------------------------------------
-- 2. Every open work item (no permission filter — internal)
-- ---------------------------------------------------------------------
-- owner: who created / asked for it. Nobody may approve their own
-- record, so approval items never wait on their own owner.
drop function if exists public.inbox_items_with_state();
drop function if exists public.inbox_all_items();
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
    from public.cash_advance_requests c where c.status = 'pending' and public.cash_module(c.data) = 'fin.cash_advance'
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
    from public.cash_advance_requests c where c.status = 'pending' and public.cash_module(c.data) = 'fin.reimbursement'
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
    from public.leave_requests l where l.status = 'pending'
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
    from public.tool_defects d where d.status = 'open';
$$;

-- Items with their response times and state
create or replace function public.inbox_items_with_state()
returns table (kind text, ref_id text, ref_label text, title text, since timestamptz, owner uuid,
               label text, department text, module text, level text,
               warn_hours numeric, escalate_hours numeric, age_hours numeric, state text)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select i.kind, i.ref_id, i.ref_label, i.title, i.since, i.owner, s.label, s.department, s.module, s.level,
         s.warn_hours, s.escalate_hours,
         round(extract(epoch from (now() - coalesce(i.since, now()))) / 3600.0, 1) as age_hours,
         case when extract(epoch from (now() - coalesce(i.since, now()))) / 3600.0 >= s.escalate_hours then 'escalated'
              when extract(epoch from (now() - coalesce(i.since, now()))) / 3600.0 >= s.warn_hours then 'overdue'
              else 'waiting' end as state
    from public.inbox_all_items() i
    join public.inbox_sla s on s.kind = i.kind and s.active;
$$;

-- The caller's inbox: items on pages they can act on (at that level).
-- Heads also see their department's escalated items, even on a page they
-- only view.
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
      or public.has_perm(x.module, x.level)
      or (x.state = 'escalated' and public.has_perm(x.module, 'view')
          and exists (select 1 from public.staff_departments d where d.user_id = auth.uid() and d.department_id = x.department and d.is_head)));
$$;

-- ---------------------------------------------------------------------
-- 3. Escalation (service role)
-- ---------------------------------------------------------------------
-- Level 1 at escalate_hours → the department's active Heads who can see
-- that page (or the Super Admin if there are none). Level 2 at twice
-- escalate_hours → the Super Admin.
create or replace function public.inbox_escalations_due()
returns table (key text, kind text, ref_id text, ref_label text, title text, label text, level smallint,
               age_hours numeric, module text, recipients uuid[])
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare r record; heads uuid[]; admins uuid[];
begin
  select coalesce(array_agg(id), '{}') into admins from public.profiles where role = 'admin' and active;
  for r in select * from public.inbox_items_with_state() x where x.state = 'escalated' loop
    -- level 2
    if r.age_hours >= 2 * greatest(r.escalate_hours, 0.5)
       and not exists (select 1 from public.inbox_escalation_log l where l.key = r.kind || ':' || r.ref_id || ':L2') then
      key := r.kind || ':' || r.ref_id || ':L2'; kind := r.kind; ref_id := r.ref_id; ref_label := r.ref_label; title := r.title;
      label := r.label; level := 2; age_hours := r.age_hours; module := r.module; recipients := admins;
      return next;
    end if;
    -- level 1
    if not exists (select 1 from public.inbox_escalation_log l where l.key = r.kind || ':' || r.ref_id || ':L1') then
      select coalesce(array_agg(distinct d.user_id), '{}') into heads
        from public.staff_departments d
        join public.staff_access a on a.user_id = d.user_id and a.module_key = r.module and (a.expires_at is null or a.expires_at > now())
       where d.department_id = r.department and d.is_head and public.staff_is_active(d.user_id)
         and d.user_id is distinct from r.owner;   -- not their own request
      key := r.kind || ':' || r.ref_id || ':L1'; kind := r.kind; ref_id := r.ref_id; ref_label := r.ref_label; title := r.title;
      label := r.label; level := 1; age_hours := r.age_hours; module := r.module;
      recipients := case when cardinality(heads) > 0 then heads else admins end;
      return next;
    end if;
  end loop;
end;
$$;

create or replace function public.inbox_mark_sent(p_rows jsonb)
returns integer
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare r jsonb; n int := 0;
begin
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    insert into public.inbox_escalation_log (key, kind, ref_id, level, recipients)
    values (r->>'key', r->>'kind', r->>'ref_id', (r->>'level')::smallint,
            coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(r->'recipients') x), '{}'))
    on conflict (key) do nothing;
    if found then n := n + 1; end if;
  end loop;
  delete from public.inbox_escalation_log where sent_at < now() - interval '60 days';
  return n;
end;
$$;

-- Super Admin: change a kind's response times / switch it off
create or replace function public.inbox_sla_save(p_kind text, p_warn numeric, p_escalate numeric, p_active boolean)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then raise exception 'Only the Super Admin changes response times.' using errcode = '42501'; end if;
  if p_warn is null or p_escalate is null or p_warn < 0 or p_escalate < p_warn then
    raise exception 'Escalation time must be at least the overdue time.' using errcode = 'P0001';
  end if;
  update public.inbox_sla set warn_hours = p_warn, escalate_hours = p_escalate, active = coalesce(p_active, true) where kind = p_kind;
  if not found then raise exception 'Unknown item type.' using errcode = 'P0001'; end if;
  perform public.log_activity_as(auth.uid(), 'inbox.sla', 'inbox_sla', p_kind, p_kind,
    jsonb_build_object('warn_hours', p_warn, 'escalate_hours', p_escalate, 'active', p_active));
end;
$$;

-- ---------------------------------------------------------------------
-- 4. Staff devices may register for push
-- ---------------------------------------------------------------------
do $$ begin
  if to_regclass('public.push_subscriptions') is not null then
    alter table public.push_subscriptions drop constraint if exists push_subscriptions_role_check;
    alter table public.push_subscriptions add constraint push_subscriptions_role_check
      check (role = any (array['admin', 'tech', 'customer', 'staff']));
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
revoke execute on function public.inbox_all_items(), public.inbox_items_with_state(),
  public.inbox_escalations_due(), public.inbox_mark_sent(jsonb) from public, anon, authenticated;
grant execute on function public.inbox_all_items(), public.inbox_items_with_state(),
  public.inbox_escalations_due(), public.inbox_mark_sent(jsonb) to service_role;
revoke execute on function public.inbox_items(), public.inbox_sla_save(text, numeric, numeric, boolean) from public, anon;
grant execute on function public.inbox_items(), public.inbox_sla_save(text, numeric, numeric, boolean) to authenticated, service_role;

commit;

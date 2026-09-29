-- =====================================================================
-- Alerts for every action that's waiting on someone
--
-- The cross-department Inbox (20260928_01) is the one list of "work
-- waiting on you", per account, by access. This fills its gaps and makes
-- sure every item also pushes a notification when it first appears:
--
--   New Inbox items
--     jo_overdue       job order past its day, still En Route / In Progress   ops.dispatch › Edit
--     jo_unassigned    job order with nobody assigned                        ops.dispatch › Edit
--     sr_cancel        customer asked to cancel a service                     ops.service_requests › Edit
--     sr_next          service request waiting on the office (fee / schedule
--                      / job order to create, or the customer declined a fee) ops.service_requests › Edit
--     ts_lock          pay period ended, timesheets not locked                hr.timesheets › Edit
--     pay_start        timesheets locked, no pay run yet                      hr.payroll_runs › Edit
--     pay_compute      pay run in draft / computed, not submitted             hr.payroll_runs › Edit
--     pay_approve      pay run waiting for approval                           fin.payroll_approve › Approve
--     pay_release      approved pay run not released yet                      fin.payroll_approve › Edit
--     rule_publish     payroll rule draft waiting to be published             fin.payroll_rules › Approve
--     tool_overdue     issued tool past its return date                       tools.return › Edit
--     tool_maint       calibration / inspection due within 7 days             tools.maintenance › Edit
--
--   "New item" push (level 0): the next inbox-escalations run (every 15
--   min) notifies everyone whose Inbox the item lands in — once per item,
--   never the person who raised it. Items already waiting when this runs
--   are marked as announced, so there's no backlog blast.
--   The existing overdue (level 1, Heads) and still-waiting (level 2,
--   Super Admin) pushes are unchanged.
--
-- inbox_all_items is extended in place, so anything else already in it on
-- the live database is kept. Safe to re-run.
-- Redeploy the inbox-escalations Edge Function afterwards (new wording for
-- "new item" pushes).
-- =====================================================================
begin;

-- ---- 1. new kinds ------------------------------------------------------------
do $$
declare def text; body text; extra text;
begin
  def := pg_get_functiondef('public.inbox_all_items'::regproc);
  if position('jo_overdue' in def) > 0 then return; end if;          -- already extended
  -- \r too: a function saved from the Supabase SQL editor on Windows keeps
  -- CRLF line endings, and a leftover ";\r" broke the appended union.
  def := rtrim(def, E' \n\t\r');
  if right(def, 10) <> '$function$' then raise exception 'Unexpected inbox_all_items definition.'; end if;
  body := rtrim(left(def, length(def) - 10), E' \n\t\r;');
  if right(body, 1) = ';' then raise exception 'Unexpected end of inbox_all_items: %', right(body, 40); end if;
  extra := $x$
  -- 20261011_01: every waiting action has an Inbox item
  union all
  select 'jo_overdue', t.id, coalesce(nullif(t.data->>'jobOrderNo', ''), t.id),
         coalesce(nullif(t.data->>'custName', ''), 'Job order') || ' — ' ||
           case when t.status = 'in_progress' then 'still in progress' else 'crew never arrived' end || ', scheduled ' || (t.data->>'date'),
         (nullif(t.data->>'date', '')::date + 1)::timestamptz, null::uuid
    from public.dispatch_tickets t
   where t.status in ('acknowledged', 'in_progress') and nullif(t.data->>'date', '')::date < public.manila_today()
  union all
  select 'jo_unassigned', t.id, coalesce(nullif(t.data->>'jobOrderNo', ''), t.id),
         coalesce(nullif(t.data->>'custName', ''), 'Job order') || ' — scheduled ' || coalesce(t.data->>'date', '?') || ', nobody assigned',
         t.created_at, null::uuid
    from public.dispatch_tickets t
   where t.status in ('open', 'preparing', 'scheduled')
     and jsonb_array_length(coalesce(t.data->'assignedWorkerIds', '[]'::jsonb)) = 0
     and coalesce(nullif(t.data->>'date', '')::date, public.manila_today()) >= public.manila_today()
  union all
  select 'sr_cancel', r.id::text, left(r.description, 60),
         coalesce((select name from public.customers where id = r.customer_id), 'Customer') || ' asked to cancel' ||
           coalesce(': ' || nullif(r.cancel_requested_reason, ''), ''),
         coalesce(r.cancel_requested_at, r.created_at), null::uuid
    from public.service_requests r
   where r.cancel_requested and not coalesce(r.cancel_acknowledged, false) and r.status not in ('cancelled', 'closed', 'completed')
  union all
  select 'sr_next', r.id::text, left(r.description, 60),
         coalesce((select name from public.customers where id = r.customer_id), 'Customer') || ' — ' ||
           case when r.fee_status = 'declined' then 'declined the fee'
                when r.status = 'acknowledged' then 'propose the fee'
                when r.status = 'fee_accepted' then 'fee accepted, propose a schedule'
                else 'schedule confirmed, create the job order' end,
         coalesce(r.schedule_confirmed_at, r.created_at), null::uuid
    from public.service_requests r
   where not coalesce(r.cancel_requested, false)
     and (r.fee_status = 'declined' and r.status = 'fee_proposed'
          or r.status in ('acknowledged', 'fee_accepted')
          or (r.status = 'schedule_confirmed' and r.linked_dispatch_ticket_id is null))
  union all
  select 'ts_lock', p.id::text, p.label, 'Pay period ended ' || to_char(p.period_end, 'Mon DD') || ' — build, review and lock the timesheets',
         (p.period_end + 1)::timestamptz, null::uuid
    from public.payroll_periods p where p.status = 'open' and p.period_end < public.manila_today()
  union all
  select 'pay_start', p.id::text, p.label, 'Timesheets locked — start the pay run (pay date ' || to_char(p.pay_date, 'Mon DD') || ')',
         coalesce(p.locked_at, now()), null::uuid
    from public.payroll_periods p
   where p.status = 'locked' and not exists (select 1 from public.payroll_runs r where r.period_id = p.id)
  union all
  select 'pay_compute', r.id::text, p.label,
         case when r.status = 'computed' then 'Computed — check it and submit for approval' else 'Pay run started — compute it' end ||
           case when r.sent_back_note <> '' then ' (sent back: ' || left(r.sent_back_note, 60) || ')' else '' end,
         coalesce(r.computed_at, r.created_at), null::uuid
    from public.payroll_runs r join public.payroll_periods p on p.id = r.period_id where r.status in ('draft', 'computed')
  union all
  select 'pay_approve', r.id::text, p.label, r.headcount || ' people · net pay ₱' || to_char(r.total_net, 'FM999,999,990.00'),
         r.submitted_at, r.computed_by
    from public.payroll_runs r join public.payroll_periods p on p.id = r.period_id where r.status = 'submitted'
  union all
  select 'pay_release', r.id::text, p.label, 'Approved — release once salaries are paid (pay date ' || to_char(p.pay_date, 'Mon DD') || ')',
         r.approved_at, null::uuid
    from public.payroll_runs r join public.payroll_periods p on p.id = r.period_id where r.status = 'approved'
  union all
  select 'rule_publish', x.id::text, upper(x.kind), 'Draft from ' || to_char(x.effective_from, 'Mon DD, YYYY') || ' waiting to be published',
         x.updated_at, x.created_by
    from public.payroll_rules x where x.published_at is null
  union all
  select 'tool_overdue', t.id::text, coalesce(t.asset_tag, ''),
         coalesce(t.name, 'Tool') || ' — with ' || coalesce(nullif(t.holder_name, ''), 'a worker') || ', due back ' || to_char(t.due_back, 'Mon DD'),
         (t.due_back + 1)::timestamptz, null::uuid
    from public.tools t where t.status = 'issued' and t.due_back < public.manila_today()
  union all
  select 'tool_maint', t.id::text, coalesce(t.asset_tag, ''),
         coalesce(t.name, 'Tool') || ' — calibration / inspection due ' || to_char(t.next_maint_due, 'Mon DD'),
         (t.next_maint_due - 7)::timestamptz, null::uuid
    from public.tools t where t.status not in ('retired', 'lost') and t.next_maint_due <= public.manila_today() + 7$x$;
  execute body || extra || E';\n$function$';
end $$;

insert into public.inbox_sla (kind, label, department, module, level, warn_hours, escalate_hours, active, sort) values
  ('jo_overdue',    'Job order overdue',                       'operations',  'ops.dispatch',         'edit',     0,  24, true, 53),
  ('jo_unassigned', 'Job order with nobody assigned',          'operations',  'ops.dispatch',         'edit',     4,  24, true, 54),
  ('sr_cancel',     'Customer asked to cancel',                'operations',  'ops.service_requests', 'edit',     2,   8, true, 55),
  ('sr_next',       'Service request — your next step',        'operations',  'ops.service_requests', 'edit',     8,  24, true, 56),
  ('ts_lock',       'Timesheets to lock',                      'hr',          'hr.timesheets',        'edit',    24,  72, true, 31),
  ('pay_start',     'Pay run to start',                        'hr',          'hr.payroll_runs',      'edit',    24,  48, true, 32),
  ('pay_compute',   'Pay run to compute / submit',             'hr',          'hr.payroll_runs',      'edit',    24,  48, true, 33),
  ('pay_approve',   'Pay run to approve',                      'finance',     'fin.payroll_approve',  'approve', 24,  48, true, 28),
  ('pay_release',   'Approved pay run to release',             'finance',     'fin.payroll_approve',  'edit',    24,  72, true, 29),
  ('rule_publish',  'Payroll rule to publish',                 'finance',     'fin.payroll_rules',    'approve', 72, 168, true, 30),
  ('tool_overdue',  'Tool not returned',                       'operations',  'tools.return',         'edit',    24,  72, true, 57),
  ('tool_maint',    'Tool calibration / inspection due',       'operations',  'tools.maintenance',    'edit',    72, 168, true, 58)
on conflict (kind) do update set label = excluded.label, department = excluded.department, module = excluded.module, level = excluded.level;

-- ---- 2. "new item" push to whoever it's waiting on ------------------------------
create or replace function public.inbox_escalations_due()
returns table (key text, kind text, ref_id text, ref_label text, title text, label text, level smallint, age_hours numeric, module text, recipients uuid[])
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r record; heads uuid[]; admins uuid[]; who uuid[];
begin
  select coalesce(array_agg(id), '{}') into admins from public.profiles where role = 'admin' and active;

  -- level 0: new item → everyone whose Inbox it lands in, once. (Items already
  -- waiting when 20261011_01 ran were pre-logged; the 50-day cap keeps the
  -- 60-day log clean-up from re-announcing very old items.)
  for r in select * from public.inbox_items_with_state() x where x.age_hours < 24 * 50 loop
    if not exists (select 1 from public.inbox_escalation_log l where l.key = r.kind || ':' || r.ref_id || ':L0') then
      if r.kind like '%\_endorse' escape '\' then
        select coalesce(array_agg(p.supervisor_id), '{}') into who from public.profiles p
         where p.id = r.owner and p.supervisor_id is not null and public.staff_is_active(p.supervisor_id);
      else
        select coalesce(array_agg(distinct a.user_id), '{}') into who
          from public.staff_access a
         where a.module_key = r.module and a.level >= coalesce(public.perm_rank(r.level), 1)
           and (a.expires_at is null or a.expires_at > now()) and public.staff_is_active(a.user_id)
           and a.user_id is distinct from r.owner
           and not (r.kind in ('leave_decide', 'ca_approve', 'rb_approve', 'liq_review') and public.staff_is_head(r.owner));
      end if;
      key := r.kind || ':' || r.ref_id || ':L0'; kind := r.kind; ref_id := r.ref_id; ref_label := r.ref_label; title := r.title;
      label := r.label; level := 0; age_hours := r.age_hours; module := r.module; recipients := who;
      return next;   -- logged even with no recipients, so it's never re-sent
    end if;
  end loop;

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
      recipients := case when r.kind in ('leave_decide', 'ca_approve', 'rb_approve', 'liq_review') and public.staff_is_head(r.owner) then admins
                         when cardinality(heads) > 0 then heads else admins end;
      return next;
    end if;
  end loop;
end;
$$;

-- Items that already exist when this runs are marked as announced, so turning
-- this on doesn't push a backlog to everyone at once.
insert into public.inbox_escalation_log (key, kind, ref_id, level)
select x.kind || ':' || x.ref_id || ':L0', x.kind, x.ref_id, 0 from public.inbox_items_with_state() x
on conflict do nothing;

commit;

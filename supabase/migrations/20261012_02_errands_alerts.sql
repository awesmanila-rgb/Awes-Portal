-- =====================================================================
-- Errands — Inbox items and alerts (builds on 20261012_01_errands.sql)
--
--   errand_todo      to the assigned messenger only (their own errands)   personal
--   errand_request   another department asked for an errand               adm.errands › Approve
--   errand_unassigned approved / created but no messenger yet             adm.errands › Edit
--   errand_overdue   past its due time and not done — alerts the          adm.errands › Edit
--                    Administration Head AND the Super Admin immediately
--   errand_failed    messenger couldn't complete it — reschedule / cancel adm.errands › Edit
--   errand_review    done — review and close                              adm.errands › Approve
--   errand_copy      handed over but the stamped copy isn't back yet      adm.errands › Edit
--
-- Each new item is pushed once (inbox-escalations, every 15 min); the app
-- also pushes the moment an errand is assigned, replaced, cancelled or
-- finished. inbox_all_items / inbox_items are extended in place.
-- Safe to re-run.
-- =====================================================================
begin;

-- ---- 1. Inbox items -----------------------------------------------------------
do $$
declare def text; body text; extra text;
begin
  def := replace(pg_get_functiondef('public.inbox_all_items'::regproc), E'\r', '');
  if position('errand_todo' in def) = 0 then
    def := rtrim(def, E' \n\t');
    if right(def, 10) <> '$function$' then raise exception 'Unexpected inbox_all_items definition.'; end if;
    body := rtrim(left(def, length(def) - 10), E' \n\t;');
    extra := $x$
  -- 20261012_02: errands
  union all
  select 'errand_todo', e.id::text || '-' || e.seq, e.errand_no,
         e.title || coalesce(' — due ' || to_char(e.due_at at time zone 'Asia/Manila', 'Mon DD, HH12:MI AM'), ''),
         coalesce(e.assigned_at, e.created_at), e.assigned_to
    from public.errands e where e.status in ('assigned', 'in_progress')
  union all
  select 'errand_overdue', e.id::text || '-' || e.seq, e.errand_no,
         e.title || ' — ' || coalesce('with ' || e.assigned_name, 'nobody assigned') || ', was due ' || to_char(e.due_at at time zone 'Asia/Manila', 'Mon DD, HH12:MI AM'),
         e.due_at, null::uuid
    from public.errands e where e.status in ('open', 'assigned', 'in_progress') and e.due_at is not null and e.due_at < now()
  union all
  select 'errand_request', e.id::text, e.errand_no,
         e.title || ' — from ' || coalesce(e.requested_by_name, 'staff') || coalesce(' (' || e.requested_department || ')', ''),
         coalesce(e.requested_at, e.created_at), e.requested_by
    from public.errands e where e.status = 'requested'
  union all
  select 'errand_unassigned', e.id::text || '-' || e.seq, e.errand_no,
         e.title || coalesce(' — due ' || to_char(e.due_at at time zone 'Asia/Manila', 'Mon DD, HH12:MI AM'), '') || ', no messenger yet',
         coalesce(e.approved_at, e.created_at), null::uuid
    from public.errands e where e.status = 'open'
  union all
  select 'errand_failed', e.id::text || '-' || e.seq, e.errand_no,
         e.title || ' — ' || coalesce(e.assigned_name, 'messenger') || ': ' || left(e.failed_reason, 80),
         coalesce(e.failed_at, e.updated_at), null::uuid
    from public.errands e where e.status = 'failed'
  union all
  select 'errand_review', e.id::text, e.errand_no,
         e.title || ' — done by ' || coalesce(e.assigned_name, 'messenger'),
         coalesce(e.completed_at, e.updated_at), null::uuid
    from public.errands e where e.status = 'done'
  union all
  select 'errand_copy', t.errand_id::text, t.transmittal_no,
         coalesce((select title from public.errands where id = t.errand_id), 'Errand') || ' — stamped copy not back yet',
         t.delivered_at, null::uuid
    from public.errand_transmittals t join public.errands e on e.id = t.errand_id
   where e.copy_expected and t.office_received_at is null and e.status <> 'cancelled'$x$;
    execute body || extra || E';\n$function$';
  end if;
end $$;

-- ---- 2. A messenger sees their own errand items (personal) ----------------------
do $$
declare def text;
begin
  def := replace(pg_get_functiondef('public.inbox_items'::regproc), E'\r', '');
  if position('errand_todo' in def) > 0 then return; end if;
  if position('   where (x.owner is null' in def) = 0 or position(E'is_head)));\n$function$' in def) = 0 then
    raise exception 'inbox_items has changed since this migration was written — send the AWES developer its current definition.';
  end if;
  def := replace(def, '   where (x.owner is null', E'   where (x.kind = ''errand_todo'' and x.owner = auth.uid())\n      or (x.kind <> ''errand_todo'' and (x.owner is null');
  def := replace(def, E'is_head)));\n$function$', E'is_head))));\n$function$');
  execute def;
end $$;

insert into public.inbox_sla (kind, label, department, module, level, warn_hours, escalate_hours, active, sort) values
  ('errand_todo',       'Errand assigned to you',         'administration', 'adm.my_errands', 'view',    9999, 99999, true, 60),
  ('errand_overdue',    'Errand overdue',                 'administration', 'adm.errands',    'edit',       0,     0, true, 61),
  ('errand_request',    'Errand request to approve',      'administration', 'adm.errands',    'approve',    4,    24, true, 62),
  ('errand_unassigned', 'Errand with no messenger',       'administration', 'adm.errands',    'edit',       2,     8, true, 63),
  ('errand_failed',     'Errand couldn''t be completed',  'administration', 'adm.errands',    'edit',       1,     8, true, 64),
  ('errand_review',     'Errand to review and close',     'administration', 'adm.errands',    'approve',   12,    48, true, 65),
  ('errand_copy',       'Stamped copy not returned',      'administration', 'adm.errands',    'edit',      24,    72, true, 66)
on conflict (kind) do update set label = excluded.label, department = excluded.department, module = excluded.module, level = excluded.level,
  warn_hours = excluded.warn_hours, escalate_hours = excluded.escalate_hours;

-- ---- 3. Push recipients ---------------------------------------------------------------
create or replace function public.inbox_escalations_due()
returns table (key text, kind text, ref_id text, ref_label text, title text, label text, level smallint, age_hours numeric, module text, recipients uuid[])
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r record; heads uuid[]; admins uuid[]; who uuid[];
begin
  select coalesce(array_agg(id), '{}') into admins from public.profiles where role = 'admin' and active;

  -- level 0: a new item → everyone whose Inbox it lands in, once
  for r in select * from public.inbox_items_with_state() x where x.age_hours < 24 * 50 loop
    if not exists (select 1 from public.inbox_escalation_log l where l.key = r.kind || ':' || r.ref_id || ':L0') then
      if r.kind = 'errand_todo' then
        who := case when r.owner is not null and public.staff_is_active(r.owner) then array[r.owner] else '{}'::uuid[] end;   -- only the messenger
      elsif r.kind like '%\_endorse' escape '\' then
        select coalesce(array_agg(p.supervisor_id), '{}') into who from public.profiles p
         where p.id = r.owner and p.supervisor_id is not null and public.staff_is_active(p.supervisor_id);
      else
        select coalesce(array_agg(distinct a.user_id), '{}') into who
          from public.staff_access a
         where a.module_key = r.module and a.level >= coalesce(public.perm_rank(r.level), 1)
           and (a.expires_at is null or a.expires_at > now()) and public.staff_is_active(a.user_id)
           and a.user_id is distinct from r.owner
           and not (r.kind in ('leave_decide', 'ca_approve', 'rb_approve', 'liq_review') and public.staff_is_head(r.owner));
        if r.kind in ('errand_overdue', 'errand_failed') then who := who || admins; end if;   -- the Super Admin too
      end if;
      key := r.kind || ':' || r.ref_id || ':L0'; kind := r.kind; ref_id := r.ref_id; ref_label := r.ref_label; title := r.title;
      label := r.label; level := 0; age_hours := r.age_hours; module := r.module; recipients := who;
      return next;
    end if;
  end loop;

  for r in select * from public.inbox_items_with_state() x where x.state = 'escalated' and x.kind <> 'errand_todo' loop
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
         and d.user_id is distinct from r.owner;
      key := r.kind || ':' || r.ref_id || ':L1'; kind := r.kind; ref_id := r.ref_id; ref_label := r.ref_label; title := r.title;
      label := r.label; level := 1; age_hours := r.age_hours; module := r.module;
      recipients := case when r.kind in ('leave_decide', 'ca_approve', 'rb_approve', 'liq_review') and public.staff_is_head(r.owner) then admins
                         when r.kind = 'errand_overdue' then heads || admins    -- Head and Super Admin, as soon as it's overdue
                         when cardinality(heads) > 0 then heads else admins end;
      return next;
    end if;
  end loop;
end;
$$;

-- items already waiting are treated as announced (no push backlog)
insert into public.inbox_escalation_log (key, kind, ref_id, level)
select x.kind || ':' || x.ref_id || ':L0', x.kind, x.ref_id, 0 from public.inbox_items_with_state() x
on conflict do nothing;

commit;

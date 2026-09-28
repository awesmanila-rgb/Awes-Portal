-- =====================================================================
-- AWES App — Open OPERATIONS (part 1) to department staff (Phase 3f)
--
-- Pages opened:
--   Dispatch / Job Orders  ops.dispatch        View: every job order and its
--                                               chat. Edit: create, assign and
--                                               reassign technicians, review,
--                                               close, cancel, chat.
--   Service Requests       ops.service_requests View: customers' requests and
--                                               their messages. Edit: log a
--                                               request for a customer, reply,
--                                               accept / schedule / cancel.
--   Service Reports        ops.service_reports View: every filed report.
--                                               Edit: correct a report.
--   Record Past Service    ops.past_service    Edit: key in work a technician
--                                               already did (back-entry).
--
-- Staff with Edit on Dispatch act like the Super Admin on job orders; the
-- worker-field guard still protects tickets from technicians exactly as
-- before. Deleting job orders and reports stays Super Admin only.
--
-- Requires 20260926_01. Idempotent.
-- =====================================================================

begin;

do $$ begin
  if to_regprocedure('public.has_perm(text,text)') is null then
    raise exception 'Run 20260926_01_departments_access.sql first.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. Dispatch: guard lets dispatchers through; technicians unchanged
-- ---------------------------------------------------------------------
create or replace function public.guard_dispatch_worker_fields()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Super Admin, and staff with Edit on Dispatch (has_perm covers both)
  if public.has_perm('ops.dispatch', 'edit') then
    return new;
  end if;

  new.id := old.id;
  new.created_at := old.created_at;

  new.data := new.data
    || jsonb_strip_nulls(jsonb_build_object('assignedWorkerIds',        old.data -> 'assignedWorkerIds'))
    || jsonb_strip_nulls(jsonb_build_object('assignedWorkerNames',      old.data -> 'assignedWorkerNames'))
    || jsonb_strip_nulls(jsonb_build_object('reportAllowedWorkerIds',   old.data -> 'reportAllowedWorkerIds'))
    || jsonb_strip_nulls(jsonb_build_object('reportAllowedWorkerNames', old.data -> 'reportAllowedWorkerNames'))
    || jsonb_strip_nulls(jsonb_build_object('removedWorkers',           old.data -> 'removedWorkers'))
    || jsonb_strip_nulls(jsonb_build_object('removedWorkerIds',         old.data -> 'removedWorkerIds'))
    || jsonb_strip_nulls(jsonb_build_object('customer',                 old.data -> 'customer'))
    || jsonb_strip_nulls(jsonb_build_object('customerId',               old.data -> 'customerId'))
    || jsonb_strip_nulls(jsonb_build_object('address',                  old.data -> 'address'))
    || jsonb_strip_nulls(jsonb_build_object('scheduledAt',              old.data -> 'scheduledAt'))
    || jsonb_strip_nulls(jsonb_build_object('createdBy',                old.data -> 'createdBy'))
    || jsonb_strip_nulls(jsonb_build_object('closedBy',                 old.data -> 'closedBy'))
    || jsonb_strip_nulls(jsonb_build_object('closedById',               old.data -> 'closedById'))
    || jsonb_strip_nulls(jsonb_build_object('closedAt',                 old.data -> 'closedAt'));

  if new.status is distinct from old.status
     and new.status not in ('open', 'preparing', 'acknowledged', 'in_progress', 'completed') then
    new.status := old.status;
  end if;

  return new;
end;
$$;

drop policy if exists dispatch_select_assigned on public.dispatch_tickets;
create policy dispatch_select_assigned on public.dispatch_tickets for select to authenticated
  using (public.is_admin()
         or ((data -> 'assignedWorkerIds') @> to_jsonb(auth.uid()::text))
         or ((data -> 'removedWorkerIds') @> to_jsonb(auth.uid()::text))
         or (select public.has_perm('ops.dispatch', 'view')) or (select public.has_perm('ops.service_requests', 'view')));
drop policy if exists dispatch_insert_admin on public.dispatch_tickets;
create policy dispatch_insert_admin on public.dispatch_tickets for insert to authenticated
  with check ((select public.has_perm('ops.dispatch', 'edit')));
drop policy if exists dispatch_update_assigned on public.dispatch_tickets;
create policy dispatch_update_assigned on public.dispatch_tickets for update to authenticated
  using ((select public.has_perm('ops.dispatch', 'edit')) or ((data -> 'assignedWorkerIds') @> to_jsonb(auth.uid()::text)))
  with check ((select public.has_perm('ops.dispatch', 'edit')) or ((data -> 'assignedWorkerIds') @> to_jsonb(auth.uid()::text)));

drop policy if exists dtmsg_select on public.dispatch_ticket_messages;
create policy dtmsg_select on public.dispatch_ticket_messages for select to authenticated
  using (public.is_admin() or (select public.has_perm('ops.dispatch', 'view'))
         or exists (select 1 from public.dispatch_tickets t
                     where t.id = dispatch_ticket_messages.ticket_id
                       and (t.data -> 'assignedWorkerIds') @> to_jsonb(auth.uid()::text)));
drop policy if exists dtmsg_insert on public.dispatch_ticket_messages;
create policy dtmsg_insert on public.dispatch_ticket_messages for insert to authenticated
  with check (sender_id = auth.uid() and ((select public.has_perm('ops.dispatch', 'edit'))
         or exists (select 1 from public.dispatch_tickets t
                     where t.id = dispatch_ticket_messages.ticket_id
                       and (t.data -> 'assignedWorkerIds') @> to_jsonb(auth.uid()::text))));

-- ---------------------------------------------------------------------
-- 2. Service requests (customers' own access unchanged)
-- ---------------------------------------------------------------------
drop policy if exists "admin read all service requests" on public.service_requests;
create policy "admin read all service requests" on public.service_requests for select to authenticated
  using ((select public.has_perm('ops.service_requests', 'view')) or (select public.has_perm('ops.dispatch', 'view')));
drop policy if exists "admin insert service requests" on public.service_requests;
create policy "admin insert service requests" on public.service_requests for insert to authenticated
  with check ((select public.has_perm('ops.service_requests', 'edit')));
drop policy if exists "admin update service requests" on public.service_requests;
create policy "admin update service requests" on public.service_requests for update to authenticated
  using ((select public.has_perm('ops.service_requests', 'edit')) or (select public.has_perm('ops.dispatch', 'edit'))) with check ((select public.has_perm('ops.service_requests', 'edit')) or (select public.has_perm('ops.dispatch', 'edit')));

drop policy if exists "admin read all request messages" on public.service_request_messages;
create policy "admin read all request messages" on public.service_request_messages for select to authenticated
  using ((select public.has_perm('ops.service_requests', 'view')));
-- Office replies are sent as 'admin' (the customer sees the company, not
-- a person's role).
drop policy if exists "admin send request messages" on public.service_request_messages;
create policy "admin send request messages" on public.service_request_messages for insert to authenticated
  with check (sender_id = auth.uid() and sender_role = 'admin' and (select public.has_perm('ops.service_requests', 'edit')));

-- ---------------------------------------------------------------------
-- 3. Service reports
-- ---------------------------------------------------------------------
drop policy if exists reports_select_for_ops_staff on public.service_reports;
create policy reports_select_for_ops_staff on public.service_reports for select to authenticated
  using ((select public.has_perm('ops.service_reports', 'view')) or (select public.has_perm('ops.dispatch', 'view')) or (select public.has_perm('ops.past_service', 'edit')));
drop policy if exists reports_update_own_or_admin on public.service_reports;
create policy reports_update_own_or_admin on public.service_reports for update to authenticated
  using (technician_id = auth.uid() or (select public.has_perm('ops.service_reports', 'edit')));

-- ---------------------------------------------------------------------
-- 4. Record Past Service (current live bodies; only the check changed)
-- ---------------------------------------------------------------------
create or replace function public.admin_record_past_service(p_report jsonb)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  r        public.service_reports;
  v_tech   public.profiles;
  v_admin  text;
  v_sr     text;
  v_json   jsonb;
  v_cols   text;
begin
  if not public.has_perm('ops.past_service', 'edit') then
    raise exception 'You need Edit access for Record Past Service.' using errcode = '42501';
  end if;

  r := jsonb_populate_record(null::public.service_reports, p_report);

  select * into v_tech from public.profiles where id = r.technician_id and role = 'technician';
  if v_tech.id is null then
    raise exception 'Choose the technician who performed the work.' using errcode = 'P0001';
  end if;
  if r.date is null then
    raise exception 'Enter the date the service was performed.' using errcode = 'P0001';
  end if;
  if r.date > (now() at time zone 'Asia/Manila')::date then
    raise exception 'The service date can''t be in the future.' using errcode = 'P0001';
  end if;
  if coalesce(trim(r.cust_name), '') = '' then
    raise exception 'Choose the customer.' using errcode = 'P0001';
  end if;
  if r.equipment_id is not null and r.customer_id is not null
     and not exists (select 1 from public.customer_equipment e
                      where e.id = r.equipment_id and e.customer_id = r.customer_id) then
    raise exception 'That unit doesn''t belong to the chosen customer.' using errcode = 'P0001';
  end if;

  select coalesce(nullif(trim(name), ''), 'Admin') into v_admin from public.profiles where id = auth.uid();
  v_sr := public.next_sr_no(r.date);

  -- Only the columns the app sent (plus the forced ones below) are written;
  -- everything else keeps its column default. Client-supplied values for
  -- id / timestamps / signatures / stamps are thrown away first.
  v_json := (p_report - array['id','sr_no','created_at','completed','customer_signature','technician_signature',
                              'back_entry','entered_by','entered_by_name','entered_at','technician_name'])
         || jsonb_build_object(
              'sr_no',                v_sr,
              'technician_name',      coalesce(nullif(trim(v_tech.name), ''), r.technician_name, ''),
              'completed',            true,        -- filed = final, same as any report
              'customer_signature',   null,        -- signatures left blank on purpose
              'technician_signature', null,
              'back_entry',           true,
              'entered_by',           auth.uid(),
              'entered_by_name',      v_admin,
              'entered_at',           now());
  select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position)
    into v_cols
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'service_reports'
     and v_json ? c.column_name;

  execute format('insert into public.service_reports (%1$s) select %1$s from jsonb_populate_record(null::public.service_reports, $1)', v_cols)
    using v_json;
  return v_sr;
end;
$function$;

create or replace function public.admin_record_past_services(p_reports jsonb)
 RETURNS text[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_out  text[] := '{}';
  v_item jsonb;
  v_eq   uuid[] := '{}';
  v_id   uuid;
begin
  if not public.has_perm('ops.past_service', 'edit') then
    raise exception 'You need Edit access for Record Past Service.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_reports) <> 'array' or jsonb_array_length(p_reports) = 0 then
    raise exception 'Add at least one unit.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_reports) > 50 then
    raise exception 'Record at most 50 units at a time.' using errcode = 'P0001';
  end if;
  for v_item in select * from jsonb_array_elements(p_reports) loop
    v_id := nullif(v_item->>'equipment_id', '')::uuid;
    if v_id is not null and v_id = any(v_eq) then
      raise exception 'The same unit was added twice.' using errcode = 'P0001';
    end if;
    v_eq := v_eq || v_id;
    v_out := v_out || public.admin_record_past_service(v_item);
  end loop;
  return v_out;
end;
$function$;

-- ---------------------------------------------------------------------
-- 5. Technician names for assigning / filing (read only)
-- ---------------------------------------------------------------------
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

grant select, insert, update, delete on public.dispatch_ticket_messages, public.service_requests, public.service_request_messages to authenticated;

commit;

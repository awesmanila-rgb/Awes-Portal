-- =====================================================================
-- AWES App — Open OPERATIONS (part 2) to department staff (Phase 3g)
--
-- Pages opened:
--   Live Tracker       ops.tracker        View: technicians' live position
--                                          and today's trail.
--   Projects           ops.projects       View: projects and their job
--                                          orders (cost only with "See peso
--                                          values"). Edit: add / change.
--   Tools & Equipment  tools.register     View: the register. Edit: add /
--                      tools.issue           change tools, mark lost / found /
--                      tools.return          retired.
--                      tools.handover     Issue / Return / Handover: Edit posts.
--                      tools.defects      Defects: Edit decides (repair /
--                      tools.maintenance     write off). Calibration: Edit logs.
--                      tools.slips        Slips / Reports: View.
--                      tools.reports
--
-- Like Inventory: staff work across every warehouse (storekeepers stay
-- limited to their own), and purchase / repair costs appear only with
-- "See peso values" — otherwise staff read the cost-free tools_view, the
-- same list workers already use.
--
-- Requires 20260926_01 and 20260926_03 (inv_require_warehouse(uuid,text)).
-- Idempotent.
-- =====================================================================

begin;

do $$ begin
  if to_regprocedure('public.inv_require_warehouse(uuid,text)') is null then
    raise exception 'Run 20260926_01 and 20260926_03 first.';
  end if;
  if to_regprocedure('public.tl_post_issue(jsonb)') is null then
    raise exception 'Run the tools migrations (20260924_*) first.';
  end if;
end $$;

-- Any Tools & Equipment page at View
create or replace function public.tl_staff_view()
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$
  select public.has_perm('tools.register', 'view') or public.has_perm('tools.issue', 'view')
      or public.has_perm('tools.return', 'view') or public.has_perm('tools.handover', 'view')
      or public.has_perm('tools.defects', 'view') or public.has_perm('tools.maintenance', 'view')
      or public.has_perm('tools.slips', 'view') or public.has_perm('tools.reports', 'view');
$$;
revoke execute on function public.tl_staff_view() from public, anon;
grant execute on function public.tl_staff_view() to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 1. Tool functions (current live bodies; only the permission lines changed)
-- ---------------------------------------------------------------------
create or replace function public.tl_admin_status(p_tool uuid, p_status text, p_note text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare t record;
begin
  if not public.has_perm('tools.register', 'edit') then raise exception 'You need Edit access for Tool Register.' using errcode = '42501'; end if;
  select * into t from public.tools where id = p_tool for update;
  if t is null then raise exception 'Tool not found.' using errcode = 'P0001'; end if;
  if not ((p_status = 'available' and t.status = 'lost') or (p_status = 'retired' and t.status in ('available', 'lost', 'defective'))) then
    raise exception 'Can''t change % from % to %.', t.asset_tag, t.status, p_status using errcode = 'P0001';
  end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'Give a reason.' using errcode = 'P0001'; end if;
  perform set_config('awes.tl_posting', 'on', true);
  update public.tools set status = p_status where id = p_tool;
  perform public.tl_event(p_tool, case p_status when 'available' then 'Found / back in service' else 'Retired' end, '', p_note);
end; $function$;

create or replace function public.tl_decide_defect(p jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare d record; dec text := p->>'decision'; st text := coalesce(nullif(p->>'status', ''), 'open'); newst text;
begin
  if not public.has_perm('tools.defects', 'edit') then raise exception 'You need Edit access for Defect Reports.' using errcode = '42501'; end if;
  select * into d from public.tool_defects where id = (p->>'defect_id')::uuid for update;
  if d is null then raise exception 'Defect report not found.' using errcode = 'P0001'; end if;
  if d.status = 'closed' then raise exception '% is already closed.', d.defect_no using errcode = 'P0001'; end if;
  if st = 'closed' and dec = 'pending' then raise exception 'Choose a decision before closing.' using errcode = 'P0001'; end if;
  perform set_config('awes.tl_posting', 'on', true);
  update public.tool_defects set decision = dec, status = st,
         cause = coalesce(nullif(p->>'cause', ''), cause), repair_vendor = coalesce(p->>'repair_vendor', repair_vendor),
         repair_cost = case when p ? 'repair_cost' then nullif(p->>'repair_cost', '')::numeric else repair_cost end,
         chargeable_to_worker = coalesce((p->>'chargeable_to_worker')::boolean, chargeable_to_worker),
         closed_at = case when st = 'closed' then now() end
   where id = d.id;
  newst := case
    when st = 'in_repair' then 'repair'
    when st = 'closed' and dec in ('repair', 'no_fault') then 'available'
    when st = 'closed' and dec in ('replace', 'write_off') then 'retired'
    else null end;
  if newst is not null then
    update public.tools set status = newst, condition = case when newst = 'available' then 'good' else condition end where id = d.tool_id;
    perform public.tl_event(d.tool_id, case newst when 'repair' then 'Sent for repair' when 'available' then 'Back in service' else 'Retired' end,
                            d.defect_no, replace(dec, '_', ' ') || coalesce(' · ' || nullif(p->>'note', ''), ''));
  end if;
end; $function$;

create or replace function public.tl_can_see_tool(p_tool uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select exists (select 1 from public.tools t where t.id = p_tool
                  and (public.is_admin() or public.inv_can_handle(t.home_warehouse_id) or t.holder_id = auth.uid() or public.tl_staff_view()));
$function$;

create or replace function public.tl_keeps_tool(p_tool uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select exists (select 1 from public.tools t where t.id = p_tool and (public.is_admin() or public.inv_can_handle(t.home_warehouse_id) or public.tl_staff_view()));
$function$;

create or replace function public.tl_log_maintenance(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare t record; nd date; dno text;
begin
  select * into t from public.tools where id = (p->>'tool_id')::uuid for update;
  if t is null then raise exception 'Tool not found.' using errcode = 'P0001'; end if;
  if not (public.inv_can_handle(t.home_warehouse_id) or public.has_perm('tools.maintenance', 'edit')) then raise exception 'Not your warehouse''s tool.' using errcode = '42501'; end if;
  if p->>'result' not in ('pass', 'fail') then raise exception 'Choose pass or fail.' using errcode = 'P0001'; end if;
  nd := case when p->>'result' = 'pass' and t.maint_interval_days is not null then (p->>'done_on')::date + t.maint_interval_days end;
  insert into public.tool_maintenance (tool_id, type, done_on, result, by_name, cert_ref, next_due, note)
  values (t.id, coalesce(nullif(p->>'type', ''), t.maint_type, 'inspection'), (p->>'done_on')::date, p->>'result', public.inv_my_name(),
          coalesce(p->>'cert_ref', ''), nd, coalesce(p->>'note', ''));
  perform set_config('awes.tl_posting', 'on', true);
  if p->>'result' = 'pass' then
    update public.tools set next_maint_due = nd where id = t.id;
    perform public.tl_event(t.id, initcap(coalesce(nullif(p->>'type', ''), t.maint_type, 'inspection')) || ' passed', coalesce(p->>'cert_ref', ''), coalesce('next due ' || nd::text, ''));
    return jsonb_build_object('next_due', nd);
  end if;
  if t.status = 'issued' then raise exception 'Return % before recording a failed check.', t.asset_tag using errcode = 'P0001'; end if;
  dno := public.inv_next_no('DEF');
  insert into public.tool_defects (defect_no, tool_id, condition, description, reported_by_name)
  values (dno, t.id, 'defective', 'Failed ' || coalesce(nullif(p->>'type', ''), t.maint_type, 'inspection') || coalesce(': ' || nullif(p->>'note', ''), ''), public.inv_my_name());
  update public.tools set status = 'defective' where id = t.id;
  perform public.tl_event(t.id, 'Failed ' || coalesce(nullif(p->>'type', ''), t.maint_type, 'inspection'), dno, coalesce(p->>'note', ''));
  return jsonb_build_object('defect_no', dno);
end; $function$;

create or replace function public.tl_post_handover(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  fw uuid := (p->>'from_worker_id')::uuid; tw uuid := (p->>'to_worker_id')::uuid; fname text; tname text;
  l jsonb; t record; sid uuid; sno text;
begin
  if not (public.is_admin() or public.inv_is_storekeeper() or fw = auth.uid() or public.has_perm('tools.handover', 'edit')) then
    raise exception 'Only the person holding the tools (or an admin / storekeeper) can hand them over.' using errcode = '42501';
  end if;
  select name into fname from public.profiles where id = fw;
  select name into tname from public.profiles where id = tw and coalesce(active, true);
  if fname is null or tname is null or fw = tw then raise exception 'Choose who is receiving the tools.' using errcode = 'P0001'; end if;
  if coalesce(p->>'sig_giver_path', '') = '' or coalesce(p->>'sig_receiver_path', '') = '' then
    raise exception 'Both workers must sign the handover.' using errcode = 'P0001';
  end if;
  if not (public.tl_own_path(p->>'sig_giver_path') and public.tl_own_path(p->>'sig_receiver_path')) then raise exception 'Invalid signature file.' using errcode = '42501'; end if;
  if jsonb_array_length(coalesce(p->'lines', '[]')) = 0 then raise exception 'Choose at least one tool.' using errcode = 'P0001'; end if;
  perform set_config('awes.tl_posting', 'on', true);
  sno := public.inv_next_no('THO');
  insert into public.tool_slips (slip_no, type, from_worker_id, from_worker_name, to_worker_id, to_worker_name, note, sign_mode, keeper_name,
                                 sig_keeper_path, sig_worker_path, status, completed_at)
  values (sno, 'handover', fw, fname, tw, tname, coalesce(p->>'note', ''), 'counter', public.inv_my_name(),
          p->>'sig_giver_path', p->>'sig_receiver_path', 'complete', now())
  returning id into sid;
  for l in select * from jsonb_array_elements(p->'lines') loop
    select * into t from public.tools where id = (l->>'tool_id')::uuid for update;
    if t is null or t.status <> 'issued' or t.holder_id is distinct from fw then
      raise exception '% isn''t held by %.', coalesce(t.asset_tag, 'That tool'), fname using errcode = 'P0001';
    end if;
    insert into public.tool_slip_lines (slip_id, tool_id) values (sid, t.id);
    update public.tools set holder_id = tw, holder_name = tname, current_slip_id = sid where id = t.id;
    perform public.tl_event(t.id, 'Handed over', sno, fname || ' → ' || tname);
  end loop;
  return jsonb_build_object('id', sid, 'slip_no', sno);
end; $function$;

create or replace function public.tl_post_issue(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  wh uuid := (p->>'warehouse_id')::uuid; wk uuid := nullif(p->>'worker_id', '')::uuid; wname text;
  mode text := coalesce(nullif(p->>'sign_mode', ''), 'counter');
  job text := nullif(p->>'job_order_id', ''); proj uuid := nullif(p->>'project_id', '')::uuid;
  l jsonb; t record; sid uuid; sno text;
begin
  perform public.inv_require_warehouse(wh, 'tools.issue');
  select name into wname from public.profiles where id = wk and coalesce(active, true);
  if wname is null then raise exception 'Choose who the tools are issued to.' using errcode = 'P0001'; end if;
  if coalesce(p->>'sig_keeper_path', '') = '' then raise exception 'The warehouseman must sign.' using errcode = 'P0001'; end if;
  if mode = 'counter' and coalesce(p->>'sig_worker_path', '') = '' then raise exception 'The worker must sign (or choose "sign on their phone").' using errcode = 'P0001'; end if;
  if not (public.tl_own_path(p->>'sig_keeper_path') and public.tl_own_path(p->>'sig_worker_path')) then
    raise exception 'Invalid signature file.' using errcode = '42501';
  end if;
  if jsonb_array_length(coalesce(p->'lines', '[]')) = 0 then raise exception 'Add at least one tool.' using errcode = 'P0001'; end if;
  if proj is null and job is not null then select project_id into proj from public.project_job_orders where job_order_id = job; end if;
  perform set_config('awes.tl_posting', 'on', true);
  sno := public.inv_next_no('TIS');
  insert into public.tool_slips (slip_no, type, warehouse_id, to_worker_id, to_worker_name, job_order_id, project_id, due_back, note,
                                 sign_mode, keeper_name, sig_keeper_path, sig_worker_path, status, completed_at)
  values (sno, 'issue', wh, wk, wname, job, proj, nullif(p->>'due_back', '')::date, coalesce(p->>'note', ''), mode, public.inv_my_name(),
          p->>'sig_keeper_path', coalesce(p->>'sig_worker_path', ''),
          case when coalesce(p->>'sig_worker_path', '') <> '' then 'complete' else 'pending_signature' end,
          case when coalesce(p->>'sig_worker_path', '') <> '' then now() end)
  returning id into sid;
  for l in select * from jsonb_array_elements(p->'lines') loop
    select * into t from public.tools where id = (l->>'tool_id')::uuid for update;
    if t is null then raise exception 'Tool not found.' using errcode = 'P0001'; end if;
    if t.status <> 'available' then raise exception '% % is % — it can''t be issued.', t.asset_tag, t.name, t.status using errcode = 'P0001'; end if;
    if t.home_warehouse_id <> wh then raise exception '% is kept in another warehouse.', t.asset_tag using errcode = 'P0001'; end if;
    if t.next_maint_due is not null and t.next_maint_due < public.tl_today() then
      raise exception '% % is overdue for % (due %) — it can''t be issued until it passes.', t.asset_tag, t.name, t.maint_type, t.next_maint_due using errcode = 'P0001';
    end if;
    if not public.tl_own_path(l->>'photo_path') then raise exception 'Invalid photo file.' using errcode = '42501'; end if;
    insert into public.tool_slip_lines (slip_id, tool_id, condition, photo_path, note) values (sid, t.id, 'good', coalesce(l->>'photo_path', ''), coalesce(l->>'note', ''));
    update public.tools set status = 'issued', holder_id = wk, holder_name = wname, current_slip_id = sid, job_order_id = job, project_id = proj,
                            issued_at = now(), due_back = nullif(p->>'due_back', '')::date where id = t.id;
    perform public.tl_event(t.id, 'Issued', sno, 'to ' || wname || coalesce(' · ' || job, ''));
  end loop;
  return jsonb_build_object('id', sid, 'slip_no', sno);
end; $function$;

create or replace function public.tl_post_return(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  wh uuid := (p->>'warehouse_id')::uuid; wk uuid := nullif(p->>'worker_id', '')::uuid; wname text;
  mode text := coalesce(nullif(p->>'sign_mode', ''), 'counter');
  l jsonb; t record; sid uuid; sno text; cond text; dno text; defects int := 0;
begin
  perform public.inv_require_warehouse(wh, 'tools.return');
  select name into wname from public.profiles where id = wk;
  if wname is null then raise exception 'Choose who is returning the tools.' using errcode = 'P0001'; end if;
  if coalesce(p->>'sig_keeper_path', '') = '' then raise exception 'The warehouseman must sign.' using errcode = 'P0001'; end if;
  if mode = 'counter' and coalesce(p->>'sig_worker_path', '') = '' then raise exception 'The worker must sign (or choose "sign on their phone").' using errcode = 'P0001'; end if;
  if not (public.tl_own_path(p->>'sig_keeper_path') and public.tl_own_path(p->>'sig_worker_path')) then raise exception 'Invalid signature file.' using errcode = '42501'; end if;
  if jsonb_array_length(coalesce(p->'lines', '[]')) = 0 then raise exception 'Add at least one tool.' using errcode = 'P0001'; end if;
  perform set_config('awes.tl_posting', 'on', true);
  sno := public.inv_next_no('TRS');
  insert into public.tool_slips (slip_no, type, warehouse_id, from_worker_id, from_worker_name, note, sign_mode, keeper_name,
                                 sig_keeper_path, sig_worker_path, status, completed_at)
  values (sno, 'return', wh, wk, wname, coalesce(p->>'note', ''), mode, public.inv_my_name(), p->>'sig_keeper_path', coalesce(p->>'sig_worker_path', ''),
          case when coalesce(p->>'sig_worker_path', '') <> '' then 'complete' else 'pending_signature' end,
          case when coalesce(p->>'sig_worker_path', '') <> '' then now() end)
  returning id into sid;
  for l in select * from jsonb_array_elements(p->'lines') loop
    select * into t from public.tools where id = (l->>'tool_id')::uuid for update;
    if t is null then raise exception 'Tool not found.' using errcode = 'P0001'; end if;
    if t.status <> 'issued' or t.holder_id is distinct from wk then
      raise exception '% % isn''t held by %.', t.asset_tag, t.name, wname using errcode = 'P0001';
    end if;
    cond := coalesce(nullif(l->>'condition', ''), 'good');
    if cond not in ('good', 'needs_repair', 'defective', 'missing_parts', 'lost') then raise exception 'Unknown condition %.', cond using errcode = 'P0001'; end if;
    if cond = 'good' and jsonb_array_length(coalesce(l->'kit_missing', '[]')) > 0 then cond := 'missing_parts'; end if;
    if cond <> 'good' and cond <> 'lost' and coalesce(l->>'photo_path', '') = '' and coalesce(l->>'note', '') = ''
       and jsonb_array_length(coalesce(l->'kit_missing', '[]')) = 0 then
      raise exception '% %: add a photo or a note describing the problem.', t.asset_tag, t.name using errcode = 'P0001';
    end if;
    if not public.tl_own_path(l->>'photo_path') then raise exception 'Invalid photo file.' using errcode = '42501'; end if;
    insert into public.tool_slip_lines (slip_id, tool_id, condition, kit_missing, photo_path, note)
    values (sid, t.id, cond, coalesce(l->'kit_missing', '[]'), coalesce(l->>'photo_path', ''), coalesce(l->>'note', ''));
    if cond = 'good' then
      update public.tools set status = 'available', home_warehouse_id = wh, holder_id = null, holder_name = '', current_slip_id = null,
                              job_order_id = null, project_id = null, issued_at = null, due_back = null where id = t.id;
      perform public.tl_event(t.id, 'Returned', sno, 'good · by ' || wname);
    else
      dno := public.inv_next_no('DEF');
      insert into public.tool_defects (defect_no, tool_id, slip_id, worker_id, worker_name, job_order_id, project_id, condition, description,
                                       photo_path, under_warranty, reported_by_name)
      values (dno, t.id, sid, wk, wname, t.job_order_id, t.project_id, cond,
              coalesce(nullif(l->>'note', ''), '') || case when jsonb_array_length(coalesce(l->'kit_missing', '[]')) > 0
                then ' Missing: ' || (select string_agg(x->>'name' || coalesce(' ×' || (x->>'qty'), ''), ', ') from jsonb_array_elements(l->'kit_missing') x) else '' end,
              coalesce(l->>'photo_path', ''), coalesce(t.warranty_until >= public.tl_today(), false), public.inv_my_name());
      update public.tools set status = case when cond = 'lost' then 'lost' else 'defective' end, home_warehouse_id = wh,
                              holder_id = null, holder_name = '', current_slip_id = null, job_order_id = null, project_id = null,
                              issued_at = null, due_back = null where id = t.id;
      perform public.tl_event(t.id, case when cond = 'lost' then 'Reported lost' else 'Returned defective' end, sno, replace(cond, '_', ' ') || ' · by ' || wname || ' · ' || dno);
      defects := defects + 1;
    end if;
  end loop;
  return jsonb_build_object('id', sid, 'slip_no', sno, 'defects', defects);
end; $function$;

-- ---------------------------------------------------------------------
-- 2. Tools register: full rows (with cost) only with "See peso values"
-- ---------------------------------------------------------------------
-- Direct writes stay Super Admin only (a table-wide write rule would also
-- let a staff member READ full rows, cost included). Staff add and edit
-- tools through tl_staff_save_tools() below.
drop policy if exists tools_admin on public.tools;
drop policy if exists tools_staff_read on public.tools;
drop policy if exists tools_staff_write on public.tools;
create policy tools_admin on public.tools for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy tools_staff_read on public.tools for select to authenticated
  using ((select public.can_see_costs()) and (select public.tl_staff_view()));

-- Add (p_id null → one row per element of p_rows) or edit (p_id) tools as
-- staff with Tool Register Edit. Purchase fields (date, cost, supplier,
-- PO no., warranty) are only written by staff with "See peso values";
-- for everyone else they're left exactly as they were.
create or replace function public.tl_staff_save_tools(p_id uuid, p_rows jsonb)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  r jsonb; money boolean := public.can_see_costs(); out jsonb := '[]'::jsonb; rec public.tools;
begin
  if not public.has_perm('tools.register', 'edit') then
    raise exception 'You need Edit access for Tool Register.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'Nothing to save.' using errcode = 'P0001';
  end if;
  if p_id is not null then
    r := p_rows->0;
    update public.tools set
      kind = coalesce(r->>'kind', kind), name = coalesce(nullif(trim(r->>'name'), ''), name),
      category = coalesce(r->>'category', category), brand = coalesce(r->>'brand', brand), model = coalesce(r->>'model', model),
      serial_no = coalesce(r->>'serial_no', serial_no),
      home_warehouse_id = coalesce(nullif(r->>'home_warehouse_id', '')::uuid, home_warehouse_id),
      kit_contents = coalesce(r->'kit_contents', kit_contents),
      maint_type = nullif(r->>'maint_type', ''), maint_interval_days = nullif(r->>'maint_interval_days', '')::int,
      next_maint_due = nullif(r->>'next_maint_due', '')::date, notes = coalesce(r->>'notes', notes),
      purchase_date  = case when money then nullif(r->>'purchase_date', '')::date else purchase_date end,
      purchase_cost  = case when money then nullif(r->>'purchase_cost', '')::numeric else purchase_cost end,
      supplier_id    = case when money then nullif(r->>'supplier_id', '')::uuid else supplier_id end,
      po_no          = case when money then coalesce(r->>'po_no', '') else po_no end,
      warranty_until = case when money then nullif(r->>'warranty_until', '')::date else warranty_until end
    where id = p_id returning * into rec;
    if rec.id is null then raise exception 'Tool not found.' using errcode = 'P0001'; end if;
    return jsonb_build_array(jsonb_build_object('id', rec.id, 'asset_tag', rec.asset_tag));
  end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    insert into public.tools (kind, name, category, brand, model, serial_no, home_warehouse_id, kit_contents,
                              maint_type, maint_interval_days, next_maint_due, notes,
                              purchase_date, purchase_cost, supplier_id, po_no, warranty_until)
    values (coalesce(r->>'kind', 'tool'), r->>'name', coalesce(r->>'category', ''), coalesce(r->>'brand', ''), coalesce(r->>'model', ''),
            coalesce(r->>'serial_no', ''), (r->>'home_warehouse_id')::uuid, coalesce(r->'kit_contents', '[]'::jsonb),
            nullif(r->>'maint_type', ''), nullif(r->>'maint_interval_days', '')::int, nullif(r->>'next_maint_due', '')::date,
            coalesce(r->>'notes', ''),
            case when money then nullif(r->>'purchase_date', '')::date end,
            case when money then nullif(r->>'purchase_cost', '')::numeric end,
            case when money then nullif(r->>'supplier_id', '')::uuid end,
            case when money then coalesce(r->>'po_no', '') else '' end,
            case when money then nullif(r->>'warranty_until', '')::date end)
    returning * into rec;
    out := out || jsonb_build_array(jsonb_build_object('id', rec.id, 'asset_tag', rec.asset_tag));
  end loop;
  return out;
end;
$$;
revoke execute on function public.tl_staff_save_tools(uuid, jsonb) from public, anon;
grant execute on function public.tl_staff_save_tools(uuid, jsonb) to authenticated;

create or replace view public.tools_view with (security_invoker = false) as
  select id, asset_tag, kind, name, brand, model, serial_no, category, kit_contents, home_warehouse_id, status, condition,
         holder_id, holder_name, current_slip_id, job_order_id, project_id, issued_at, due_back, warranty_until,
         maint_type, maint_interval_days, next_maint_due, notes, created_at, purchase_date, po_no
    from public.tools t
   where public.is_admin() or public.inv_can_handle(home_warehouse_id) or holder_id = auth.uid()
      or public.tl_staff_view();

-- Slips (issue / return / handover)
drop policy if exists tl_slips_read on public.tool_slips;
create policy tl_slips_read on public.tool_slips for select to authenticated
  using (public.is_admin() or (warehouse_id is not null and public.inv_can_handle(warehouse_id))
         or (public.inv_is_storekeeper() and type = 'handover')
         or from_worker_id = auth.uid() or to_worker_id = auth.uid()
         or (select public.tl_staff_view()));
drop policy if exists tl_lines_read on public.tool_slip_lines;
create policy tl_lines_read on public.tool_slip_lines for select to authenticated
  using (exists (select 1 from public.tool_slips s where s.id = tool_slip_lines.slip_id and (
           public.is_admin() or (s.warehouse_id is not null and public.inv_can_handle(s.warehouse_id))
           or (public.inv_is_storekeeper() and s.type = 'handover')
           or s.from_worker_id = auth.uid() or s.to_worker_id = auth.uid()
           or (select public.tl_staff_view()))));

-- Tool photos / signatures
do $$ begin
  if to_regclass('storage.objects') is not null then
    drop policy if exists tool_files_select on storage.objects;
    create policy tool_files_select on storage.objects for select to authenticated
      using (bucket_id = 'tool-files' and (public.is_admin() or public.inv_is_storekeeper()
             or (storage.foldername(name))[1] = auth.uid()::text or (select public.tl_staff_view())));
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 3. Projects
-- ---------------------------------------------------------------------
drop policy if exists projects_admin on public.projects;
drop policy if exists projects_staff_write on public.projects;
create policy projects_staff_write on public.projects for all to authenticated
  using ((select public.has_perm('ops.projects', 'edit'))) with check ((select public.has_perm('ops.projects', 'edit')));
drop policy if exists pjo_admin on public.project_job_orders;
drop policy if exists pjo_staff_write on public.project_job_orders;
create policy pjo_staff_write on public.project_job_orders for all to authenticated
  using ((select public.has_perm('ops.projects', 'edit'))) with check ((select public.has_perm('ops.projects', 'edit')));
-- the job orders a project links to
drop policy if exists dispatch_select_for_projects on public.dispatch_tickets;
create policy dispatch_select_for_projects on public.dispatch_tickets for select to authenticated
  using ((select public.has_perm('ops.projects', 'view')));

-- ---------------------------------------------------------------------
-- 4. Live Tracker (read only)
-- ---------------------------------------------------------------------
drop policy if exists techloc_select on public.technician_locations;
create policy techloc_select on public.technician_locations for select to authenticated
  using (public.is_admin() or technician_id = auth.uid() or (select public.has_perm('ops.tracker', 'view')));
do $$ begin
  if to_regclass('public.technician_location_history') is not null then
    drop policy if exists tlhistory_select_own_or_admin on public.technician_location_history;
    create policy tlhistory_select_own_or_admin on public.technician_location_history for select to authenticated
      using (technician_id = auth.uid() or public.is_admin() or (select public.has_perm('ops.tracker', 'view')));
  end if;
end $$;

-- Technician names (tools holders, tracker)
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

grant select on public.tool_slips, public.tool_slip_lines, public.tool_defects, public.tool_maintenance, public.tool_events to authenticated;
grant select, insert, update, delete on public.tools, public.projects, public.project_job_orders to authenticated;
grant select, insert, update, delete on public.technician_locations to authenticated;   -- rows still limited by its own rules
do $$ begin
  if to_regclass('public.technician_location_history') is not null then
    grant select, insert, delete on public.technician_location_history to authenticated;
  end if;
end $$;

commit;

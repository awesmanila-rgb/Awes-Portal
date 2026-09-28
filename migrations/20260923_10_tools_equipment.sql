-- ---------------------------------------------------------------------
-- Tools & Equipment
--
--   tools               the register: one row per tool (asset tag TL-0001)
--                       or per KIT (small hand tools grouped, with a
--                       contents list)
--   tool_slips          TIS- issue · TRS- return · THO- worker-to-worker
--                       handover; signed by BOTH sides (warehouseman +
--                       worker, or giver + receiver). The worker signs on
--                       the counter device or later on their own phone —
--                       chosen per slip.
--   tool_slip_lines     tools on a slip, with condition / photo / missing
--                       kit contents
--   tool_defects        DEF- reports, opened automatically by a return that
--                       isn't "good" (or a failed calibration); decision:
--                       repair / replace / write off / no fault
--   tool_maintenance    calibration & inspection log; sets the next due date
--   tool_events         every tool's full history
--
-- Rules the DATABASE enforces (all changes of status / holder go through
-- the tl_* functions — a tool can't just be edited to "available"):
--   * only available tools in the warehouse can be issued, and a tool whose
--     calibration / inspection is OVERDUE can't be issued at all;
--   * only what a worker actually holds can be returned or handed over;
--   * slips complete when both signatures are in;
--   * a return that isn't good opens a defect report and takes the tool out
--     of service until the defect is decided;
--   * storekeepers handle their own warehouses; workers see only what they
--     hold; nobody but admins sees purchase costs.
--
-- Depends on 20260923_07 / _08 (warehouses, storekeepers, projects,
-- inv_can_handle, inv_next_no). Safe to re-run.
-- ---------------------------------------------------------------------

do $$
begin
  if to_regprocedure('public.inv_next_no(text)') is null then
    raise exception 'Run 20260923_08_inventory_movements.sql first.';
  end if;
end $$;

create sequence if not exists public.tool_tag_seq start 1;

create table if not exists public.tools (
  id                    uuid primary key default gen_random_uuid(),
  asset_tag             text unique not null default ('TL-' || lpad(nextval('public.tool_tag_seq')::text, 4, '0')),
  kind                  text not null default 'tool' check (kind in ('tool', 'kit')),
  name                  text not null,
  brand                 text not null default '',
  model                 text not null default '',
  serial_no             text not null default '',
  category              text not null default 'Other',
  kit_contents          jsonb not null default '[]',        -- [{"name":"Screwdriver set","qty":1}, …]
  home_warehouse_id     uuid not null references public.warehouses(id),
  status                text not null default 'available'
                          check (status in ('available', 'issued', 'defective', 'repair', 'lost', 'retired')),
  condition             text not null default 'good' check (condition in ('good', 'fair', 'poor')),
  holder_id             uuid references auth.users(id),
  holder_name           text not null default '',
  current_slip_id       uuid,
  job_order_id          text,
  project_id            uuid references public.projects(id),
  issued_at             timestamptz,
  due_back              date,
  purchase_date         date,
  purchase_cost         numeric(12,2) check (purchase_cost is null or purchase_cost >= 0),   -- admin only
  supplier_id           uuid references public.suppliers(id),
  po_no                 text not null default '',
  warranty_until        date,
  maint_type            text check (maint_type is null or maint_type in ('calibration', 'inspection')),
  maint_interval_days   int check (maint_interval_days is null or maint_interval_days > 0),
  next_maint_due        date,
  notes                 text not null default '',
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
alter sequence public.tool_tag_seq owned by public.tools.asset_tag;
create index if not exists tools_status_idx on public.tools (status, home_warehouse_id);
create index if not exists tools_holder_idx on public.tools (holder_id);

create table if not exists public.tool_slips (
  id                 uuid primary key default gen_random_uuid(),
  slip_no            text unique not null,
  type               text not null check (type in ('issue', 'return', 'handover')),
  warehouse_id       uuid references public.warehouses(id),
  from_worker_id     uuid references auth.users(id),   -- return: who brought it back; handover: giver
  from_worker_name   text not null default '',
  to_worker_id       uuid references auth.users(id),   -- issue: who took it; handover: receiver
  to_worker_name     text not null default '',
  job_order_id       text,
  project_id         uuid references public.projects(id),
  due_back           date,
  note               text not null default '',
  sign_mode          text not null default 'counter' check (sign_mode in ('counter', 'phone')),
  keeper_id          uuid references auth.users(id) default auth.uid(),
  keeper_name        text not null default '',
  sig_keeper_path    text not null default '',          -- warehouseman (issue/return) or giver (handover)
  sig_worker_path    text not null default '',          -- worker (issue/return) or receiver (handover)
  status             text not null default 'complete' check (status in ('pending_signature', 'complete')),
  completed_at       timestamptz,
  created_at         timestamptz not null default now()
);
create table if not exists public.tool_slip_lines (
  id           uuid primary key default gen_random_uuid(),
  slip_id      uuid not null references public.tool_slips(id) on delete restrict,
  tool_id      uuid not null references public.tools(id),
  condition    text not null default 'good' check (condition in ('good', 'needs_repair', 'defective', 'missing_parts', 'lost')),
  kit_missing  jsonb not null default '[]',
  photo_path   text not null default '',
  note         text not null default ''
);
create index if not exists tool_slip_lines_tool_idx on public.tool_slip_lines (tool_id);

create table if not exists public.tool_defects (
  id                   uuid primary key default gen_random_uuid(),
  defect_no            text unique not null,
  tool_id              uuid not null references public.tools(id),
  slip_id              uuid references public.tool_slips(id),
  worker_id            uuid references auth.users(id),
  worker_name          text not null default '',
  job_order_id         text,
  project_id           uuid references public.projects(id),
  condition            text not null,
  description          text not null default '',
  photo_path           text not null default '',
  cause                text not null default 'unknown' check (cause in ('wear', 'misuse', 'accident', 'unknown')),
  under_warranty       boolean not null default false,
  decision             text not null default 'pending' check (decision in ('pending', 'repair', 'replace', 'write_off', 'no_fault')),
  repair_vendor        text not null default '',
  repair_cost          numeric(12,2),
  chargeable_to_worker boolean not null default false,  -- recorded per company policy; never deducted automatically
  status               text not null default 'open' check (status in ('open', 'in_repair', 'closed')),
  reported_by_name     text not null default '',
  closed_at            timestamptz,
  created_at           timestamptz not null default now()
);
create table if not exists public.tool_maintenance (
  id         uuid primary key default gen_random_uuid(),
  tool_id    uuid not null references public.tools(id),
  type       text not null check (type in ('calibration', 'inspection')),
  done_on    date not null,
  result     text not null check (result in ('pass', 'fail')),
  by_name    text not null default '',
  cert_ref   text not null default '',
  next_due   date,
  note       text not null default '',
  created_at timestamptz not null default now()
);
create table if not exists public.tool_events (
  id        uuid primary key default gen_random_uuid(),
  tool_id   uuid not null references public.tools(id),
  at        timestamptz not null default now(),
  event     text not null,
  ref       text not null default '',
  by_name   text not null default '',
  detail    text not null default ''
);
create index if not exists tool_events_tool_idx on public.tool_events (tool_id, at desc);

-- ---------- guard: status / custody fields only change inside tl_* ----------
create or replace function public.tl_tools_guard()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if current_setting('awes.tl_posting', true) = 'on' then new.updated_at := now(); return new; end if;
  if tg_op = 'INSERT' then
    new.status := 'available'; new.holder_id := null; new.holder_name := ''; new.current_slip_id := null;
    new.job_order_id := null; new.project_id := null; new.issued_at := null; new.due_back := null;
    if new.maint_interval_days is not null and new.next_maint_due is null then
      new.next_maint_due := (now() at time zone 'Asia/Manila')::date + new.maint_interval_days;
    end if;
    return new;
  end if;
  if (new.status, new.holder_id, new.holder_name, new.current_slip_id, new.job_order_id, new.project_id, new.issued_at, new.due_back)
     is distinct from (old.status, old.holder_id, old.holder_name, old.current_slip_id, old.job_order_id, old.project_id, old.issued_at, old.due_back) then
    raise exception 'A tool''s status and custody change only through issue, return, handover or defect decisions.' using errcode = 'P0001';
  end if;
  if new.asset_tag <> old.asset_tag then raise exception 'Asset tags can''t be changed.' using errcode = 'P0001'; end if;
  new.updated_at := now();
  return new;
end; $$;
drop trigger if exists tools_guard on public.tools;
create trigger tools_guard before insert or update on public.tools for each row execute function public.tl_tools_guard();

-- ---------- helpers ----------
create or replace function public.tl_today() returns date language sql stable as $$ select (now() at time zone 'Asia/Manila')::date $$;
create or replace function public.tl_event(p_tool uuid, p_event text, p_ref text, p_detail text)
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into public.tool_events (tool_id, event, ref, by_name, detail) values (p_tool, p_event, coalesce(p_ref, ''), public.inv_my_name(), coalesce(p_detail, ''));
$$;
-- a signature/photo path must sit in the caller's own storage folder
create or replace function public.tl_own_path(p text) returns boolean language sql stable as $$
  select coalesce(p, '') = '' or split_part(p, '/', 1) = auth.uid()::text;
$$;
create or replace function public.tl_complete_if_signed(p_slip uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.tool_slips set status = 'complete', completed_at = now()
   where id = p_slip and status = 'pending_signature' and sig_keeper_path <> '' and sig_worker_path <> '';
end; $$;

-- =====================================================================
-- ISSUE  p: {warehouse_id, worker_id, job_order_id?, project_id?, due_back?, note?,
--            sign_mode 'counter'|'phone', sig_keeper_path, sig_worker_path?,
--            lines:[{tool_id, photo_path?, note?}]}
-- =====================================================================
create or replace function public.tl_post_issue(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  wh uuid := (p->>'warehouse_id')::uuid; wk uuid := nullif(p->>'worker_id', '')::uuid; wname text;
  mode text := coalesce(nullif(p->>'sign_mode', ''), 'counter');
  job text := nullif(p->>'job_order_id', ''); proj uuid := nullif(p->>'project_id', '')::uuid;
  l jsonb; t record; sid uuid; sno text;
begin
  perform public.inv_require_warehouse(wh);
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
end; $$;

-- =====================================================================
-- RETURN  p: {warehouse_id, worker_id, note?, sign_mode, sig_keeper_path, sig_worker_path?,
--             lines:[{tool_id, condition, kit_missing?, photo_path?, note?}]}
-- =====================================================================
create or replace function public.tl_post_return(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  wh uuid := (p->>'warehouse_id')::uuid; wk uuid := nullif(p->>'worker_id', '')::uuid; wname text;
  mode text := coalesce(nullif(p->>'sign_mode', ''), 'counter');
  l jsonb; t record; sid uuid; sno text; cond text; dno text; defects int := 0;
begin
  perform public.inv_require_warehouse(wh);
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
end; $$;

-- =====================================================================
-- HANDOVER (worker → worker on site)
--   p: {from_worker_id, to_worker_id, note?, sig_giver_path, sig_receiver_path, lines:[{tool_id}]}
--   Posted by the giver (both sign on the giver's phone) or by an admin /
--   storekeeper. Both signatures are required — no pending handovers.
-- =====================================================================
create or replace function public.tl_post_handover(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  fw uuid := (p->>'from_worker_id')::uuid; tw uuid := (p->>'to_worker_id')::uuid; fname text; tname text;
  l jsonb; t record; sid uuid; sno text;
begin
  if not (public.is_admin() or public.inv_is_storekeeper() or fw = auth.uid()) then
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
end; $$;

-- The worker signs a pending slip on their own phone.
create or replace function public.tl_sign_slip(p_slip uuid, p_path text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare s record;
begin
  select * into s from public.tool_slips where id = p_slip for update;
  if s is null then raise exception 'Slip not found.' using errcode = 'P0001'; end if;
  if auth.uid() is distinct from (case when s.type = 'issue' then s.to_worker_id else s.from_worker_id end) then
    raise exception 'That slip isn''t yours to sign.' using errcode = '42501';
  end if;
  if s.status = 'complete' then return; end if;
  if coalesce(p_path, '') = '' or not public.tl_own_path(p_path) then raise exception 'Sign to acknowledge.' using errcode = 'P0001'; end if;
  update public.tool_slips set sig_worker_path = p_path where id = p_slip;
  perform public.tl_complete_if_signed(p_slip);
end; $$;

-- =====================================================================
-- DEFECT decision (admin)  p: {defect_id, decision, cause?, repair_vendor?, repair_cost?,
--                              chargeable_to_worker?, status 'open'|'in_repair'|'closed', note?}
--   repair + in_repair → tool "repair";  repair + closed → back to available
--   replace / write_off + closed → tool retired;  no_fault + closed → available
-- =====================================================================
create or replace function public.tl_decide_defect(p jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare d record; dec text := p->>'decision'; st text := coalesce(nullif(p->>'status', ''), 'open'); newst text;
begin
  if not public.is_admin() then raise exception 'Only an admin decides defects.' using errcode = '42501'; end if;
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
end; $$;

-- Admin: lost tool found again / retire without a defect.
create or replace function public.tl_admin_status(p_tool uuid, p_status text, p_note text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare t record;
begin
  if not public.is_admin() then raise exception 'Only an admin can do this.' using errcode = '42501'; end if;
  select * into t from public.tools where id = p_tool for update;
  if t is null then raise exception 'Tool not found.' using errcode = 'P0001'; end if;
  if not ((p_status = 'available' and t.status = 'lost') or (p_status = 'retired' and t.status in ('available', 'lost', 'defective'))) then
    raise exception 'Can''t change % from % to %.', t.asset_tag, t.status, p_status using errcode = 'P0001';
  end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'Give a reason.' using errcode = 'P0001'; end if;
  perform set_config('awes.tl_posting', 'on', true);
  update public.tools set status = p_status where id = p_tool;
  perform public.tl_event(p_tool, case p_status when 'available' then 'Found / back in service' else 'Retired' end, '', p_note);
end; $$;

-- =====================================================================
-- CALIBRATION / INSPECTION  p: {tool_id, type, done_on, result, cert_ref?, note?}
--   pass → next due = done_on + interval;  fail → defect report, out of service
-- =====================================================================
create or replace function public.tl_log_maintenance(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare t record; nd date; dno text;
begin
  select * into t from public.tools where id = (p->>'tool_id')::uuid for update;
  if t is null then raise exception 'Tool not found.' using errcode = 'P0001'; end if;
  if not public.inv_can_handle(t.home_warehouse_id) then raise exception 'Not your warehouse''s tool.' using errcode = '42501'; end if;
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
end; $$;

-- =====================================================================
-- Views without money: storekeepers (their warehouses + tools out from
-- them) and workers (what they hold). Admins read the tables directly.
-- =====================================================================
create or replace view public.tools_view with (security_invoker = false) as
  select t.id, t.asset_tag, t.kind, t.name, t.brand, t.model, t.serial_no, t.category, t.kit_contents, t.home_warehouse_id, t.status, t.condition,
         t.holder_id, t.holder_name, t.current_slip_id, t.job_order_id, t.project_id, t.issued_at, t.due_back, t.warranty_until,
         t.maint_type, t.maint_interval_days, t.next_maint_due, t.notes, t.created_at, t.purchase_date, t.po_no
    from public.tools t
   where public.is_admin() or public.inv_can_handle(t.home_warehouse_id) or t.holder_id = auth.uid();

-- =====================================================================
-- RLS
-- =====================================================================
-- Can the caller see this tool? (security definer: the tools table itself
-- is admin-only, so a policy that simply looked it up would find nothing
-- for storekeepers and workers)
create or replace function public.tl_can_see_tool(p_tool uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.tools t where t.id = p_tool
                  and (public.is_admin() or public.inv_can_handle(t.home_warehouse_id) or t.holder_id = auth.uid()));
$$;
create or replace function public.tl_keeps_tool(p_tool uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.tools t where t.id = p_tool and (public.is_admin() or public.inv_can_handle(t.home_warehouse_id)));
$$;

alter table public.tools enable row level security;
alter table public.tool_slips enable row level security;
alter table public.tool_slip_lines enable row level security;
alter table public.tool_defects enable row level security;
alter table public.tool_maintenance enable row level security;
alter table public.tool_events enable row level security;

drop policy if exists tools_admin on public.tools;
create policy tools_admin on public.tools for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists tl_slips_read on public.tool_slips;
create policy tl_slips_read on public.tool_slips for select to authenticated
  using (public.is_admin() or (warehouse_id is not null and public.inv_can_handle(warehouse_id)) or public.inv_is_storekeeper() and type = 'handover'
         or from_worker_id = auth.uid() or to_worker_id = auth.uid());
drop policy if exists tl_lines_read on public.tool_slip_lines;
create policy tl_lines_read on public.tool_slip_lines for select to authenticated
  using (exists (select 1 from public.tool_slips s where s.id = slip_id and (public.is_admin() or (s.warehouse_id is not null and public.inv_can_handle(s.warehouse_id))
         or public.inv_is_storekeeper() and s.type = 'handover' or s.from_worker_id = auth.uid() or s.to_worker_id = auth.uid())));
drop policy if exists tl_defects_read on public.tool_defects;
create policy tl_defects_read on public.tool_defects for select to authenticated
  using (public.tl_keeps_tool(tool_id) or worker_id = auth.uid());
drop policy if exists tl_maint_read on public.tool_maintenance;
create policy tl_maint_read on public.tool_maintenance for select to authenticated
  using (public.tl_keeps_tool(tool_id));
drop policy if exists tl_events_read on public.tool_events;
create policy tl_events_read on public.tool_events for select to authenticated
  using (public.tl_can_see_tool(tool_id));

grant select, insert, update on public.tools to authenticated;
grant select on public.tool_slips, public.tool_slip_lines, public.tool_defects, public.tool_maintenance, public.tool_events, public.tools_view to authenticated;
grant usage, select on sequence public.tool_tag_seq to authenticated;
revoke all on public.tools, public.tool_slips, public.tool_slip_lines, public.tool_defects, public.tool_maintenance, public.tool_events, public.tools_view from anon;
revoke insert, update, delete on public.tool_slips, public.tool_slip_lines, public.tool_defects, public.tool_maintenance, public.tool_events from authenticated;
revoke delete on public.tools from authenticated;

revoke all on function public.tl_post_issue(jsonb), public.tl_post_return(jsonb), public.tl_post_handover(jsonb), public.tl_sign_slip(uuid, text),
                       public.tl_decide_defect(jsonb), public.tl_admin_status(uuid, text, text), public.tl_log_maintenance(jsonb),
                       public.tl_event(uuid, text, text, text), public.tl_complete_if_signed(uuid) from public, anon;
grant execute on function public.tl_post_issue(jsonb), public.tl_post_return(jsonb), public.tl_post_handover(jsonb), public.tl_sign_slip(uuid, text),
                          public.tl_decide_defect(jsonb), public.tl_admin_status(uuid, text, text), public.tl_log_maintenance(jsonb) to authenticated;

-- Storage: signatures + photos, each person writes only in their own folder
insert into storage.buckets (id, name, public) values ('tool-files', 'tool-files', false) on conflict (id) do nothing;
drop policy if exists tool_files_select on storage.objects;
create policy tool_files_select on storage.objects for select to authenticated
  using (bucket_id = 'tool-files' and (public.is_admin() or public.inv_is_storekeeper() or (storage.foldername(name))[1] = auth.uid()::text));
drop policy if exists tool_files_insert on storage.objects;
create policy tool_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'tool-files' and (storage.foldername(name))[1] = auth.uid()::text);

do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['tools', 'tool_slips', 'tool_defects', 'tool_maintenance'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

NOTIFY pgrst, 'reload schema';

-- =====================================================================
-- Errands — Messenger / Liaison Officer
--
--   Administration › Errands (adm.errands)        the manager screen
--       Edit    create, edit, cancel, assign / replace the messenger
--       Approve approve or decline other departments' requests, close
--               finished errands, manage recurring errands, confirm the
--               stamped copy is back in the office
--   Administration › My Errands (adm.my_errands)  the messenger's screen —
--       give this to the messenger account; anyone with it (Edit) can be
--       assigned errands
--   Any active staff member can REQUEST an errand; Administration approves.
--
--   Flow:  requested → (approved) → open / assigned → in_progress →
--          done → closed          (failed → rescheduled, or cancelled)
--   * Checklist steps can require a photo and / or a signature.
--   * Every start, step, photo, delivery and completion is stamped with
--     the SERVER time and the phone's GPS location (the location is what the
--     phone reports; the time can't be faked).
--   * Transmittal slip TS-YYYY-NNNN: items, receiver's name / position and
--     signature — or a photo of the stamped receiving copy (either counts).
--   * Recurring errands are created automatically (errand_recur_run(),
--     scheduled hourly — see supabase/setup/errands_cron.sql).
--   * Inbox / push: the messenger gets each assignment; Administration gets
--     requests, unassigned, failed, done-to-review and copy-not-returned;
--     an OVERDUE errand alerts Administration's Head and the Super Admin
--     immediately.
--
-- Requires 20261011_01. Safe to re-run.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 1. Access catalog
-- ---------------------------------------------------------------------
insert into public.app_modules (key, department, section, label, sort, approvable, has_limit, is_switch) values
  ('adm.errands',    'administration', 'Administration', 'Errands',                   55, true,  false, false),
  ('adm.my_errands', 'administration', 'Administration', 'My Errands (Messenger)',    56, false, false, false)
on conflict (key) do update set label = excluded.label, sort = excluded.sort, section = excluded.section,
  department = excluded.department, approvable = excluded.approvable;

-- ---------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------
create table if not exists public.errand_counters (
  kind text not null, yr int not null, n int not null default 0, primary key (kind, yr)
);
alter table public.errand_counters enable row level security;
revoke all on public.errand_counters from anon, authenticated;

create or replace function public.errand_next_no(p_kind text, p_prefix text)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare y int := extract(year from (now() at time zone 'Asia/Manila'))::int; v int;
begin
  insert into public.errand_counters (kind, yr, n) values (p_kind, y, 1)
  on conflict (kind, yr) do update set n = public.errand_counters.n + 1 returning n into v;
  return p_prefix || '-' || y || '-' || lpad(v::text, 4, '0');
end $$;
revoke execute on function public.errand_next_no(text, text) from public, anon, authenticated;

create table if not exists public.errands (
  id                 uuid primary key default gen_random_uuid(),
  errand_no          text not null unique,
  title              text not null check (btrim(title) <> ''),
  type               text not null default 'other' check (type in ('deliver','pickup','government','bank','payment','purchase','other')),
  instructions       text not null default '',
  destination        text not null default '',
  address            text not null default '',
  contact_name       text not null default '',
  contact_phone      text not null default '',
  due_at             timestamptz,
  priority           text not null default 'normal' check (priority in ('normal','urgent')),
  status             text not null default 'open'
                     check (status in ('requested','open','assigned','in_progress','done','failed','closed','cancelled')),
  checklist          jsonb not null default '[]' check (jsonb_typeof(checklist) = 'array'),
  items              jsonb not null default '[]' check (jsonb_typeof(items) = 'array'),
  transmittal_required boolean not null default false,
  copy_expected      boolean not null default false,
  cash_amount        numeric(12,2) check (cash_amount is null or cash_amount >= 0),
  cash_note          text not null default '',
  requested_by       uuid references public.profiles(id) on delete set null,
  requested_by_name  text,
  requested_department text,
  requested_at       timestamptz,
  approved_by_name   text,
  approved_at        timestamptz,
  assigned_to        uuid references public.profiles(id) on delete set null,
  assigned_name      text,
  assigned_at        timestamptz,
  seq                int not null default 1,          -- bumps on every (re)assignment / reschedule so alerts fire again
  started_at         timestamptz,
  start_loc          jsonb,
  completed_at       timestamptz,
  completed_loc      jsonb,
  result_note        text not null default '',
  failed_at          timestamptz,
  failed_reason      text not null default '',
  failed_loc         jsonb,
  closed_at          timestamptz,
  closed_by_name     text,
  cancelled_at       timestamptz,
  cancelled_by_name  text,
  cancel_reason      text not null default '',
  recurrence_id      uuid,
  created_by         uuid references public.profiles(id) on delete set null,
  created_by_name    text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists errands_status_idx   on public.errands (status, due_at);
create index if not exists errands_assignee_idx on public.errands (assigned_to, status);
create index if not exists errands_requester_idx on public.errands (requested_by);

create table if not exists public.errand_files (
  id               uuid primary key default gen_random_uuid(),
  errand_id        uuid not null references public.errands(id) on delete cascade,
  step_id          text,
  kind             text not null check (kind in ('proof','attachment','stamped_copy','signature','receipt')),
  path             text not null,
  loc              jsonb,
  taken_at         timestamptz not null default now(),
  uploaded_by      uuid references public.profiles(id) on delete set null,
  uploaded_by_name text
);
create index if not exists errand_files_errand_idx on public.errand_files (errand_id, taken_at);

create table if not exists public.errand_transmittals (
  errand_id                uuid primary key references public.errands(id) on delete cascade,
  transmittal_no           text not null unique,
  to_name                  text not null default '',
  to_org                   text not null default '',
  items                    jsonb not null default '[]',
  note                     text not null default '',
  delivered_at             timestamptz not null default now(),
  delivered_by             uuid references public.profiles(id) on delete set null,
  delivered_by_name        text,
  delivered_loc            jsonb,
  receiver_name            text not null default '',
  receiver_position        text not null default '',
  messenger_signature_path text,
  receiver_signature_path  text,
  stamped_copy_path        text,
  office_received_at       timestamptz,
  office_received_by_name  text
);

create table if not exists public.errand_recurrences (
  id                   uuid primary key default gen_random_uuid(),
  title                text not null check (btrim(title) <> ''),
  type                 text not null default 'other' check (type in ('deliver','pickup','government','bank','payment','purchase','other')),
  instructions         text not null default '',
  destination          text not null default '',
  address              text not null default '',
  contact_name         text not null default '',
  contact_phone        text not null default '',
  checklist            jsonb not null default '[]',
  items                jsonb not null default '[]',
  transmittal_required boolean not null default false,
  copy_expected        boolean not null default false,
  cash_amount          numeric(12,2),
  cash_note            text not null default '',
  priority             text not null default 'normal' check (priority in ('normal','urgent')),
  assign_to            uuid references public.profiles(id) on delete set null,
  freq                 text not null check (freq in ('daily','weekly','monthly','yearly')),
  weekdays             smallint[] not null default '{1,2,3,4,5}',      -- 0 = Sunday … 6 = Saturday (weekly)
  day_of_month         smallint not null default 1 check (day_of_month between 0 and 31),   -- 0 = last day of the month
  month                smallint check (month between 1 and 12),        -- yearly
  due_time             time not null default '10:00',
  lead_days            smallint not null default 1 check (lead_days between 0 and 30),   -- create this many days before it's due
  if_weekend           text not null default 'keep' check (if_weekend in ('keep','before','after')),
  start_date           date not null default current_date,
  end_date             date,
  next_due             date,
  last_created_for     date,
  active               boolean not null default true,
  created_by           uuid references public.profiles(id) on delete set null,
  created_at           timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 3. Helpers
-- ---------------------------------------------------------------------
create or replace function public.errand_is_messenger(p_user uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.staff_access a
                  where a.user_id = p_user and a.module_key = 'adm.my_errands' and a.level >= public.perm_rank('edit')
                    and (a.expires_at is null or a.expires_at > now()))
     and public.staff_is_active(p_user);
$$;

create or replace function public.errand_messengers()
returns table (id uuid, name text) language sql stable security definer set search_path = public, pg_temp as $$
  select p.id, p.name from public.profiles p
   where public.errand_is_messenger(p.id)
     and (public.is_admin() or public.has_perm('adm.errands', 'view'))
   order by p.name;
$$;

-- keep only the fields a location is allowed to carry
create or replace function public.errand_clean_loc(p jsonb)
returns jsonb language sql immutable as $$
  select case when p is not null and jsonb_typeof(p) = 'object' and (p->>'lat') ~ '^-?[0-9.]+$' and (p->>'lng') ~ '^-?[0-9.]+$'
    then jsonb_strip_nulls(jsonb_build_object('lat', (p->>'lat')::numeric, 'lng', (p->>'lng')::numeric,
           'accuracy', nullif(p->>'accuracy', '')::numeric, 'address', left(p->>'address', 300)))
    else null end;
$$;

create or replace function public.errand_clean_checklist(p jsonb, p_old jsonb default '[]')
returns jsonb language plpgsql immutable set search_path = public, pg_temp as $$
declare out jsonb := '[]'; s jsonb; o jsonb; i int := 0; sid text; keep jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'array' then p := '[]'; end if;
  for s in select * from jsonb_array_elements(p) loop
    if coalesce(btrim(s->>'text'), '') = '' then continue; end if;
    i := i + 1;
    sid := nullif(btrim(s->>'id'), '');
    select x into o from jsonb_array_elements(coalesce(p_old, '[]')) x where x->>'id' = sid limit 1;
    if o is not null then
      keep := o;   -- an existing step: its text / requirements / done state stay as they were once done
      if coalesce((o->>'done')::boolean, false) then out := out || jsonb_build_array(o);
      else out := out || jsonb_build_array(jsonb_set(jsonb_set(o, '{text}', to_jsonb(left(btrim(s->>'text'), 200))),
            '{needs_photo}', to_jsonb(coalesce((s->>'needs_photo')::boolean, false)))
            || jsonb_build_object('needs_signature', coalesce((s->>'needs_signature')::boolean, false)));
      end if;
    else
      out := out || jsonb_build_array(jsonb_build_object(
        'id', 's' || to_char(clock_timestamp(), 'MSUS') || i, 'text', left(btrim(s->>'text'), 200),
        'needs_photo', coalesce((s->>'needs_photo')::boolean, false), 'needs_signature', coalesce((s->>'needs_signature')::boolean, false),
        'done', false));
    end if;
    o := null;
  end loop;
  -- completed steps can't be removed
  if exists (select 1 from jsonb_array_elements(coalesce(p_old, '[]')) x
              where coalesce((x->>'done')::boolean, false) and not exists (select 1 from jsonb_array_elements(out) y where y->>'id' = x->>'id')) then
    raise exception 'A step that''s already done can''t be removed.';
  end if;
  return out;
end $$;

create or replace function public.errand_clean_items(p jsonb)
returns jsonb language plpgsql immutable as $$
declare out jsonb := '[]'; s jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'array' then return '[]'; end if;
  for s in select * from jsonb_array_elements(p) loop
    if coalesce(btrim(s->>'description'), '') = '' then continue; end if;
    out := out || jsonb_build_array(jsonb_build_object('qty', left(coalesce(s->>'qty', ''), 20),
      'description', left(btrim(s->>'description'), 300), 'remarks', left(coalesce(s->>'remarks', ''), 200)));
  end loop;
  return out;
end $$;

-- who may open an errand's files
create or replace function public.errand_can_view(p_errand uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public.is_admin() or public.has_perm('adm.errands', 'view')
      or exists (select 1 from public.errands e where e.id = p_errand and (e.assigned_to = auth.uid() or e.requested_by = auth.uid()));
$$;
create or replace function public.errand_storage_ok(p_name text, p_write boolean)
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
declare eid uuid;
begin
  eid := split_part(p_name, '/', 1)::uuid;
  if p_write then
    return public.is_admin() or public.has_perm('adm.errands', 'edit')
        or exists (select 1 from public.errands e where e.id = eid and e.assigned_to = auth.uid() and e.status = 'in_progress');
  end if;
  return public.errand_can_view(eid);
exception when others then return false;
end $$;

create or replace function public.errand_touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists trg_errand_touch on public.errands;
create trigger trg_errand_touch before update on public.errands for each row execute function public.errand_touch();

-- ---------------------------------------------------------------------
-- 4. Staff actions
-- ---------------------------------------------------------------------
-- 4a. Any active staff member requests an errand (Administration approves)
create or replace function public.errand_request(p jsonb)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.profiles; dept text; new_id uuid;
begin
  select * into me from public.profiles where id = auth.uid();
  if me.id is null or me.role not in ('staff', 'admin') or not public.staff_is_active(me.id) and me.role <> 'admin' then
    raise exception 'Only staff can request an errand.' using errcode = '42501';
  end if;
  if coalesce(btrim(p->>'title'), '') = '' then raise exception 'Say what the errand is.'; end if;
  select string_agg(d.name, ', ') into dept from public.staff_departments sd join public.departments d on d.id = sd.department_id where sd.user_id = me.id;
  insert into public.errands (errand_no, title, type, instructions, destination, address, contact_name, contact_phone, due_at, priority,
      checklist, items, transmittal_required, copy_expected, cash_amount, cash_note, status,
      requested_by, requested_by_name, requested_department, requested_at, created_by, created_by_name)
  values (public.errand_next_no('errand', 'ER'), left(btrim(p->>'title'), 200), coalesce(nullif(p->>'type', ''), 'other'),
      left(coalesce(p->>'instructions', ''), 4000), left(coalesce(p->>'destination', ''), 200), left(coalesce(p->>'address', ''), 300),
      left(coalesce(p->>'contact_name', ''), 120), left(coalesce(p->>'contact_phone', ''), 60),
      nullif(p->>'due_at', '')::timestamptz, coalesce(nullif(p->>'priority', ''), 'normal'),
      public.errand_clean_checklist(p->'checklist'), public.errand_clean_items(p->'items'),
      coalesce((p->>'transmittal_required')::boolean, false), coalesce((p->>'copy_expected')::boolean, false),
      nullif(p->>'cash_amount', '')::numeric, left(coalesce(p->>'cash_note', ''), 300), 'requested',
      me.id, me.name, dept, now(), me.id, me.name)
  returning id into new_id;
  return new_id;
end $$;

-- 4b. Administration creates / edits (also reschedules a failed errand)
create or replace function public.errand_save(p_id uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.errands; me text; to_id uuid; new_due timestamptz; new_id uuid; ck jsonb; changed boolean := false;
begin
  if not public.has_perm('adm.errands', 'edit') then raise exception 'You need Administration › Errands › Edit.' using errcode = '42501'; end if;
  if coalesce(btrim(p->>'title'), '') = '' then raise exception 'Say what the errand is.'; end if;
  me := coalesce((select name from public.profiles where id = auth.uid()), 'Administration');
  to_id := nullif(p->>'assigned_to', '')::uuid;
  new_due := nullif(p->>'due_at', '')::timestamptz;
  if to_id is not null and not public.errand_is_messenger(to_id) then raise exception 'That person isn''t set up as a messenger (Administration › My Errands).'; end if;

  if p_id is null then
    insert into public.errands (errand_no, title, type, instructions, destination, address, contact_name, contact_phone, due_at, priority,
        checklist, items, transmittal_required, copy_expected, cash_amount, cash_note, status, assigned_to, assigned_name, assigned_at,
        approved_by_name, approved_at, created_by, created_by_name)
    values (public.errand_next_no('errand', 'ER'), left(btrim(p->>'title'), 200), coalesce(nullif(p->>'type', ''), 'other'),
        left(coalesce(p->>'instructions', ''), 4000), left(coalesce(p->>'destination', ''), 200), left(coalesce(p->>'address', ''), 300),
        left(coalesce(p->>'contact_name', ''), 120), left(coalesce(p->>'contact_phone', ''), 60), new_due, coalesce(nullif(p->>'priority', ''), 'normal'),
        public.errand_clean_checklist(p->'checklist'), public.errand_clean_items(p->'items'),
        coalesce((p->>'transmittal_required')::boolean, false), coalesce((p->>'copy_expected')::boolean, false),
        nullif(p->>'cash_amount', '')::numeric, left(coalesce(p->>'cash_note', ''), 300),
        case when to_id is null then 'open' else 'assigned' end, to_id, (select name from public.profiles where id = to_id), case when to_id is null then null else now() end,
        me, now(), auth.uid(), me)
    returning id into new_id;
    perform public.log_activity_as(auth.uid(), 'create', 'errands', new_id::text, left(p->>'title', 100), '{}'::jsonb);
    return new_id;
  end if;

  select * into e from public.errands where id = p_id for update;
  if e.id is null then raise exception 'That errand no longer exists.'; end if;
  if e.status in ('done', 'closed', 'cancelled') then raise exception 'A % errand can''t be edited.', e.status; end if;
  ck := public.errand_clean_checklist(p->'checklist', e.checklist);
  update public.errands set
      title = left(btrim(p->>'title'), 200), type = coalesce(nullif(p->>'type', ''), type),
      instructions = left(coalesce(p->>'instructions', ''), 4000), destination = left(coalesce(p->>'destination', ''), 200),
      address = left(coalesce(p->>'address', ''), 300), contact_name = left(coalesce(p->>'contact_name', ''), 120),
      contact_phone = left(coalesce(p->>'contact_phone', ''), 60), due_at = new_due, priority = coalesce(nullif(p->>'priority', ''), priority),
      checklist = ck, items = public.errand_clean_items(p->'items'),
      transmittal_required = coalesce((p->>'transmittal_required')::boolean, transmittal_required),
      copy_expected = coalesce((p->>'copy_expected')::boolean, copy_expected),
      cash_amount = nullif(p->>'cash_amount', '')::numeric, cash_note = left(coalesce(p->>'cash_note', ''), 300)
    where id = p_id;
  -- messenger changed, or a failed errand given a new date → (re)assign so the messenger is alerted again
  if e.status <> 'requested' and (to_id is distinct from e.assigned_to or (e.status = 'failed') or new_due is distinct from e.due_at) then
    update public.errands set
        assigned_to = to_id, assigned_name = (select name from public.profiles where id = to_id),
        assigned_at = case when to_id is distinct from e.assigned_to or e.status = 'failed' then now() else assigned_at end,
        status = case when to_id is null then 'open' when e.status = 'in_progress' and to_id is not distinct from e.assigned_to then 'in_progress' else 'assigned' end,
        seq = seq + 1,
        failed_at = null, failed_reason = '', failed_loc = null
      where id = p_id;
  end if;
  perform public.log_activity_as(auth.uid(), 'update', 'errands', p_id::text, left(p->>'title', 100), '{}'::jsonb);
  return p_id;
end $$;

-- 4c. Approve / decline a request, replace the messenger, cancel, close, confirm copy
create or replace function public.errand_approve(p_id uuid, p_assign uuid default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.errands; me text;
begin
  if not public.has_perm('adm.errands', 'approve') then raise exception 'You need Errands › Approve to approve requests.' using errcode = '42501'; end if;
  select * into e from public.errands where id = p_id for update;
  if e.id is null or e.status <> 'requested' then raise exception 'This isn''t a pending request.'; end if;
  if p_assign is not null and not public.errand_is_messenger(p_assign) then raise exception 'That person isn''t set up as a messenger.'; end if;
  me := coalesce((select name from public.profiles where id = auth.uid()), 'Administration');
  update public.errands set status = case when p_assign is null then 'open' else 'assigned' end,
      assigned_to = p_assign, assigned_name = (select name from public.profiles where id = p_assign),
      assigned_at = case when p_assign is null then null else now() end,
      approved_by_name = me, approved_at = now(), seq = seq + 1
    where id = p_id;
  perform public.log_activity_as(auth.uid(), 'approve', 'errands', p_id::text, e.errand_no || ' ' || e.title, '{}'::jsonb);
end $$;

create or replace function public.errand_decline(p_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.errands;
begin
  if not public.has_perm('adm.errands', 'approve') then raise exception 'You need Errands › Approve to decline requests.' using errcode = '42501'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'Say why it''s declined.'; end if;
  select * into e from public.errands where id = p_id for update;
  if e.id is null or e.status <> 'requested' then raise exception 'This isn''t a pending request.'; end if;
  update public.errands set status = 'cancelled', cancelled_at = now(), cancel_reason = left(btrim(p_reason), 500),
      cancelled_by_name = coalesce((select name from public.profiles where id = auth.uid()), 'Administration') where id = p_id;
  perform public.log_activity_as(auth.uid(), 'decline', 'errands', p_id::text, e.errand_no || ' ' || e.title, jsonb_build_object('reason', p_reason));
end $$;

create or replace function public.errand_assign(p_id uuid, p_to uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.errands;
begin
  if not public.has_perm('adm.errands', 'edit') then raise exception 'You need Administration › Errands › Edit.' using errcode = '42501'; end if;
  if p_to is null or not public.errand_is_messenger(p_to) then raise exception 'Choose a messenger.'; end if;
  select * into e from public.errands where id = p_id for update;
  if e.id is null or e.status not in ('open', 'assigned', 'in_progress', 'failed') then raise exception 'This errand can''t be reassigned.'; end if;
  update public.errands set assigned_to = p_to, assigned_name = (select name from public.profiles where id = p_to), assigned_at = now(),
      status = 'assigned', seq = seq + 1, failed_at = null, failed_reason = '', failed_loc = null where id = p_id;
  perform public.log_activity_as(auth.uid(), 'assign', 'errands', p_id::text, e.errand_no || ' ' || e.title,
    jsonb_build_object('from', e.assigned_name, 'to', (select name from public.profiles where id = p_to)));
end $$;

create or replace function public.errand_cancel(p_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.errands;
begin
  if coalesce(btrim(p_reason), '') = '' then raise exception 'Say why it''s cancelled.'; end if;
  select * into e from public.errands where id = p_id for update;
  if e.id is null then raise exception 'That errand no longer exists.'; end if;
  if e.status in ('done', 'closed', 'cancelled') then raise exception 'A % errand can''t be cancelled.', e.status; end if;
  if not (public.has_perm('adm.errands', 'edit') or (e.requested_by = auth.uid() and e.status = 'requested')) then
    raise exception 'You can''t cancel this errand.' using errcode = '42501';
  end if;
  update public.errands set status = 'cancelled', cancelled_at = now(), cancel_reason = left(btrim(p_reason), 500),
      cancelled_by_name = coalesce((select name from public.profiles where id = auth.uid()), 'Administration') where id = p_id;
  perform public.log_activity_as(auth.uid(), 'cancel', 'errands', p_id::text, e.errand_no || ' ' || e.title, jsonb_build_object('reason', p_reason));
end $$;

create or replace function public.errand_close(p_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.errands;
begin
  if not public.has_perm('adm.errands', 'approve') then raise exception 'You need Errands › Approve to close errands.' using errcode = '42501'; end if;
  select * into e from public.errands where id = p_id for update;
  if e.id is null or e.status <> 'done' then raise exception 'Only a finished errand can be closed.'; end if;
  update public.errands set status = 'closed', closed_at = now(),
      closed_by_name = coalesce((select name from public.profiles where id = auth.uid()), 'Administration') where id = p_id;
  perform public.log_activity_as(auth.uid(), 'close', 'errands', p_id::text, e.errand_no || ' ' || e.title, '{}'::jsonb);
end $$;

create or replace function public.errand_confirm_copy(p_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.has_perm('adm.errands', 'edit') then raise exception 'You need Administration › Errands › Edit.' using errcode = '42501'; end if;
  update public.errand_transmittals set office_received_at = now(),
      office_received_by_name = coalesce((select name from public.profiles where id = auth.uid()), 'Administration')
   where errand_id = p_id and office_received_at is null;
  if not found then raise exception 'Nothing to confirm.'; end if;
end $$;

-- ---------------------------------------------------------------------
-- 5. Messenger actions (the assigned person only)
-- ---------------------------------------------------------------------
create or replace function public.errand_mine(p_id uuid, p_states text[])
returns public.errands language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.errands;
begin
  select * into e from public.errands where id = p_id for update;
  if e.id is null then raise exception 'That errand no longer exists.'; end if;
  if e.assigned_to is distinct from auth.uid() then raise exception 'This errand isn''t assigned to you.' using errcode = '42501'; end if;
  if not (e.status = any(p_states)) then raise exception 'This errand is % — it can''t be done from here now.', e.status; end if;
  return e;
end $$;
revoke execute on function public.errand_mine(uuid, text[]) from public, anon, authenticated;

create or replace function public.errand_start(p_id uuid, p_loc jsonb default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.errands;
begin
  e := public.errand_mine(p_id, array['assigned']);
  update public.errands set status = 'in_progress', started_at = now(), start_loc = public.errand_clean_loc(p_loc) where id = p_id;
end $$;

create or replace function public.errand_step(p_id uuid, p_step text, p_done boolean, p_loc jsonb default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.errands; s jsonb; new_list jsonb := '[]'; hit boolean := false; me text;
begin
  e := public.errand_mine(p_id, array['in_progress']);
  me := coalesce((select name from public.profiles where id = auth.uid()), '');
  for s in select * from jsonb_array_elements(e.checklist) loop
    if s->>'id' = p_step then
      hit := true;
      if p_done then
        if coalesce((s->>'needs_photo')::boolean, false)
           and not exists (select 1 from public.errand_files f where f.errand_id = p_id and f.step_id = p_step and f.kind = 'proof') then
          raise exception 'Take a photo for this step first.';
        end if;
        if coalesce((s->>'needs_signature')::boolean, false)
           and not exists (select 1 from public.errand_files f where f.errand_id = p_id and f.step_id = p_step and f.kind = 'signature') then
          raise exception 'Get the signature for this step first.';
        end if;
        s := s || jsonb_build_object('done', true, 'done_at', now(), 'done_by', me, 'done_loc', public.errand_clean_loc(p_loc));
      else
        s := (s - 'done_at' - 'done_by' - 'done_loc') || jsonb_build_object('done', false);
      end if;
    end if;
    new_list := new_list || jsonb_build_array(s);
  end loop;
  if not hit then raise exception 'That step isn''t on this errand.'; end if;
  update public.errands set checklist = new_list where id = p_id;
end $$;

create or replace function public.errand_add_file(p_id uuid, p_path text, p_kind text, p_step text default null, p_loc jsonb default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.errands; fid uuid; ok boolean;
begin
  select * into e from public.errands where id = p_id;
  if e.id is null then raise exception 'That errand no longer exists.'; end if;
  ok := (e.assigned_to = auth.uid() and e.status = 'in_progress')
     or ((public.is_admin() or public.has_perm('adm.errands', 'edit')) and e.status not in ('cancelled'));
  if not ok then raise exception 'Files can only be added while the errand is in progress.' using errcode = '42501'; end if;
  if p_path is null or left(p_path, 37) <> p_id::text || '/' then raise exception 'Bad file path.'; end if;
  insert into public.errand_files (errand_id, step_id, kind, path, loc, uploaded_by, uploaded_by_name)
  values (p_id, nullif(p_step, ''), p_kind, p_path, public.errand_clean_loc(p_loc), auth.uid(),
          coalesce((select name from public.profiles where id = auth.uid()), '')) returning id into fid;
  return fid;
end $$;

-- hand over: creates the numbered transmittal slip
create or replace function public.errand_deliver(p_id uuid, p jsonb)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.errands; no text; me text; sig text; stamp text; msig text;
begin
  e := public.errand_mine(p_id, array['in_progress']);
  if exists (select 1 from public.errand_transmittals where errand_id = p_id) then raise exception 'This errand already has a transmittal slip.'; end if;
  sig   := nullif(p->>'receiver_signature_path', '');
  stamp := nullif(p->>'stamped_copy_path', '');
  msig  := nullif(p->>'messenger_signature_path', '');
  if sig is null and stamp is null then raise exception 'Get the receiver''s signature, or take a photo of the stamped receiving copy.'; end if;
  if (sig is not null and left(sig, 37) <> p_id::text || '/') or (stamp is not null and left(stamp, 37) <> p_id::text || '/')
     or (msig is not null and left(msig, 37) <> p_id::text || '/') then raise exception 'Bad file path.'; end if;
  if sig is not null and coalesce(btrim(p->>'receiver_name'), '') = '' then raise exception 'Enter the receiver''s name.'; end if;
  me := coalesce((select name from public.profiles where id = auth.uid()), '');
  no := public.errand_next_no('transmittal', 'TS');
  insert into public.errand_transmittals (errand_id, transmittal_no, to_name, to_org, items, note, delivered_by, delivered_by_name, delivered_loc,
      receiver_name, receiver_position, messenger_signature_path, receiver_signature_path, stamped_copy_path)
  values (p_id, no, left(coalesce(nullif(p->>'to_name', ''), e.contact_name), 120), left(coalesce(nullif(p->>'to_org', ''), e.destination), 200),
      case when jsonb_array_length(public.errand_clean_items(p->'items')) > 0 then public.errand_clean_items(p->'items') else e.items end,
      left(coalesce(p->>'note', ''), 500), auth.uid(), me, public.errand_clean_loc(p->'loc'),
      left(coalesce(p->>'receiver_name', ''), 120), left(coalesce(p->>'receiver_position', ''), 120), msig, sig, stamp);
  return no;
end $$;

create or replace function public.errand_complete(p_id uuid, p_note text default '', p_loc jsonb default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.errands; open_steps int;
begin
  e := public.errand_mine(p_id, array['in_progress']);
  select count(*) into open_steps from jsonb_array_elements(e.checklist) s where not coalesce((s->>'done')::boolean, false);
  if open_steps > 0 then raise exception '% checklist step(s) still not done.', open_steps; end if;
  if e.transmittal_required and not exists (select 1 from public.errand_transmittals where errand_id = p_id) then
    raise exception 'Hand over the items and record the transmittal slip first.';
  end if;
  update public.errands set status = 'done', completed_at = now(), completed_loc = public.errand_clean_loc(p_loc), result_note = left(coalesce(p_note, ''), 1000) where id = p_id;
end $$;

create or replace function public.errand_fail(p_id uuid, p_reason text, p_loc jsonb default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.errands;
begin
  if coalesce(btrim(p_reason), '') = '' then raise exception 'Say why it couldn''t be completed.'; end if;
  e := public.errand_mine(p_id, array['assigned', 'in_progress']);
  update public.errands set status = 'failed', failed_at = now(), failed_reason = left(btrim(p_reason), 500), failed_loc = public.errand_clean_loc(p_loc) where id = p_id;
end $$;

-- ---------------------------------------------------------------------
-- 6. Recurring errands
-- ---------------------------------------------------------------------
create or replace function public.errand_recur_next(r public.errand_recurrences, p_after date)
returns date language plpgsql immutable set search_path = public, pg_temp as $$
declare d date; i int; ok boolean; dim int; adj date;
begin
  for i in 1 .. 800 loop
    d := p_after + i;
    dim := extract(day from (date_trunc('month', d) + interval '1 month - 1 day'))::int;
    ok := case r.freq
      when 'daily'   then true
      when 'weekly'  then extract(dow from d)::smallint = any(r.weekdays)
      when 'monthly' then extract(day from d)::int = case when r.day_of_month = 0 then dim else least(r.day_of_month, dim) end
      when 'yearly'  then extract(month from d)::int = r.month
                      and extract(day from d)::int = case when r.day_of_month = 0 then dim else least(r.day_of_month, dim) end
      else false end;
    if ok then
      adj := d;
      if r.if_weekend = 'before' and extract(dow from d) = 6 then adj := d - 1;
      elsif r.if_weekend = 'before' and extract(dow from d) = 0 then adj := d - 2;
      elsif r.if_weekend = 'after' and extract(dow from d) = 6 then adj := d + 2;
      elsif r.if_weekend = 'after' and extract(dow from d) = 0 then adj := d + 1; end if;
      if adj > p_after then return adj; end if;
    end if;
  end loop;
  return null;
end $$;

create or replace function public.errand_recurrence_save(p_id uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.errand_recurrences; new_id uuid; wd smallint[]; st date;
begin
  if not public.has_perm('adm.errands', 'approve') then raise exception 'You need Errands › Approve to manage recurring errands.' using errcode = '42501'; end if;
  if coalesce(btrim(p->>'title'), '') = '' then raise exception 'Give the recurring errand a title.'; end if;
  if p->>'freq' not in ('daily', 'weekly', 'monthly', 'yearly') then raise exception 'Choose how often it repeats.'; end if;
  if coalesce(nullif(p->>'assign_to', ''), '') <> '' and not public.errand_is_messenger((p->>'assign_to')::uuid) then raise exception 'That person isn''t set up as a messenger.'; end if;
  select array_agg(distinct x::smallint order by x::smallint) into wd from jsonb_array_elements_text(coalesce(p->'weekdays', '[]')) x where x ~ '^[0-6]$';
  if p->>'freq' = 'weekly' and coalesce(cardinality(wd), 0) = 0 then raise exception 'Pick at least one weekday.'; end if;
  wd := coalesce(wd, '{1,2,3,4,5}');
  if p->>'freq' = 'yearly' and nullif(p->>'month', '') is null then raise exception 'Pick the month.'; end if;
  st := coalesce(nullif(p->>'start_date', '')::date, public.manila_today());
  if p_id is null then
    insert into public.errand_recurrences (title, type, instructions, destination, address, contact_name, contact_phone, checklist, items,
        transmittal_required, copy_expected, cash_amount, cash_note, priority, assign_to, freq, weekdays, day_of_month, month, due_time,
        lead_days, if_weekend, start_date, end_date, created_by)
    values (left(btrim(p->>'title'), 200), coalesce(nullif(p->>'type', ''), 'other'), left(coalesce(p->>'instructions', ''), 4000),
        left(coalesce(p->>'destination', ''), 200), left(coalesce(p->>'address', ''), 300), left(coalesce(p->>'contact_name', ''), 120),
        left(coalesce(p->>'contact_phone', ''), 60), public.errand_clean_checklist(p->'checklist'), public.errand_clean_items(p->'items'),
        coalesce((p->>'transmittal_required')::boolean, false), coalesce((p->>'copy_expected')::boolean, false),
        nullif(p->>'cash_amount', '')::numeric, left(coalesce(p->>'cash_note', ''), 300), coalesce(nullif(p->>'priority', ''), 'normal'),
        nullif(p->>'assign_to', '')::uuid, p->>'freq', wd, coalesce(nullif(p->>'day_of_month', '')::smallint, 1), nullif(p->>'month', '')::smallint,
        coalesce(nullif(p->>'due_time', '')::time, '10:00'), coalesce(nullif(p->>'lead_days', '')::smallint, 1),
        coalesce(nullif(p->>'if_weekend', ''), 'keep'), st, nullif(p->>'end_date', '')::date, auth.uid())
    returning * into r;
    update public.errand_recurrences set next_due = public.errand_recur_next(r, st - 1) where id = r.id;
    return r.id;
  end if;
  update public.errand_recurrences set title = left(btrim(p->>'title'), 200), type = coalesce(nullif(p->>'type', ''), 'other'),
      instructions = left(coalesce(p->>'instructions', ''), 4000), destination = left(coalesce(p->>'destination', ''), 200),
      address = left(coalesce(p->>'address', ''), 300), contact_name = left(coalesce(p->>'contact_name', ''), 120),
      contact_phone = left(coalesce(p->>'contact_phone', ''), 60), checklist = public.errand_clean_checklist(p->'checklist'),
      items = public.errand_clean_items(p->'items'), transmittal_required = coalesce((p->>'transmittal_required')::boolean, false),
      copy_expected = coalesce((p->>'copy_expected')::boolean, false), cash_amount = nullif(p->>'cash_amount', '')::numeric,
      cash_note = left(coalesce(p->>'cash_note', ''), 300), priority = coalesce(nullif(p->>'priority', ''), 'normal'),
      assign_to = nullif(p->>'assign_to', '')::uuid, freq = p->>'freq', weekdays = wd, day_of_month = coalesce(nullif(p->>'day_of_month', '')::smallint, 1),
      month = nullif(p->>'month', '')::smallint, due_time = coalesce(nullif(p->>'due_time', '')::time, '10:00'),
      lead_days = coalesce(nullif(p->>'lead_days', '')::smallint, 1), if_weekend = coalesce(nullif(p->>'if_weekend', ''), 'keep'),
      end_date = nullif(p->>'end_date', '')::date
   where id = p_id returning * into r;
  if r.id is null then raise exception 'That recurring errand no longer exists.'; end if;
  update public.errand_recurrences set next_due = public.errand_recur_next(r, greatest(coalesce(r.last_created_for, r.start_date - 1), public.manila_today() - 1)) where id = r.id;
  return p_id;
end $$;

create or replace function public.errand_recurrence_set(p_id uuid, p_active boolean, p_delete boolean default false)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.has_perm('adm.errands', 'approve') then raise exception 'You need Errands › Approve to manage recurring errands.' using errcode = '42501'; end if;
  if p_delete then delete from public.errand_recurrences where id = p_id;
  else update public.errand_recurrences set active = p_active where id = p_id; end if;
end $$;

-- creates the errands that are due (idempotent — safe to run any time)
create or replace function public.errand_recur_run()
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.errand_recurrences; n int := 0; to_id uuid; due timestamptz; today date := public.manila_today();
begin
  for r in select * from public.errand_recurrences where active and next_due is not null
            and next_due - lead_days <= today and (end_date is null or next_due <= end_date) order by next_due for update skip locked loop
    to_id := case when r.assign_to is not null and public.errand_is_messenger(r.assign_to) then r.assign_to end;
    due := (r.next_due + r.due_time) at time zone 'Asia/Manila';
    insert into public.errands (errand_no, title, type, instructions, destination, address, contact_name, contact_phone, due_at, priority,
        checklist, items, transmittal_required, copy_expected, cash_amount, cash_note, status, assigned_to, assigned_name, assigned_at,
        approved_by_name, approved_at, recurrence_id, created_by_name)
    values (public.errand_next_no('errand', 'ER'), r.title, r.type, r.instructions, r.destination, r.address, r.contact_name, r.contact_phone, due, r.priority,
        (select coalesce(jsonb_agg(jsonb_build_object('id', 's' || ord, 'text', s->>'text', 'needs_photo', coalesce((s->>'needs_photo')::boolean, false),
               'needs_signature', coalesce((s->>'needs_signature')::boolean, false), 'done', false) order by ord), '[]')
           from jsonb_array_elements(r.checklist) with ordinality t(s, ord)),
        r.items, r.transmittal_required, r.copy_expected, r.cash_amount, r.cash_note,
        case when to_id is null then 'open' else 'assigned' end, to_id, (select name from public.profiles where id = to_id),
        case when to_id is null then null else now() end, 'Recurring', now(), r.id, 'Recurring');
    update public.errand_recurrences set last_created_for = r.next_due, next_due = public.errand_recur_next(r, r.next_due) where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;
-- the app calls this when someone opens Errands (a backstop if the hourly job isn't set up)
create or replace function public.errand_recur_run_now()
returns int language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not (public.is_admin() or public.has_perm('adm.errands', 'edit')) then return 0; end if;
  return public.errand_recur_run();
end $$;
revoke execute on function public.errand_recur_run() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 7. Row-level security, storage, grants
-- ---------------------------------------------------------------------
alter table public.errands             enable row level security;
alter table public.errand_files        enable row level security;
alter table public.errand_transmittals enable row level security;
alter table public.errand_recurrences  enable row level security;

drop policy if exists errands_read on public.errands;
create policy errands_read on public.errands for select to authenticated
  using (assigned_to = auth.uid() or requested_by = auth.uid() or (select public.has_perm('adm.errands', 'view')));
drop policy if exists errand_files_read on public.errand_files;
create policy errand_files_read on public.errand_files for select to authenticated using ((select public.errand_can_view(errand_id)));
drop policy if exists errand_transmittals_read on public.errand_transmittals;
create policy errand_transmittals_read on public.errand_transmittals for select to authenticated using ((select public.errand_can_view(errand_id)));
drop policy if exists errand_recurrences_read on public.errand_recurrences;
create policy errand_recurrences_read on public.errand_recurrences for select to authenticated using ((select public.has_perm('adm.errands', 'view')));

-- names for the screens (staff who aren't in Administration)
drop policy if exists profiles_select_for_errands on public.profiles;
create policy profiles_select_for_errands on public.profiles for select to authenticated
  using (role = 'staff' and (select public.has_perm('adm.errands', 'view')));

insert into storage.buckets (id, name, public, file_size_limit) values ('errand-files', 'errand-files', false, 3145728)
on conflict (id) do nothing;
drop policy if exists errand_files_insert on storage.objects;
create policy errand_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'errand-files' and (select public.errand_storage_ok(name, true)));
drop policy if exists errand_files_select on storage.objects;
create policy errand_files_select on storage.objects for select to authenticated
  using (bucket_id = 'errand-files' and (select public.errand_storage_ok(name, false)));

revoke all on public.errands, public.errand_files, public.errand_transmittals, public.errand_recurrences from anon, public;
grant select on public.errands, public.errand_files, public.errand_transmittals, public.errand_recurrences to authenticated;

revoke execute on function public.errand_request(jsonb), public.errand_save(uuid, jsonb), public.errand_approve(uuid, uuid), public.errand_decline(uuid, text),
  public.errand_assign(uuid, uuid), public.errand_cancel(uuid, text), public.errand_close(uuid), public.errand_confirm_copy(uuid),
  public.errand_start(uuid, jsonb), public.errand_step(uuid, text, boolean, jsonb), public.errand_add_file(uuid, text, text, text, jsonb),
  public.errand_deliver(uuid, jsonb), public.errand_complete(uuid, text, jsonb), public.errand_fail(uuid, text, jsonb),
  public.errand_recurrence_save(uuid, jsonb), public.errand_recurrence_set(uuid, boolean, boolean), public.errand_recur_run_now(),
  public.errand_messengers(), public.errand_is_messenger(uuid), public.errand_can_view(uuid), public.errand_storage_ok(text, boolean)
  from public, anon;
grant execute on function public.errand_request(jsonb), public.errand_save(uuid, jsonb), public.errand_approve(uuid, uuid), public.errand_decline(uuid, text),
  public.errand_assign(uuid, uuid), public.errand_cancel(uuid, text), public.errand_close(uuid), public.errand_confirm_copy(uuid),
  public.errand_start(uuid, jsonb), public.errand_step(uuid, text, boolean, jsonb), public.errand_add_file(uuid, text, text, text, jsonb),
  public.errand_deliver(uuid, jsonb), public.errand_complete(uuid, text, jsonb), public.errand_fail(uuid, text, jsonb),
  public.errand_recurrence_save(uuid, jsonb), public.errand_recurrence_set(uuid, boolean, boolean), public.errand_recur_run_now(),
  public.errand_messengers(), public.errand_is_messenger(uuid), public.errand_can_view(uuid), public.errand_storage_ok(text, boolean)
  to authenticated, service_role;
revoke execute on function public.errand_recur_next(public.errand_recurrences, date), public.errand_clean_loc(jsonb),
  public.errand_clean_checklist(jsonb, jsonb), public.errand_clean_items(jsonb), public.errand_touch() from public, anon;

do $$ begin
  if to_regprocedure('public.activity_log_trigger()') is not null then
    drop trigger if exists trg_activity_log on public.errand_recurrences;
    create trigger trg_activity_log after insert or update or delete on public.errand_recurrences
      for each row execute function public.activity_log_trigger();
  end if;
end $$;

commit;

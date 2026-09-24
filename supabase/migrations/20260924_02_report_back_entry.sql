-- ---------------------------------------------------------------------
-- Service Reports: "Record Past Service" (admin back-entry)
--
-- Rebuild of the lost 20260919_01_report_back_entry.sql. Safe to run
-- whether or not that older file was ever applied (everything here is
-- add-if-missing / create-or-replace).
--
-- Why an RPC: a report carries the technician's name, and RLS only lets a
-- user insert a report under their own id (reports_insert_own). Admin is
-- recording work a technician already did, so it goes through
--   public.admin_record_past_service(p_report jsonb) -> sr_no
-- which (a) only admins can call, (b) files it under the chosen
-- technician, (c) leaves both signatures blank, and (d) stamps who keyed
-- it in and when (back_entry / entered_by / entered_by_name / entered_at).
-- Those stamp columns can't be set or cleared any other way, so a back
-- entry can never pass for a report signed on site, and a normal report
-- can never be dressed up as one.
-- ---------------------------------------------------------------------

alter table public.service_reports
  add column if not exists back_entry      boolean not null default false,
  add column if not exists entered_by      uuid references public.profiles(id),
  add column if not exists entered_by_name text,
  add column if not exists entered_at      timestamptz;

-- Stamp columns are owned by the RPC below. It is SECURITY DEFINER, so
-- inside it current_user is the function owner; app clients always run as
-- anon / authenticated and can never pass this check (a session setting
-- would not do — any client can set those).
create or replace function public.service_reports_guard_back_entry()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;   -- the RPC below, or the SQL editor / service role
  end if;
  if tg_op = 'INSERT' then
    new.back_entry := false; new.entered_by := null;
    new.entered_by_name := null; new.entered_at := null;
  else
    new.back_entry := old.back_entry; new.entered_by := old.entered_by;
    new.entered_by_name := old.entered_by_name; new.entered_at := old.entered_at;
  end if;
  return new;
end;
$$;
drop trigger if exists service_reports_guard_back_entry on public.service_reports;
create trigger service_reports_guard_back_entry
  before insert or update on public.service_reports
  for each row execute function public.service_reports_guard_back_entry();

create or replace function public.admin_record_past_service(p_report jsonb)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r        public.service_reports;
  v_tech   public.profiles;
  v_admin  text;
  v_sr     text;
  v_json   jsonb;
  v_cols   text;
begin
  if not public.is_admin() then
    raise exception 'Only admin can record past service.' using errcode = '42501';
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
$$;
revoke all on function public.admin_record_past_service(jsonb) from public, anon;
grant execute on function public.admin_record_past_service(jsonb) to authenticated;

create index if not exists service_reports_back_entry_idx
  on public.service_reports (entered_at desc) where back_entry;

NOTIFY pgrst, 'reload schema';

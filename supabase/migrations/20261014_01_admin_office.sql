-- =====================================================================
-- Administration: Permits & Licenses, Vehicles, Contracts, Bills &
-- Utilities, Office Assets (and Announcements moves to Administration)
--
--   Pages (Department Staff access, Administration department)
--     adm.permits     Permits & Licenses   register + expiry alerts
--     adm.vehicles    Vehicles             register, trip tickets, fuel,
--                                          service (PMS), OR/CR & insurance
--     adm.contracts   Contracts            customer PMS / service, supplier,
--                                          lease — renewal alerts
--     adm.bills       Bills & Utilities    accounts, monthly bills, paid
--                                          status; send the messenger to pay
--     adm.assets      Office Assets        laptops / phones / printers …
--                                          issued to staff, returns
--   View = see; Edit = add / change. Files (scans, OR/CR, receipts) go to
--   the private 'admin-docs' bucket, readable with the page's View access.
--
--   Alerts (Inbox, Needs you now, push to whoever has the page):
--     permit_expiring    expires within its lead time (default 60 days) or expired
--     vehicle_due        registration / insurance within 30 days, PMS due,
--                        or a trip still out after 12 hours
--     contract_expiring  ends within its lead time (default 30 days)
--     bill_due           unpaid, due within 3 days or overdue
--     asset_unreturned   an asset still issued to a deactivated person
--
-- Requires 20261012_02_errands_alerts.sql. Safe to re-run.
-- =====================================================================
begin;

insert into public.app_modules (key, department, section, label, sort, approvable, has_limit, is_switch) values
  ('adm.permits',   'administration', 'Administration', 'Permits & Licenses', 62, false, false, false),
  ('adm.vehicles',  'administration', 'Administration', 'Vehicles',           63, false, false, false),
  ('adm.contracts', 'administration', 'Administration', 'Contracts',          64, false, false, false),
  ('adm.bills',     'administration', 'Administration', 'Bills & Utilities',  65, false, false, false),
  ('adm.assets',    'administration', 'Administration', 'Office Assets',      66, false, false, false)
on conflict (key) do update set label = excluded.label, section = excluded.section, sort = excluded.sort, department = excluded.department;
update public.app_modules set section = 'Administration', label = 'Memos & Announcements' where key = 'adm.announcements';

create or replace function public.adm_touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); if tg_op = 'INSERT' then new.created_by := coalesce(new.created_by, auth.uid()); end if; return new; end $$;

-- ---- Permits & Licenses -----------------------------------------------------
create table if not exists public.adm_permits (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null default 'other',
  name          text not null check (btrim(name) <> ''),
  number        text not null default '',
  issuer        text not null default '',
  issued_on     date,
  expires_on    date,
  lead_days     int  not null default 60 check (lead_days between 0 and 365),
  cost          numeric(12,2),
  holder        text not null default '',     -- office / branch / person it covers
  notes         text not null default '',
  active        boolean not null default true,
  created_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ---- Vehicles ----------------------------------------------------------------
create table if not exists public.adm_vehicles (
  id                uuid primary key default gen_random_uuid(),
  plate_no          text not null check (btrim(plate_no) <> ''),
  make_model        text not null default '',
  year              int,
  kind              text not null default 'van',
  color             text not null default '',
  assigned_to       uuid references public.profiles(id) on delete set null,
  odometer_km       int not null default 0,
  reg_expires_on    date,          -- OR/CR (LTO) registration
  insurance_expires_on date,
  pms_every_km      int,            -- e.g. 5000
  next_pms_on       date,
  next_pms_km       int,
  notes             text not null default '',
  active            boolean not null default true,
  created_by        uuid references public.profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index if not exists adm_vehicles_plate_uq on public.adm_vehicles (upper(plate_no));

create table if not exists public.adm_vehicle_trips (
  id           uuid primary key default gen_random_uuid(),
  vehicle_id   uuid not null references public.adm_vehicles(id) on delete cascade,
  trip_no      text,
  driver_id    uuid references public.profiles(id) on delete set null,
  driver_name  text not null default '',
  purpose      text not null default '',
  destination  text not null default '',
  reference    text not null default '',      -- job order / errand no.
  out_at       timestamptz not null default now(),
  km_out       int not null check (km_out >= 0),
  in_at        timestamptz,
  km_in        int,
  status       text not null default 'out' check (status in ('out','returned','cancelled')),
  notes        text not null default '',
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (km_in is null or km_in >= km_out)
);
create index if not exists adm_vehicle_trips_idx on public.adm_vehicle_trips (vehicle_id, out_at desc);

create table if not exists public.adm_vehicle_fuel (
  id           uuid primary key default gen_random_uuid(),
  vehicle_id   uuid not null references public.adm_vehicles(id) on delete cascade,
  filled_on    date not null default current_date,
  liters       numeric(8,2) check (liters is null or liters > 0),
  amount       numeric(12,2) not null check (amount >= 0),
  odometer_km  int,
  station      text not null default '',
  filled_by    text not null default '',
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.adm_vehicle_service (
  id            uuid primary key default gen_random_uuid(),
  vehicle_id    uuid not null references public.adm_vehicles(id) on delete cascade,
  serviced_on   date not null default current_date,
  odometer_km   int,
  work          text not null check (btrim(work) <> ''),
  shop          text not null default '',
  cost          numeric(12,2),
  next_due_on   date,
  next_due_km   int,
  created_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- keep the vehicle's odometer / next PMS in step with trips and service
create or replace function public.adm_vehicle_sync() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare km int;
begin
  if tg_table_name = 'adm_vehicle_trips' then
    if new.trip_no is null then new.trip_no := 'TT-' || to_char(now() at time zone 'Asia/Manila', 'YYYY') || '-' || lpad(nextval('public.adm_trip_seq')::text, 4, '0'); end if;
    if new.status = 'returned' and new.km_in is not null then
      if new.in_at is null then new.in_at := now(); end if;
      update public.adm_vehicles set odometer_km = greatest(odometer_km, new.km_in) where id = new.vehicle_id;
    end if;
    if tg_op = 'INSERT' and new.status = 'out' and exists (select 1 from public.adm_vehicle_trips t where t.vehicle_id = new.vehicle_id and t.status = 'out') then
      raise exception 'This vehicle is already out on a trip — close that trip first.';
    end if;
  elsif tg_table_name = 'adm_vehicle_fuel' then
    if new.odometer_km is not null then update public.adm_vehicles set odometer_km = greatest(odometer_km, new.odometer_km) where id = new.vehicle_id; end if;
  elsif tg_table_name = 'adm_vehicle_service' then
    km := new.odometer_km;
    update public.adm_vehicles v set odometer_km = greatest(v.odometer_km, coalesce(km, 0)),
           next_pms_on = coalesce(new.next_due_on, v.next_pms_on),
           next_pms_km = coalesce(new.next_due_km, case when km is not null and v.pms_every_km is not null then km + v.pms_every_km end, v.next_pms_km)
     where v.id = new.vehicle_id;
  end if;
  new.updated_at := now();
  if tg_op = 'INSERT' then new.created_by := coalesce(new.created_by, auth.uid()); end if;
  return new;
end $$;
create sequence if not exists public.adm_trip_seq;

-- ---- Contracts ------------------------------------------------------------
create table if not exists public.adm_contracts (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null default 'customer_pms',
  title         text not null check (btrim(title) <> ''),
  party_name    text not null default '',
  customer_id   uuid references public.customers(id) on delete set null,
  supplier_id   uuid references public.suppliers(id) on delete set null,
  contract_no   text not null default '',
  value         numeric(14,2),
  billing       text not null default '',     -- e.g. monthly, quarterly, one-time
  start_on      date,
  end_on        date,
  lead_days     int not null default 30 check (lead_days between 0 and 365),
  auto_renew    boolean not null default false,
  status        text not null default 'active' check (status in ('draft','active','renewed','ended','cancelled')),
  notes         text not null default '',
  created_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ---- Bills & Utilities ---------------------------------------------------------
create table if not exists public.adm_bill_accounts (
  id              uuid primary key default gen_random_uuid(),
  name            text not null check (btrim(name) <> ''),    -- e.g. "Meralco — Main office"
  category        text not null default 'electricity',
  provider        text not null default '',
  account_no      text not null default '',
  due_day         int check (due_day between 1 and 31),
  usual_amount    numeric(12,2),
  pay_at          text not null default '',      -- where / how it's paid
  send_messenger  boolean not null default false,
  messenger_id    uuid references public.profiles(id) on delete set null,
  active          boolean not null default true,
  notes           text not null default '',
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists public.adm_bills (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references public.adm_bill_accounts(id) on delete cascade,
  period        date not null,                  -- first day of the billing month
  due_on        date not null,
  amount        numeric(12,2),
  status        text not null default 'unpaid' check (status in ('unpaid','paid','cancelled')),
  paid_on       date,
  paid_amount   numeric(12,2),
  reference     text not null default '',
  paid_by_name  text not null default '',
  errand_id     uuid references public.errands(id) on delete set null,
  notes         text not null default '',
  created_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (account_id, period)
);

-- this month's (and next month's, a week ahead) bills for every active account
create or replace function public.adm_bills_generate()
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare a record; m date; d date; n int := 0; today date := public.manila_today(); last_day int;
begin
  if not (public.has_perm('adm.bills', 'view') or current_user not in ('anon', 'authenticated')) then return 0; end if;
  for a in select * from public.adm_bill_accounts where active and due_day is not null loop
    foreach m in array array[date_trunc('month', today)::date, (date_trunc('month', today) + interval '1 month')::date] loop
      last_day := extract(day from (m + interval '1 month - 1 day'))::int;
      d := m + (least(a.due_day, last_day) - 1);
      continue when d - today > 10;                          -- only up to ~10 days ahead
      insert into public.adm_bills (account_id, period, due_on, amount) values (a.id, m, d, a.usual_amount)
      on conflict (account_id, period) do nothing;
      if found then n := n + 1; end if;
    end loop;
  end loop;
  return n;
end $$;

-- send the messenger to pay a bill (creates an errand, assigned if a messenger is set)
create or replace function public.adm_bill_send_errand(p_bill uuid, p_messenger uuid default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.adm_bills; a public.adm_bill_accounts; to_id uuid; new_id uuid; me text;
begin
  if not public.has_perm('adm.bills', 'edit') then raise exception 'You need Bills & Utilities › Edit.' using errcode = '42501'; end if;
  select * into b from public.adm_bills where id = p_bill for update;
  if b.id is null then raise exception 'That bill no longer exists.'; end if;
  if b.status <> 'unpaid' then raise exception 'This bill is %.', b.status; end if;
  if b.errand_id is not null and exists (select 1 from public.errands where id = b.errand_id and status not in ('cancelled','failed')) then
    raise exception 'A messenger errand already exists for this bill.';
  end if;
  select * into a from public.adm_bill_accounts where id = b.account_id;
  to_id := coalesce(p_messenger, a.messenger_id);
  if to_id is not null and not exists (select 1 from public.staff_access x where x.user_id = to_id and x.module_key = 'adm.my_errands'
                                         and (x.expires_at is null or x.expires_at > now())) then
    raise exception 'That person isn''t set up as a messenger.';
  end if;
  me := coalesce((select name from public.profiles where id = auth.uid()), 'Admin');
  insert into public.errands (errand_no, title, type, instructions, destination, due_at, priority, checklist, items,
      transmittal_required, copy_expected, cash_amount, cash_note, status, assigned_to, assigned_name, assigned_at,
      approved_by_name, approved_at, created_by, created_by_name)
  values (public.errand_next_no('errand', 'ER'), 'Pay ' || a.name || ' — ' || to_char(b.period, 'Mon YYYY'), 'payment',
      'Account no. ' || coalesce(nullif(a.account_no, ''), '—') || '. Pay the bill and bring back the official receipt.' ||
        case when a.pay_at <> '' then E'\nPay at: ' || a.pay_at else '' end,
      a.provider, (b.due_on + time '15:00') at time zone 'Asia/Manila', 'normal',
      jsonb_build_array(jsonb_build_object('id', gen_random_uuid()::text, 'text', 'Pay the bill', 'needs_photo', false, 'needs_signature', false, 'done', false),
                        jsonb_build_object('id', gen_random_uuid()::text, 'text', 'Photo of the official receipt', 'needs_photo', true, 'needs_signature', false, 'done', false)),
      '[]'::jsonb, false, false, b.amount, 'Bill payment', case when to_id is null then 'open' else 'assigned' end,
      to_id, (select name from public.profiles where id = to_id), case when to_id is null then null else now() end, me, now(), auth.uid(), me)
  returning id into new_id;
  update public.adm_bills set errand_id = new_id where id = b.id;
  return new_id;
end $$;

-- ---- Office Assets -------------------------------------------------------------
create sequence if not exists public.adm_asset_seq;
create table if not exists public.adm_assets (
  id            uuid primary key default gen_random_uuid(),
  asset_tag     text unique,
  category      text not null default 'laptop',
  name          text not null check (btrim(name) <> ''),
  brand_model   text not null default '',
  serial_no     text not null default '',
  purchased_on  date,
  cost          numeric(12,2),
  status        text not null default 'available' check (status in ('available','issued','repair','retired','lost')),
  holder_id     uuid references public.profiles(id) on delete set null,
  holder_name   text not null default '',
  issued_on     date,
  notes         text not null default '',
  created_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create table if not exists public.adm_asset_events (
  id          bigint generated always as identity primary key,
  asset_id    uuid not null references public.adm_assets(id) on delete cascade,
  at          timestamptz not null default now(),
  action      text not null,
  holder_name text not null default '',
  note        text not null default '',
  by_name     text not null default ''
);
create or replace function public.adm_asset_sync() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare who text := coalesce((select name from public.profiles where id = auth.uid()), 'Admin');
begin
  if new.asset_tag is null then new.asset_tag := 'OA-' || lpad(nextval('public.adm_asset_seq')::text, 4, '0'); end if;
  if new.holder_id is not null then
    new.holder_name := coalesce((select name from public.profiles where id = new.holder_id), new.holder_name);
    new.status := 'issued';
    if tg_op = 'INSERT' or old.holder_id is distinct from new.holder_id then new.issued_on := coalesce(new.issued_on, current_date); end if;
  else
    if new.status = 'issued' then new.status := 'available'; end if;
    new.holder_name := ''; new.issued_on := null;
  end if;
  new.updated_at := now();
  if tg_op = 'INSERT' then new.created_by := coalesce(new.created_by, auth.uid()); end if;
  return new;
end $$;
create or replace function public.adm_asset_log() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare who text := coalesce((select name from public.profiles where id = auth.uid()), 'Admin');
begin
  if tg_op = 'INSERT' then
    insert into public.adm_asset_events (asset_id, action, holder_name, by_name) values (new.id, 'added', new.holder_name, who);
    if new.holder_id is not null then insert into public.adm_asset_events (asset_id, action, holder_name, by_name) values (new.id, 'issued', new.holder_name, who); end if;
  else
    if old.holder_id is distinct from new.holder_id then
      if old.holder_id is not null then insert into public.adm_asset_events (asset_id, action, holder_name, by_name) values (new.id, 'returned', old.holder_name, who); end if;
      if new.holder_id is not null then insert into public.adm_asset_events (asset_id, action, holder_name, by_name) values (new.id, 'issued', new.holder_name, who); end if;
    end if;
    if old.status is distinct from new.status and new.status in ('repair','retired','lost') then
      insert into public.adm_asset_events (asset_id, action, note, by_name) values (new.id, new.status, new.notes, who);
    end if;
  end if;
  return null;
end $$;

-- ---- files (scans, OR/CR, receipts) -----------------------------------------------
create table if not exists public.adm_files (
  id          uuid primary key default gen_random_uuid(),
  entity      text not null check (entity in ('permit','vehicle','contract','bill','asset')),
  entity_id   uuid not null,
  path        text not null unique,
  name        text not null default '',
  uploaded_by uuid references public.profiles(id) on delete set null,
  uploaded_at timestamptz not null default now()
);
create index if not exists adm_files_idx on public.adm_files (entity, entity_id);
create or replace function public.adm_entity_module(p_entity text) returns text language sql immutable as $$
  select case p_entity when 'permit' then 'adm.permits' when 'vehicle' then 'adm.vehicles' when 'contract' then 'adm.contracts'
                       when 'bill' then 'adm.bills' when 'asset' then 'adm.assets' end;
$$;

-- ---- triggers ------------------------------------------------------------------
do $$ declare t text; begin
  foreach t in array array['adm_permits','adm_vehicles','adm_contracts','adm_bill_accounts','adm_bills'] loop
    execute format('drop trigger if exists trg_%1$s_touch on public.%1$s', t);
    execute format('create trigger trg_%1$s_touch before insert or update on public.%1$s for each row execute function public.adm_touch()', t);
  end loop;
  foreach t in array array['adm_vehicle_trips','adm_vehicle_fuel','adm_vehicle_service'] loop
    execute format('drop trigger if exists trg_%1$s_sync on public.%1$s', t);
    execute format('create trigger trg_%1$s_sync before insert or update on public.%1$s for each row execute function public.adm_vehicle_sync()', t);
  end loop;
end $$;
drop trigger if exists trg_adm_assets_sync on public.adm_assets;
create trigger trg_adm_assets_sync before insert or update on public.adm_assets for each row execute function public.adm_asset_sync();
drop trigger if exists trg_adm_assets_log on public.adm_assets;
create trigger trg_adm_assets_log after insert or update on public.adm_assets for each row execute function public.adm_asset_log();

-- ---- row-level security --------------------------------------------------------
do $$
declare t text; m text;
begin
  foreach t in array array['adm_permits:adm.permits','adm_vehicles:adm.vehicles','adm_vehicle_trips:adm.vehicles','adm_vehicle_fuel:adm.vehicles',
                           'adm_vehicle_service:adm.vehicles','adm_contracts:adm.contracts','adm_bill_accounts:adm.bills','adm_bills:adm.bills',
                           'adm_assets:adm.assets'] loop
    m := split_part(t, ':', 2); t := split_part(t, ':', 1);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select public.has_perm(%L, ''view'')))', t || '_read', t, m);
    execute format('drop policy if exists %I on public.%I', t || '_write', t);
    execute format('create policy %I on public.%I for all to authenticated using ((select public.has_perm(%L, ''edit''))) with check ((select public.has_perm(%L, ''edit'')))', t || '_write', t, m, m);
    execute format('revoke all on public.%I from anon, public', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    if to_regprocedure('public.activity_log_trigger()') is not null then
      execute format('drop trigger if exists trg_activity_log on public.%I', t);
      execute format('create trigger trg_activity_log after insert or update or delete on public.%I for each row execute function public.activity_log_trigger()', t);
    end if;
  end loop;
end $$;
-- a person sees the office assets issued to them
drop policy if exists adm_assets_read_own on public.adm_assets;
create policy adm_assets_read_own on public.adm_assets for select to authenticated using (holder_id = auth.uid());

alter table public.adm_asset_events enable row level security;
drop policy if exists adm_asset_events_read on public.adm_asset_events;
create policy adm_asset_events_read on public.adm_asset_events for select to authenticated using ((select public.has_perm('adm.assets', 'view')));
revoke all on public.adm_asset_events from anon, public;
grant select on public.adm_asset_events to authenticated;

alter table public.adm_files enable row level security;
drop policy if exists adm_files_read on public.adm_files;
create policy adm_files_read on public.adm_files for select to authenticated using (public.has_perm(public.adm_entity_module(entity), 'view'));
drop policy if exists adm_files_write on public.adm_files;
create policy adm_files_write on public.adm_files for all to authenticated
  using (public.has_perm(public.adm_entity_module(entity), 'edit')) with check (public.has_perm(public.adm_entity_module(entity), 'edit'));
revoke all on public.adm_files from anon, public;
grant select, insert, delete on public.adm_files to authenticated;
grant usage on sequence public.adm_trip_seq, public.adm_asset_seq to authenticated;

insert into storage.buckets (id, name, public) values ('admin-docs', 'admin-docs', false) on conflict (id) do nothing;
drop policy if exists "admin docs read" on storage.objects;
create policy "admin docs read" on storage.objects for select to authenticated
  using (bucket_id = 'admin-docs' and public.has_perm(public.adm_entity_module((storage.foldername(name))[1]), 'view'));
drop policy if exists "admin docs write" on storage.objects;
create policy "admin docs write" on storage.objects for insert to authenticated
  with check (bucket_id = 'admin-docs' and public.has_perm(public.adm_entity_module((storage.foldername(name))[1]), 'edit'));
drop policy if exists "admin docs delete" on storage.objects;
create policy "admin docs delete" on storage.objects for delete to authenticated
  using (bucket_id = 'admin-docs' and public.has_perm(public.adm_entity_module((storage.foldername(name))[1]), 'edit'));

revoke execute on function public.adm_bills_generate(), public.adm_bill_send_errand(uuid, uuid) from public, anon;
grant execute on function public.adm_bills_generate(), public.adm_bill_send_errand(uuid, uuid) to authenticated;
revoke execute on function public.adm_vehicle_sync(), public.adm_asset_sync(), public.adm_asset_log() from public, anon, authenticated;

-- ---- Inbox --------------------------------------------------------------------
do $$
declare def text; body text; extra text;
begin
  def := pg_get_functiondef('public.inbox_all_items'::regproc);
  if position('permit_expiring' in def) > 0 then return; end if;
  def := rtrim(def, E' \n\t\r');
  if right(def, 10) <> '$function$' then raise exception 'Unexpected inbox_all_items definition.'; end if;
  body := rtrim(left(def, length(def) - 10), E' \n\t\r;');
  extra := $x$
  -- 20261014_01: Administration
  union all
  select 'permit_expiring', p.id::text, coalesce(nullif(p.number, ''), p.kind),
         p.name || case when p.expires_on < public.manila_today() then ' — EXPIRED ' else ' — expires ' end || to_char(p.expires_on, 'Mon DD, YYYY'),
         (p.expires_on - p.lead_days)::timestamptz, null::uuid
    from public.adm_permits p
   where p.active and p.expires_on is not null and p.expires_on - p.lead_days <= public.manila_today()
  union all
  select 'vehicle_due', v.id::text || ':' || x.what, v.plate_no, x.title, x.since, null::uuid
    from public.adm_vehicles v
    cross join lateral (values
      ('reg',  (v.reg_expires_on is not null and v.reg_expires_on - 30 <= public.manila_today()),
               'Registration (OR/CR) ' || case when v.reg_expires_on < public.manila_today() then 'EXPIRED ' else 'expires ' end || coalesce(to_char(v.reg_expires_on, 'Mon DD'), ''),
               (v.reg_expires_on - 30)::timestamptz),
      ('ins',  (v.insurance_expires_on is not null and v.insurance_expires_on - 30 <= public.manila_today()),
               'Insurance ' || case when v.insurance_expires_on < public.manila_today() then 'EXPIRED ' else 'expires ' end || coalesce(to_char(v.insurance_expires_on, 'Mon DD'), ''),
               (v.insurance_expires_on - 30)::timestamptz),
      ('pms',  ((v.next_pms_on is not null and v.next_pms_on - 7 <= public.manila_today()) or (v.next_pms_km is not null and v.odometer_km >= v.next_pms_km - 300)),
               'PMS due' || coalesce(' ' || to_char(v.next_pms_on, 'Mon DD'), '') || coalesce(' / ' || v.next_pms_km || ' km (now ' || v.odometer_km || ' km)', ''),
               coalesce((v.next_pms_on - 7)::timestamptz, now())),
      ('trip', exists (select 1 from public.adm_vehicle_trips t where t.vehicle_id = v.id and t.status = 'out' and t.out_at < now() - interval '12 hours'),
               'Still out on a trip since ' || coalesce((select to_char(min(t.out_at) at time zone 'Asia/Manila', 'Mon DD HH12:MI AM') from public.adm_vehicle_trips t where t.vehicle_id = v.id and t.status = 'out'), ''),
               coalesce((select min(t.out_at) + interval '12 hours' from public.adm_vehicle_trips t where t.vehicle_id = v.id and t.status = 'out'), now()))
    ) as x(what, due, title, since)
   where v.active and x.due
  union all
  select 'contract_expiring', c.id::text, coalesce(nullif(c.contract_no, ''), c.kind),
         c.title || ' (' || c.party_name || ')' || case when c.end_on < public.manila_today() then ' — ENDED ' else ' — ends ' end || to_char(c.end_on, 'Mon DD, YYYY'),
         (c.end_on - c.lead_days)::timestamptz, null::uuid
    from public.adm_contracts c
   where c.status = 'active' and c.end_on is not null and c.end_on - c.lead_days <= public.manila_today()
  union all
  select 'bill_due', b.id::text, a.name,
         to_char(b.period, 'Mon YYYY') || case when b.due_on < public.manila_today() then ' — OVERDUE, was due ' else ' — due ' end || to_char(b.due_on, 'Mon DD') ||
           coalesce(' · ₱' || to_char(b.amount, 'FM999,999,990.00'), ''),
         (b.due_on - 3)::timestamptz, null::uuid
    from public.adm_bills b join public.adm_bill_accounts a on a.id = b.account_id
   where b.status = 'unpaid' and b.due_on - 3 <= public.manila_today()
  union all
  select 'asset_unreturned', s.id::text, s.asset_tag, s.name || ' — still with ' || s.holder_name || ' (account deactivated)',
         coalesce(p.deactivated_at, s.updated_at), null::uuid
    from public.adm_assets s join public.profiles p on p.id = s.holder_id
   where s.status = 'issued' and not p.active$x$;
  execute body || extra || E';\n$function$';
end $$;

insert into public.inbox_sla (kind, label, department, module, level, warn_hours, escalate_hours, active, sort) values
  ('permit_expiring',   'Permit / license expiring',       'administration', 'adm.permits',   'edit', 24 * 14, 24 * 30, true, 64),
  ('vehicle_due',       'Vehicle: registration, insurance, PMS or trip', 'administration', 'adm.vehicles', 'edit', 24 * 3, 24 * 7, true, 65),
  ('contract_expiring', 'Contract ending',                 'administration', 'adm.contracts', 'edit', 24 * 7, 24 * 21, true, 66),
  ('bill_due',          'Bill due',                        'administration', 'adm.bills',     'edit', 48, 72, true, 67),
  ('asset_unreturned',  'Office asset not returned',       'administration', 'adm.assets',    'edit', 24, 72, true, 68)
on conflict (kind) do update set label = excluded.label, department = excluded.department, module = excluded.module, level = excluded.level,
  warn_hours = excluded.warn_hours, escalate_hours = excluded.escalate_hours;

commit;

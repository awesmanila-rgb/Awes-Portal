-- =====================================================================
-- AWES App — Payroll, Phase 2: timesheets from DTR
--
--   HR › Timesheets (module hr.timesheets)
--
--   1. HR opens a pay period (frequency + dates + pay date).
--   2. Build: for everyone on payroll with that frequency, one row per day
--      is made from their DTR (time in/out, OT in/out), approved leave,
--      the holiday list and their rest days.
--   3. Each day is worked out by the database (one trigger, so a rebuild
--      and an HR correction always compute the same way):
--        regular minutes inside the shift, lates (after the grace period),
--        undertime, work on rest days / holidays, OT, night differential
--        (window from the published labor rule), and flags for anything
--        that needs a person: missing time-out, OT not approved, worked
--        while on leave, unknown leave type, time-out before time-in …
--   4. HR reviews each person: approves OT (OT counts only once approved),
--      corrects times with a note (kept in the activity log), marks
--      absences / leave / day-off swaps, then marks the person reviewed.
--   5. Lock (Approve access, password re-entry): needs everyone reviewed
--      and no blocking flags. A locked period can't change; unlocking
--      needs Approve access and a reason. Phase 3 computes pay from the
--      locked totals (payroll_period_totals) and will stop unlocking once
--      a pay run is approved.
--
--   Rebuilding keeps HR's corrections (unless "start over" is chosen) and
--   OT approvals on days whose OT didn't change.
--   Employees can read their own days once the period is locked.
--
-- Requires 20261004_01_payroll_foundation.sql. Safe to re-run.
-- =====================================================================

begin;

do $$ begin
  if to_regclass('public.payroll_employees') is null then
    raise exception 'Run 20261004_01_payroll_foundation.sql first.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. Catalog, settings, leave types
-- ---------------------------------------------------------------------
insert into public.app_modules (key, department, section, label, sort, approvable, has_limit, is_switch) values
  ('hr.timesheets', 'hr', 'HR', 'Timesheets', 45, true, false, false)
on conflict (key) do update set label = excluded.label, sort = excluded.sort, section = excluded.section,
  department = excluded.department, approvable = excluded.approvable;

-- a local holiday (scope = a city) applies when it matches the company's locality
alter table public.payroll_settings add column if not exists holiday_locality text not null default '';

create table if not exists public.payroll_leave_types (
  name     text primary key,
  is_paid  boolean not null default true,
  sort     smallint not null default 0
);
insert into public.payroll_leave_types (name, is_paid, sort) values
  ('Vacation Leave', true, 10), ('Sick Leave', true, 20), ('Emergency Leave', true, 30),
  ('Bereavement Leave', true, 40), ('Maternity Leave', true, 50), ('Paternity Leave', true, 60),
  ('Service Incentive Leave', true, 70), ('Unpaid Leave', false, 80), ('Other', false, 90)
on conflict (name) do nothing;

-- 'Vacation' (older records) matches 'Vacation Leave'; unknown types return NULL
create or replace function public.payroll_leave_paid(p_type text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select is_paid from public.payroll_leave_types where lower(name) = lower(btrim(p_type))),
    (select is_paid from public.payroll_leave_types where lower(name) = lower(btrim(p_type)) || ' leave'));
$$;


-- ---------------------------------------------------------------------
-- 2. Pay periods
-- ---------------------------------------------------------------------
create table if not exists public.payroll_periods (
  id             uuid primary key default gen_random_uuid(),
  pay_frequency  text not null check (pay_frequency in ('WEEKLY','BI_WEEKLY','SEMI_MONTHLY','MONTHLY')),
  period_start   date not null,
  period_end     date not null,
  pay_date       date not null,
  label          text not null default '',
  status         text not null default 'open' check (status in ('open','locked')),
  built_at       timestamptz,
  locked_at      timestamptz,
  locked_by      uuid references public.profiles(id) on delete set null,
  notes          text not null default '',
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  check (period_end >= period_start and period_end - period_start <= 31),
  check (pay_date >= period_start)
);
create unique index if not exists payroll_periods_uq on public.payroll_periods (pay_frequency, period_start);
create index if not exists payroll_periods_dates_idx on public.payroll_periods (period_start desc);

create table if not exists public.payroll_timesheets (
  period_id    uuid not null references public.payroll_periods(id) on delete cascade,
  profile_id   uuid not null references public.profiles(id) on delete cascade,
  reviewed_by  uuid references public.profiles(id) on delete set null,
  reviewed_at  timestamptz,
  primary key (period_id, profile_id)
);

create table if not exists public.payroll_timesheet_days (
  id               uuid primary key default gen_random_uuid(),
  period_id        uuid not null references public.payroll_periods(id) on delete cascade,
  profile_id       uuid not null references public.profiles(id) on delete cascade,
  work_date        date not null,
  -- inputs (from DTR / leave / holidays at build, or HR's correction)
  is_rest_day      boolean not null default false,
  holiday_kind     text check (holiday_kind in ('REGULAR','SPECIAL_NON_WORKING','SPECIAL_WORKING')),
  holiday_name     text not null default '',
  time_in          timestamptz,
  time_out         timestamptz,
  ot_in            timestamptz,
  ot_out           timestamptz,
  leave_type       text,
  leave_paid       boolean,
  hr_status        text check (hr_status in ('absent','leave_paid','leave_unpaid','day_off','workday')),
  ot_approved_min  integer check (ot_approved_min is null or ot_approved_min >= 0),
  ot_approved_by   uuid references public.profiles(id) on delete set null,
  dtr_snapshot     jsonb,
  adjusted         boolean not null default false,
  adjusted_by      uuid references public.profiles(id) on delete set null,
  adjusted_at      timestamptz,
  adjust_note      text not null default '',
  -- worked out by payroll_ts_day_compute()
  status           text not null default 'absent'
                   check (status in ('present','incomplete','absent','leave','rest','holiday','not_hired','upcoming')),
  day_type         text not null default 'ORDINARY'
                   check (day_type in ('ORDINARY','REST_DAY','SPECIAL_HOLIDAY','SPECIAL_HOLIDAY_REST_DAY','HOLIDAY_REGULAR_WORKED','HOLIDAY_REGULAR_REST_DAY')),
  regular_min      integer not null default 0,
  premium_min      integer not null default 0,   -- rest day / holiday work up to a full day
  late_min         integer not null default 0,
  undertime_min    integer not null default 0,
  ot_claimed_min   integer not null default 0,
  ot_paid_min      integer not null default 0,   -- approved, never above claimed
  nd_min           integer not null default 0,
  nd_ot_min        integer not null default 0,
  flags            text[] not null default '{}',
  updated_at       timestamptz not null default now(),
  unique (period_id, profile_id, work_date)
);
create index if not exists payroll_ts_days_person_idx on public.payroll_timesheet_days (profile_id, work_date);

-- flags that stop a period from being locked
create or replace function public.payroll_ts_blocking_flags()
returns text[] language sql immutable as $$
  select array['MISSING_OUT','MISSING_OT_OUT','OT_NOT_APPROVED','TIME_OUT_BEFORE_IN','OT_OUT_BEFORE_IN']::text[];
$$;


-- ---------------------------------------------------------------------
-- 3. Time helpers
-- ---------------------------------------------------------------------
-- DTR stores ISO timestamps (current app) or "HH:MM" (older / admin edits)
create or replace function public.payroll_parse_dtr_time(p_date date, v text)
returns timestamptz language plpgsql immutable set search_path = public, pg_temp as $$
begin
  if v is null or btrim(v) = '' then return null; end if;
  if btrim(v) ~* '^\d{1,2}:\d{2}(:\d{2})?\s*([ap]\.?m\.?)?$' then
    return (p_date + btrim(replace(v, '.', ''))::time) at time zone 'Asia/Manila';
  end if;
  return v::timestamptz;
exception when others then return null;
end $$;

-- minutes of [a, b) that fall inside the nightly window (e.g. 22:00–06:00)
create or replace function public.payroll_nd_minutes(a timestamptz, b timestamptz, w_start time, w_end time)
returns integer language plpgsql immutable set search_path = public, pg_temp as $$
declare d date; ws timestamptz; we timestamptz; total numeric := 0;
begin
  if a is null or b is null or b <= a then return 0; end if;
  for d in select generate_series((a at time zone 'Asia/Manila')::date - 1, (b at time zone 'Asia/Manila')::date, interval '1 day')::date loop
    ws := (d + w_start) at time zone 'Asia/Manila';
    we := (d + w_end) at time zone 'Asia/Manila';
    if w_end <= w_start then we := we + interval '1 day'; end if;
    total := total + greatest(0, extract(epoch from (least(b, we) - greatest(a, ws))) / 60);
  end loop;
  return floor(total)::int;
end $$;

-- the published labor rule in force on a date (fallback: newest of any kind)
create or replace function public.payroll_labor_config(p_date date)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select config from public.payroll_rules
   where kind = 'labor'
   order by (published_at is not null and effective_from <= p_date and (effective_to is null or effective_to >= p_date)) desc,
            (published_at is not null) desc, effective_from desc
   limit 1;
$$;


-- ---------------------------------------------------------------------
-- 4. Working out one day (runs on every insert / update of a day)
-- ---------------------------------------------------------------------
create or replace function public.payroll_ts_day_compute()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  e public.payroll_employees; per public.payroll_periods;
  grace int; lab jsonb; nd_s time; nd_e time;
  s_start timestamptz; s_end timestamptz; hpd int; brk int;
  rest boolean; span int; overlap int; worked int; extra int := 0;
  fl text[] := '{}'; building boolean := coalesce(current_setting('payroll.building', true), '') = 'on';
  who text;
begin
  select * into per from public.payroll_periods where id = new.period_id;
  if per.status = 'locked' then
    raise exception 'This pay period is locked — unlock it first.' using errcode = '42501';
  end if;

  -- a person's correction (not a build): must say why; logged
  if tg_op = 'UPDATE' and not building and (
       new.time_in is distinct from old.time_in or new.time_out is distinct from old.time_out
    or new.ot_in is distinct from old.ot_in or new.ot_out is distinct from old.ot_out
    or new.hr_status is distinct from old.hr_status) then
    if coalesce(btrim(new.adjust_note), '') = '' then
      raise exception 'Say why this day is being corrected.';
    end if;
    new.adjusted := true; new.adjusted_by := auth.uid(); new.adjusted_at := now();
  end if;
  if tg_op = 'UPDATE' and not building and new.ot_approved_min is distinct from old.ot_approved_min then
    new.ot_approved_by := auth.uid();
  end if;

  select * into e from public.payroll_employees where profile_id = new.profile_id;
  select coalesce(grace_minutes, 0) into grace from public.payroll_settings where id = 1;
  grace := coalesce(grace, 0);
  lab := public.payroll_labor_config(new.work_date);
  nd_s := coalesce(nullif(lab->'night_differential'->>'start', ''), '22:00')::time;
  nd_e := coalesce(nullif(lab->'night_differential'->>'end', ''), '06:00')::time;

  hpd := round(coalesce(e.hours_per_day, 8) * 60);
  brk := coalesce(e.break_minutes, 60);
  s_start := (new.work_date + coalesce(e.shift_start, '08:00'::time)) at time zone 'Asia/Manila';
  s_end   := (new.work_date + coalesce(e.shift_end, '17:00'::time)) at time zone 'Asia/Manila';
  if s_end <= s_start then s_end := s_end + interval '1 day'; end if;

  rest := case new.hr_status when 'day_off' then true when 'workday' then false else new.is_rest_day end;

  new.day_type := case
    when new.holiday_kind = 'REGULAR' then case when rest then 'HOLIDAY_REGULAR_REST_DAY' else 'HOLIDAY_REGULAR_WORKED' end
    when new.holiday_kind = 'SPECIAL_NON_WORKING' then case when rest then 'SPECIAL_HOLIDAY_REST_DAY' else 'SPECIAL_HOLIDAY' end
    when rest then 'REST_DAY' else 'ORDINARY' end;

  if new.hr_status in ('leave_paid','leave_unpaid') then new.leave_paid := new.hr_status = 'leave_paid'; end if;

  new.regular_min := 0; new.premium_min := 0; new.late_min := 0; new.undertime_min := 0;
  new.ot_claimed_min := 0; new.ot_paid_min := 0; new.nd_min := 0; new.nd_ot_min := 0;

  -- status
  if e.hire_date is not null and new.work_date < e.hire_date then
    new.status := 'not_hired';
  elsif new.hr_status = 'absent' then
    new.status := 'absent';
  elsif new.hr_status in ('leave_paid','leave_unpaid') then
    new.status := 'leave';
  elsif new.time_in is not null and new.time_out is not null then
    new.status := 'present';
  elsif new.time_in is not null then
    new.status := 'incomplete';
  elsif new.leave_type is not null then
    new.status := 'leave';
  elsif new.holiday_kind in ('REGULAR','SPECIAL_NON_WORKING') then
    new.status := 'holiday';
  elsif rest then
    new.status := 'rest';
  elsif new.work_date >= (now() at time zone 'Asia/Manila')::date then
    new.status := 'upcoming';   -- today or later, nothing recorded yet
  else
    new.status := 'absent';
  end if;

  if new.status = 'incomplete' then fl := array_append(fl, 'MISSING_OUT'); end if;
  if new.leave_type is not null and new.time_in is not null and new.hr_status is null then fl := array_append(fl, 'WORKED_ON_LEAVE'); end if;
  if new.status = 'leave' and new.leave_paid is null then fl := array_append(fl, 'UNKNOWN_LEAVE_TYPE'); end if;

  -- regular segment
  if new.status = 'present' then
    if new.time_out <= new.time_in then
      fl := array_append(fl, 'TIME_OUT_BEFORE_IN');
    else
      span := floor(extract(epoch from (new.time_out - new.time_in)) / 60);
      if span > 16 * 60 then fl := array_append(fl, 'LONG_SHIFT'); end if;
      if new.day_type = 'ORDINARY' then
        overlap := greatest(0, floor(extract(epoch from (least(new.time_out, s_end) - greatest(new.time_in, s_start))) / 60));
        worked := greatest(0, overlap - case when overlap > 300 then brk else 0 end);
        new.regular_min := least(worked, hpd);
        new.late_min := greatest(0, floor(extract(epoch from (new.time_in - s_start)) / 60));
        if new.late_min <= grace then new.late_min := 0; end if;
        new.undertime_min := greatest(0, floor(extract(epoch from (s_end - new.time_out)) / 60));
        if new.late_min > 0 then fl := array_append(fl, 'LATE'); end if;
        if new.undertime_min > 0 then fl := array_append(fl, 'UNDERTIME'); end if;
      else
        worked := greatest(0, span - case when span > 300 then brk else 0 end);
        new.premium_min := least(worked, hpd);
        extra := greatest(0, worked - hpd);   -- beyond a full day on a rest day / holiday is overtime
      end if;
      new.nd_min := least(public.payroll_nd_minutes(new.time_in, new.time_out, nd_s, nd_e), greatest(new.regular_min, new.premium_min));
    end if;
  end if;

  -- OT segment
  if new.status in ('present','incomplete') or new.ot_in is not null then
    if new.ot_in is not null and new.ot_out is null then
      fl := array_append(fl, 'MISSING_OT_OUT');
    elsif new.ot_in is not null and new.ot_out <= new.ot_in then
      fl := array_append(fl, 'OT_OUT_BEFORE_IN');
    elsif new.ot_in is not null then
      new.ot_claimed_min := floor(extract(epoch from (new.ot_out - new.ot_in)) / 60);
    end if;
  end if;
  new.ot_claimed_min := new.ot_claimed_min + extra;
  if new.status in ('absent','leave','not_hired') then new.ot_claimed_min := 0; end if;
  if new.ot_claimed_min > 0 then
    if new.ot_approved_min is null then
      fl := array_append(fl, 'OT_NOT_APPROVED');
    else
      new.ot_paid_min := least(new.ot_approved_min, new.ot_claimed_min);
      new.nd_ot_min := least(public.payroll_nd_minutes(new.ot_in, new.ot_out, nd_s, nd_e), new.ot_paid_min);
    end if;
  end if;

  new.flags := fl;
  new.updated_at := now();

  if tg_op = 'UPDATE' and not building and new.adjusted and (
       new.time_in is distinct from old.time_in or new.time_out is distinct from old.time_out
    or new.ot_in is distinct from old.ot_in or new.ot_out is distinct from old.ot_out
    or new.hr_status is distinct from old.hr_status) then
    select name into who from public.profiles where id = new.profile_id;
    perform public.log_activity_as(auth.uid(), 'update', 'payroll_timesheet_days', new.id::text,
      left(coalesce(who, '') || ' ' || to_char(new.work_date, 'Mon DD, YYYY'), 200),
      jsonb_build_object('note', new.adjust_note,
        'time_in', jsonb_build_object('from', old.time_in, 'to', new.time_in),
        'time_out', jsonb_build_object('from', old.time_out, 'to', new.time_out),
        'ot_in', jsonb_build_object('from', old.ot_in, 'to', new.ot_in),
        'ot_out', jsonb_build_object('from', old.ot_out, 'to', new.ot_out),
        'hr_status', jsonb_build_object('from', old.hr_status, 'to', new.hr_status)));
  end if;
  return new;
end;
$$;
drop trigger if exists trg_payroll_ts_day_compute on public.payroll_timesheet_days;
create trigger trg_payroll_ts_day_compute before insert or update on public.payroll_timesheet_days
  for each row execute function public.payroll_ts_day_compute();

-- a correction clears the person's "reviewed" mark
create or replace function public.payroll_ts_day_after()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if coalesce(current_setting('payroll.building', true), '') <> 'on' then
    update public.payroll_timesheets set reviewed_at = null, reviewed_by = null
     where period_id = new.period_id and profile_id = new.profile_id and reviewed_at is not null;
  end if;
  return null;
end $$;
drop trigger if exists trg_payroll_ts_day_after on public.payroll_timesheet_days;
create trigger trg_payroll_ts_day_after after update on public.payroll_timesheet_days
  for each row execute function public.payroll_ts_day_after();

-- locked periods: days and review marks can't be deleted or changed
create or replace function public.payroll_ts_locked_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare pid uuid := case when tg_op = 'DELETE' then old.period_id else new.period_id end;
begin
  if exists (select 1 from public.payroll_periods where id = pid and status = 'locked') then
    raise exception 'This pay period is locked — unlock it first.' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists trg_payroll_ts_days_locked on public.payroll_timesheet_days;
create trigger trg_payroll_ts_days_locked before delete on public.payroll_timesheet_days
  for each row execute function public.payroll_ts_locked_guard();
drop trigger if exists trg_payroll_timesheets_locked on public.payroll_timesheets;
create trigger trg_payroll_timesheets_locked before insert or update or delete on public.payroll_timesheets
  for each row execute function public.payroll_ts_locked_guard();


-- ---------------------------------------------------------------------
-- 5. Period actions
-- ---------------------------------------------------------------------
create or replace function public.payroll_period_create(
  p_frequency text, p_start date, p_end date, p_pay_date date, p_label text default ''
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare new_id uuid; clash public.payroll_periods;
begin
  if not public.has_perm('hr.timesheets', 'edit') then
    raise exception 'You need Edit access to Timesheets.' using errcode = '42501';
  end if;
  if p_start is null or p_end is null or p_pay_date is null then raise exception 'Enter the period dates and the pay date.'; end if;
  if p_end < p_start then raise exception 'The period ends before it starts.'; end if;
  if p_end - p_start > 31 then raise exception 'A pay period can''t be longer than a month.'; end if;
  if p_pay_date < p_start then raise exception 'The pay date can''t be before the period starts.'; end if;
  select * into clash from public.payroll_periods
   where pay_frequency = p_frequency and period_start <= p_end and period_end >= p_start limit 1;
  if clash.id is not null then
    raise exception 'This overlaps the % – % period.', to_char(clash.period_start, 'Mon DD'), to_char(clash.period_end, 'Mon DD, YYYY');
  end if;
  insert into public.payroll_periods (pay_frequency, period_start, period_end, pay_date, label, created_by)
  values (p_frequency, p_start, p_end, p_pay_date,
          coalesce(nullif(btrim(p_label), ''), to_char(p_start, 'Mon DD') || ' – ' || to_char(p_end, 'Mon DD, YYYY')), auth.uid())
  returning id into new_id;
  return new_id;
end $$;

create or replace function public.payroll_period_delete(p_period uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.has_perm('hr.timesheets', 'edit') then
    raise exception 'You need Edit access to Timesheets.' using errcode = '42501';
  end if;
  if exists (select 1 from public.payroll_periods where id = p_period and status = 'locked') then
    raise exception 'A locked period can''t be deleted — unlock it first.';
  end if;
  delete from public.payroll_periods where id = p_period;
end $$;

-- Build (or rebuild) every day of the period from DTR / leave / holidays.
-- p_reset = true throws away HR's corrections and OT approvals too.
create or replace function public.payroll_period_build(p_period uuid, p_reset boolean default false)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  per public.payroll_periods; e record; d date; dtr jsonb; lv record; hol record;
  loc text; tin timestamptz; tout timestamptz; oin timestamptz; oout timestamptz;
  n_emp int := 0; n_days int := 0; n_kept int := 0; cur public.payroll_timesheet_days;
begin
  if not public.has_perm('hr.timesheets', 'edit') then
    raise exception 'You need Edit access to Timesheets.' using errcode = '42501';
  end if;
  select * into per from public.payroll_periods where id = p_period for update;
  if per.id is null then raise exception 'That pay period no longer exists.'; end if;
  if per.status = 'locked' then raise exception 'This pay period is locked — unlock it first.'; end if;
  perform set_config('payroll.building', 'on', true);
  select coalesce(lower(btrim(holiday_locality)), '') into loc from public.payroll_settings where id = 1;
  loc := coalesce(loc, '');

  -- people no longer in this period (off payroll / other frequency): drop their untouched days
  delete from public.payroll_timesheet_days t
   where t.period_id = p_period and (p_reset or not t.adjusted)
     and not exists (select 1 from public.payroll_employees x where x.profile_id = t.profile_id
                      and x.is_active and x.pay_frequency = per.pay_frequency
                      and (x.hire_date is null or x.hire_date <= per.period_end));
  delete from public.payroll_timesheets s
   where s.period_id = p_period
     and not exists (select 1 from public.payroll_timesheet_days t where t.period_id = p_period and t.profile_id = s.profile_id);

  for e in select x.* from public.payroll_employees x
            where x.is_active and x.pay_frequency = per.pay_frequency
              and (x.hire_date is null or x.hire_date <= per.period_end) loop
    n_emp := n_emp + 1;
    insert into public.payroll_timesheets (period_id, profile_id) values (p_period, e.profile_id)
    on conflict (period_id, profile_id) do update set reviewed_at = null, reviewed_by = null;
    for d in select generate_series(per.period_start, per.period_end, interval '1 day')::date loop
      select r.data into dtr from public.dtr_records r where r.technician_id = e.profile_id and r.date = d;
      tin  := public.payroll_parse_dtr_time(d, dtr->>'timeIn');
      tout := public.payroll_parse_dtr_time(d, dtr->>'timeOut');
      oin  := public.payroll_parse_dtr_time(d, dtr->>'otTimeIn');
      oout := public.payroll_parse_dtr_time(d, dtr->>'otTimeOut');
      -- "HH:MM" times after midnight belong to the next day
      if tin is not null and tout is not null and tout <= tin and coalesce(dtr->>'timeOut', '') ~ '^\s*\d{1,2}:\d{2}' then tout := tout + interval '1 day'; end if;
      if oin is null and oout is not null then oout := null; end if;
      if oin is not null and tin is not null and oin < tin and coalesce(dtr->>'otTimeIn', '') ~ '^\s*\d{1,2}:\d{2}' then oin := oin + interval '1 day'; end if;
      if oin is not null and oout is not null and oout <= oin and coalesce(dtr->>'otTimeOut', '') ~ '^\s*\d{1,2}:\d{2}' then oout := oout + interval '1 day'; end if;

      select coalesce(l.data->>'leaveType', l.data->>'type') as t into lv
        from public.leave_requests l
       where l.technician_id = e.profile_id and l.status = 'approved'
         and public.payroll_try_date(coalesce(l.data->>'dateFrom', l.data->>'from')) <= d
         and coalesce(public.payroll_try_date(coalesce(l.data->>'dateTo', l.data->>'to')),
                      public.payroll_try_date(coalesce(l.data->>'dateFrom', l.data->>'from'))) >= d
       order by l.submitted_at desc limit 1;

      select h.kind, h.name into hol from public.payroll_holidays h
       where h.holiday_date = d and (lower(h.scope) = 'national' or (loc <> '' and lower(h.scope) = loc))
       order by (h.kind = 'REGULAR') desc, (h.kind = 'SPECIAL_NON_WORKING') desc limit 1;

      select * into cur from public.payroll_timesheet_days where period_id = p_period and profile_id = e.profile_id and work_date = d;
      if cur.id is null then
        insert into public.payroll_timesheet_days (period_id, profile_id, work_date, is_rest_day, holiday_kind, holiday_name,
          time_in, time_out, ot_in, ot_out, leave_type, leave_paid, dtr_snapshot)
        values (p_period, e.profile_id, d, extract(dow from d)::smallint = any(e.rest_days), hol.kind, coalesce(hol.name, ''),
          tin, tout, oin, oout, lv.t, case when lv.t is null then null else public.payroll_leave_paid(lv.t) end, dtr);
      elsif cur.adjusted and not p_reset then
        -- keep HR's times and status; refresh the calendar facts
        update public.payroll_timesheet_days set is_rest_day = extract(dow from d)::smallint = any(e.rest_days),
               holiday_kind = hol.kind, holiday_name = coalesce(hol.name, ''), leave_type = lv.t,
               leave_paid = case when cur.hr_status in ('leave_paid','leave_unpaid') then cur.leave_paid
                                 when lv.t is null then null else public.payroll_leave_paid(lv.t) end,
               dtr_snapshot = dtr
         where id = cur.id;
        n_kept := n_kept + 1;
      else
        update public.payroll_timesheet_days set is_rest_day = extract(dow from d)::smallint = any(e.rest_days),
               holiday_kind = hol.kind, holiday_name = coalesce(hol.name, ''),
               time_in = tin, time_out = tout, ot_in = oin, ot_out = oout,
               leave_type = lv.t, leave_paid = case when lv.t is null then null else public.payroll_leave_paid(lv.t) end,
               hr_status = null, adjusted = false, adjusted_by = null, adjusted_at = null, adjust_note = '',
               -- keep an OT approval only if the OT itself didn't change
               ot_approved_min = case when not p_reset and cur.ot_in is not distinct from oin and cur.ot_out is not distinct from oout
                                      then cur.ot_approved_min end,
               dtr_snapshot = dtr
         where id = cur.id;
      end if;
      n_days := n_days + 1;
    end loop;
  end loop;

  update public.payroll_periods set built_at = now() where id = p_period;
  perform public.log_activity_as(auth.uid(), case when p_reset then 'rebuild_reset' else 'build' end, 'payroll_periods', p_period::text, per.label,
    jsonb_build_object('employees', n_emp, 'days', n_days, 'kept_corrections', n_kept));
  perform set_config('payroll.building', 'off', true);
  return jsonb_build_object('employees', n_emp, 'days', n_days, 'kept_corrections', n_kept);
end $$;

create or replace function public.payroll_try_date(v text)
returns date language plpgsql immutable as $$
begin return nullif(btrim(v), '')::date; exception when others then return null; end $$;

create or replace function public.payroll_ts_set_reviewed(p_period uuid, p_profile uuid, p_reviewed boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare bad int;
begin
  if not public.has_perm('hr.timesheets', 'edit') then
    raise exception 'You need Edit access to Timesheets.' using errcode = '42501';
  end if;
  if p_reviewed then
    select count(*) into bad from public.payroll_timesheet_days
     where period_id = p_period and profile_id = p_profile and flags && public.payroll_ts_blocking_flags();
    if bad > 0 then raise exception '% day(s) still need attention (missing time-out or OT not approved).', bad; end if;
  end if;
  update public.payroll_timesheets
     set reviewed_at = case when p_reviewed then now() end, reviewed_by = case when p_reviewed then auth.uid() end
   where period_id = p_period and profile_id = p_profile;
  if not found then raise exception 'This person isn''t in the period — build it first.'; end if;
end $$;

-- approve all claimed OT for one person (or everyone when p_profile is null)
create or replace function public.payroll_ts_approve_ot(p_period uuid, p_profile uuid default null)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  if not public.has_perm('hr.timesheets', 'edit') then
    raise exception 'You need Edit access to Timesheets.' using errcode = '42501';
  end if;
  update public.payroll_timesheet_days set ot_approved_min = ot_claimed_min
   where period_id = p_period and (p_profile is null or profile_id = p_profile)
     and ot_claimed_min > 0 and 'OT_NOT_APPROVED' = any(flags);
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.payroll_period_lock(p_period uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare per public.payroll_periods; n_bad int; n_unrev int; n_people int;
begin
  perform public.staff_approval_assert('hr.timesheets', null, null);
  select * into per from public.payroll_periods where id = p_period for update;
  if per.id is null then raise exception 'That pay period no longer exists.'; end if;
  if per.status = 'locked' then raise exception 'This period is already locked.'; end if;
  if per.built_at is null then raise exception 'Build the timesheets first.'; end if;
  if per.period_end > (now() at time zone 'Asia/Manila')::date then
    raise exception 'The period isn''t over yet — it ends %.', to_char(per.period_end, 'Mon DD, YYYY');
  end if;
  select count(*) into n_people from public.payroll_timesheets where period_id = p_period;
  if n_people = 0 then raise exception 'Nobody is in this period.'; end if;
  select count(*) into n_bad from public.payroll_timesheet_days where period_id = p_period and flags && public.payroll_ts_blocking_flags();
  if n_bad > 0 then raise exception '% day(s) still need attention (missing time-out or OT not approved).', n_bad; end if;
  select count(*) into n_unrev from public.payroll_timesheets where period_id = p_period and reviewed_at is null;
  if n_unrev > 0 then raise exception '% timesheet(s) haven''t been marked reviewed.', n_unrev; end if;
  update public.payroll_periods set status = 'locked', locked_at = now(), locked_by = auth.uid() where id = p_period;
end $$;

create or replace function public.payroll_period_unlock(p_period uuid, p_reason text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare per public.payroll_periods;
begin
  perform public.staff_approval_assert('hr.timesheets', null, null);
  if coalesce(btrim(p_reason), '') = '' then raise exception 'Say why the period is being unlocked.'; end if;
  select * into per from public.payroll_periods where id = p_period for update;
  if per.status <> 'locked' then raise exception 'This period isn''t locked.'; end if;
  update public.payroll_periods set status = 'open', locked_at = null, locked_by = null where id = p_period;
  perform public.log_activity_as(auth.uid(), 'unlock', 'payroll_periods', p_period::text, per.label, jsonb_build_object('reason', p_reason));
end $$;

-- ---------------------------------------------------------------------
-- 6. Totals per person — what Phase 3 hands to the payroll engine
--    (hours by bucket; premium / OT / ND keyed by the labor premium codes)
-- ---------------------------------------------------------------------
create or replace function public.payroll_ot_code(p_day_type text)
returns text language sql immutable as $$
  select case p_day_type when 'ORDINARY' then 'OT_REGULAR' when 'HOLIDAY_REGULAR_WORKED' then 'HOLIDAY_REGULAR_OT' else p_day_type || '_OT' end;
$$;

create or replace function public.payroll_period_totals(p_period uuid)
returns table (
  profile_id uuid, name text, employee_no text, reviewed_at timestamptz,
  shift_start time, shift_end time, break_minutes int, rest_days smallint[],
  days_present int, days_absent int, days_paid_leave numeric, days_unpaid_leave numeric,
  unworked_regular_holidays int, regular_hours numeric, late_hours numeric, undertime_hours numeric,
  premium_hours jsonb, ot_hours jsonb, nd_hours jsonb, ot_claimed_hours numeric, ot_paid_hours numeric,
  issues int, warnings int
)
language sql stable security definer set search_path = public, pg_temp as $$
  with d as (
    select t.* from public.payroll_timesheet_days t
     where t.period_id = p_period
       and (public.has_perm('hr.timesheets', 'view')
            or (t.profile_id = auth.uid() and exists (select 1 from public.payroll_periods p where p.id = p_period and p.status = 'locked')))
  ), prem as (
    select profile_id, jsonb_object_agg(day_type, round(m / 60.0, 2)) j from (
      select profile_id, day_type, sum(premium_min) m from d where day_type <> 'ORDINARY' and premium_min > 0 group by 1, 2) x group by 1
  ), ot as (
    select profile_id, jsonb_object_agg(code, round(m / 60.0, 2)) j from (
      select profile_id, public.payroll_ot_code(day_type) code, sum(ot_paid_min) m from d where ot_paid_min > 0 group by 1, 2) x group by 1
  ), nd as (
    select profile_id, jsonb_object_agg(code, round(m / 60.0, 2)) j from (
      select profile_id, case when day_type = 'ORDINARY' then '' else day_type end code, sum(nd_min) m from d where nd_min > 0 group by 1, 2
      union all
      select profile_id, public.payroll_ot_code(day_type), sum(nd_ot_min) from d where nd_ot_min > 0 group by 1, 2) x group by 1
  )
  select d.profile_id, max(p.name), max(e.employee_no), max(s.reviewed_at),
         max(e.shift_start), max(e.shift_end), max(e.break_minutes)::int, (select x.rest_days from public.payroll_employees x where x.profile_id = d.profile_id),
         count(*) filter (where d.status in ('present','incomplete'))::int,
         count(*) filter (where d.status = 'absent' and d.day_type = 'ORDINARY')::int,
         count(*) filter (where d.status = 'leave' and d.leave_paid and d.day_type = 'ORDINARY')::numeric,
         count(*) filter (where d.status = 'leave' and not coalesce(d.leave_paid, false) and d.day_type = 'ORDINARY')::numeric,
         count(*) filter (where d.status = 'holiday' and d.holiday_kind = 'REGULAR')::int,
         round(sum(d.regular_min) / 60.0, 2), round(sum(d.late_min) / 60.0, 2), round(sum(d.undertime_min) / 60.0, 2),
         coalesce(max(prem.j::text)::jsonb, '{}'), coalesce(max(ot.j::text)::jsonb, '{}'), coalesce(max(nd.j::text)::jsonb, '{}'),
         round(sum(d.ot_claimed_min) / 60.0, 2), round(sum(d.ot_paid_min) / 60.0, 2),
         count(*) filter (where d.flags && public.payroll_ts_blocking_flags())::int,
         count(*) filter (where cardinality(d.flags) > 0 and not d.flags && public.payroll_ts_blocking_flags())::int
    from d
    join public.profiles p on p.id = d.profile_id
    left join public.payroll_employees e on e.profile_id = d.profile_id
    left join public.payroll_timesheets s on s.period_id = d.period_id and s.profile_id = d.profile_id
    left join prem on prem.profile_id = d.profile_id
    left join ot on ot.profile_id = d.profile_id
    left join nd on nd.profile_id = d.profile_id
   group by d.profile_id
   order by max(p.name);
$$;


-- ---------------------------------------------------------------------
-- 7. Row-level security
-- ---------------------------------------------------------------------
alter table public.payroll_leave_types     enable row level security;
alter table public.payroll_periods         enable row level security;
alter table public.payroll_timesheets      enable row level security;
alter table public.payroll_timesheet_days  enable row level security;

drop policy if exists payroll_leave_types_read on public.payroll_leave_types;
create policy payroll_leave_types_read on public.payroll_leave_types for select to authenticated
  using ((select public.has_perm('hr.timesheets', 'view')) or (select public.has_perm('hr.payroll_setup', 'view')));
drop policy if exists payroll_leave_types_write on public.payroll_leave_types;
create policy payroll_leave_types_write on public.payroll_leave_types for all to authenticated
  using ((select public.has_perm('hr.payroll_setup', 'edit'))) with check ((select public.has_perm('hr.payroll_setup', 'edit')));

drop policy if exists payroll_periods_read on public.payroll_periods;
create policy payroll_periods_read on public.payroll_periods for select to authenticated
  using ((select public.has_perm('hr.timesheets', 'view'))
         or (status = 'locked' and exists (select 1 from public.payroll_timesheets s where s.period_id = payroll_periods.id and s.profile_id = auth.uid())));

drop policy if exists payroll_timesheets_read on public.payroll_timesheets;
create policy payroll_timesheets_read on public.payroll_timesheets for select to authenticated
  using ((select public.has_perm('hr.timesheets', 'view')) or profile_id = auth.uid());

drop policy if exists payroll_ts_days_read on public.payroll_timesheet_days;
create policy payroll_ts_days_read on public.payroll_timesheet_days for select to authenticated
  using ((select public.has_perm('hr.timesheets', 'view'))
         or (profile_id = auth.uid() and exists (select 1 from public.payroll_periods p where p.id = period_id and p.status = 'locked')));
drop policy if exists payroll_ts_days_update on public.payroll_timesheet_days;
create policy payroll_ts_days_update on public.payroll_timesheet_days for update to authenticated
  using ((select public.has_perm('hr.timesheets', 'edit'))) with check ((select public.has_perm('hr.timesheets', 'edit')));

-- Timesheets staff read the names of the people in them
drop policy if exists profiles_select_for_timesheets on public.profiles;
create policy profiles_select_for_timesheets on public.profiles for select to authenticated
  using (role in ('technician','staff') and (select public.has_perm('hr.timesheets', 'view')));
-- (shifts come through payroll_period_totals — Timesheets staff never read rates)
drop policy if exists payroll_employees_read_ts on public.payroll_employees;

revoke all on public.payroll_leave_types, public.payroll_periods, public.payroll_timesheets, public.payroll_timesheet_days from anon, public;
grant select on public.payroll_leave_types, public.payroll_periods, public.payroll_timesheets, public.payroll_timesheet_days to authenticated;
grant insert, update, delete on public.payroll_leave_types to authenticated;
-- HR corrects only these columns; everything else is worked out or set by the build
grant update (time_in, time_out, ot_in, ot_out, hr_status, ot_approved_min, adjust_note) on public.payroll_timesheet_days to authenticated;

revoke execute on function public.payroll_period_create(text, date, date, date, text), public.payroll_period_delete(uuid),
  public.payroll_period_build(uuid, boolean), public.payroll_ts_set_reviewed(uuid, uuid, boolean), public.payroll_ts_approve_ot(uuid, uuid),
  public.payroll_period_lock(uuid), public.payroll_period_unlock(uuid, text), public.payroll_period_totals(uuid),
  public.payroll_leave_paid(text), public.payroll_labor_config(date) from public, anon;
grant execute on function public.payroll_period_create(text, date, date, date, text), public.payroll_period_delete(uuid),
  public.payroll_period_build(uuid, boolean), public.payroll_ts_set_reviewed(uuid, uuid, boolean), public.payroll_ts_approve_ot(uuid, uuid),
  public.payroll_period_lock(uuid), public.payroll_period_unlock(uuid, text), public.payroll_period_totals(uuid)
  to authenticated, service_role;
revoke execute on function public.payroll_ts_day_compute(), public.payroll_ts_day_after(), public.payroll_ts_locked_guard()
  from public, anon, authenticated;

do $$ begin
  if to_regprocedure('public.activity_log_trigger()') is not null then
    drop trigger if exists trg_activity_log on public.payroll_periods;
    create trigger trg_activity_log after insert or update or delete on public.payroll_periods
      for each row execute function public.activity_log_trigger();
    drop trigger if exists trg_activity_log on public.payroll_leave_types;
    create trigger trg_activity_log after insert or update or delete on public.payroll_leave_types
      for each row execute function public.activity_log_trigger();
  end if;
end $$;

commit;

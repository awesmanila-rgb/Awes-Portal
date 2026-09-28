-- =====================================================================
-- AWES App — Payroll, Phase 1: foundation
--
--   * Payroll Rules (Finance › Payroll Rules, module fin.payroll_rules)
--       One table, payroll_rules, holds every statutory / labor parameter
--       the payroll engine reads: SSS, PhilHealth, Pag-IBIG, BIR withholding
--       (with de minimis + the ₱90k cap) and labor premiums (OT, holiday,
--       rest day, night differential). Nothing is hard-coded in the engine.
--       Editing model:  new draft (copy of the current version)
--                       → edit the draft
--                       → publish (Approve access; a staff member can't
--                         publish a draft they made themselves)
--       Publishing closes the previous version the day before the new one
--       starts. Published versions can never be edited or deleted, so a pay
--       run computed later always knows exactly which numbers it used.
--       Every change is written to payroll_rule_audit (append-only).
--
--   * Payroll Setup (HR › Payroll Setup, module hr.payroll_setup)
--       payroll_employees     pay setup per technician / office staff
--       payroll_rate_history  every rate change (written automatically)
--       payroll_gov_ids       TIN / SSS / PhilHealth / Pag-IBIG numbers
--                             (Edit access only — View can't read them)
--       payroll_holidays      regular / special days, with a fixed-date
--                             pre-fill for any year
--       payroll_settings      company-wide defaults (one row)
--
--   Everyone can read their own pay setup and government IDs (for My HR ›
--   My Payslips in Phase 3). Nobody else can, except payroll staff and the
--   Super Admin.
--
--   The seeded rule versions are DRAFTS on purpose: have your accountant
--   check every figure against the current SSS / PhilHealth / Pag-IBIG /
--   BIR / DOLE issuances, then publish them from Payroll Rules. Pay runs
--   (Phase 3) can't be computed until all five are published.
--
-- Requires 20260926_01 … 20261003_01. Safe to re-run.
-- =====================================================================

begin;

do $$ begin
  if to_regprocedure('public.hr_split_attendance_access()') is null then
    raise exception 'Run the earlier migrations (20260926_01 … 20261003_01) first.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. Pages in the access catalog
-- ---------------------------------------------------------------------
insert into public.app_modules (key, department, section, label, sort, approvable, has_limit, is_switch) values
  ('hr.payroll_setup',  'hr',      'HR',      'Payroll Setup', 44, false, false, false),
  ('fin.payroll_rules', 'finance', 'Finance', 'Payroll Rules', 34, true,  false, false)
on conflict (key) do update set label = excluded.label, sort = excluded.sort, section = excluded.section,
  department = excluded.department, approvable = excluded.approvable;


-- ---------------------------------------------------------------------
-- 2. Payroll rules (versioned, draft → publish)
-- ---------------------------------------------------------------------
create table if not exists public.payroll_rules (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null check (kind in ('sss','philhealth','pagibig','bir','labor')),
  version_label   text not null default '',
  config          jsonb not null check (jsonb_typeof(config) = 'object'),
  legal_reference text not null default '',
  notes           text not null default '',
  effective_from  date not null,
  effective_to    date,
  published_at    timestamptz,
  published_by    uuid references public.profiles(id) on delete set null,
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from),
  check (effective_to is null or published_at is not null)
);
-- one open draft per kind; one published version per start date
create unique index if not exists payroll_rules_one_draft on public.payroll_rules (kind) where published_at is null;
create unique index if not exists payroll_rules_version_uq on public.payroll_rules (kind, effective_from) where published_at is not null;
create index if not exists payroll_rules_lookup_idx on public.payroll_rules (kind, effective_from desc) where published_at is not null;

create table if not exists public.payroll_rule_audit (
  id          bigint generated always as identity primary key,
  rule_id     uuid not null,
  kind        text not null,
  action      text not null check (action in ('draft_created','draft_edited','draft_deleted','published','closed')),
  actor_id    uuid,
  actor_name  text not null default '',
  reason      text not null default '',
  before_row  jsonb,
  after_row   jsonb,
  at          timestamptz not null default now()
);
create index if not exists payroll_rule_audit_rule_idx on public.payroll_rule_audit (rule_id, at desc);
create index if not exists payroll_rule_audit_at_idx on public.payroll_rule_audit (at desc);

-- Shape check for each kind's config. Returns NULL when valid, else a
-- readable message. The engine re-validates at compute time; this stops a
-- bad draft from ever being published.
create or replace function public.payroll_rule_problem(p_kind text, c jsonb)
returns text
language plpgsql immutable
set search_path = public, pg_temp
as $$
declare
  b jsonb; prev jsonb; i int; n int; k text; v jsonb;
  isnum constant text := 'number';
begin
  if c is null or jsonb_typeof(c) <> 'object' then return 'Settings must be an object.'; end if;

  if p_kind = 'sss' then
    if jsonb_typeof(c->'employee_rate') <> isnum or jsonb_typeof(c->'employer_rate') <> isnum then return 'SSS: employee and employer rates are required.'; end if;
    if (c->>'employee_rate')::numeric not between 0 and 1 or (c->>'employer_rate')::numeric not between 0 and 1 then return 'SSS: rates are fractions (0.05 = 5%).'; end if;
    if jsonb_typeof(c->'ec') <> 'object' or jsonb_typeof(c->'ec'->'threshold_msc') <> isnum
       or jsonb_typeof(c->'ec'->'below_amount') <> isnum or jsonb_typeof(c->'ec'->'at_or_above_amount') <> isnum then
      return 'SSS: EC threshold and both EC amounts are required.';
    end if;
    if jsonb_typeof(c->'brackets') <> 'array' or jsonb_array_length(c->'brackets') = 0 then return 'SSS: the bracket table is empty.'; end if;
    n := jsonb_array_length(c->'brackets');
    for i in 0 .. n - 1 loop
      b := c->'brackets'->i;
      if jsonb_typeof(b->'msc') <> isnum or jsonb_typeof(b->'comp_from') <> isnum then return format('SSS: bracket %s needs MSC and "from".', i + 1); end if;
      if i = 0 and (b->>'comp_from')::numeric > 0 then return 'SSS: the first bracket must start at 0.'; end if;
      if i > 0 and (b->>'comp_from')::numeric <= (prev->>'comp_from')::numeric then return format('SSS: bracket %s must start above bracket %s.', i + 1, i); end if;
      if i = n - 1 and jsonb_typeof(b->'comp_to') not in ('null') and b ? 'comp_to' then return 'SSS: the last bracket must be open-ended ("and above").'; end if;
      prev := b;
    end loop;

  elsif p_kind = 'philhealth' then
    for k in select unnest(array['premium_rate','employee_split','employer_split','salary_floor','salary_ceiling']) loop
      if jsonb_typeof(c->k) <> isnum then return 'PhilHealth: ' || replace(k, '_', ' ') || ' is required.'; end if;
    end loop;
    if (c->>'premium_rate')::numeric not between 0 and 1 then return 'PhilHealth: the premium rate is a fraction (0.05 = 5%).'; end if;
    if abs((c->>'employee_split')::numeric + (c->>'employer_split')::numeric - 1) > 0.000001 then return 'PhilHealth: employee + employer share must add up to 100%.'; end if;
    if (c->>'salary_floor')::numeric > (c->>'salary_ceiling')::numeric then return 'PhilHealth: the salary floor is above the ceiling.'; end if;

  elsif p_kind = 'pagibig' then
    for k in select unnest(array['employee_rate','employer_rate','max_fund_salary']) loop
      if jsonb_typeof(c->k) <> isnum then return 'Pag-IBIG: ' || replace(k, '_', ' ') || ' is required.'; end if;
    end loop;
    if (c->>'employee_rate')::numeric not between 0 and 1 or (c->>'employer_rate')::numeric not between 0 and 1 then return 'Pag-IBIG: rates are fractions (0.02 = 2%).'; end if;
    if (c->>'max_fund_salary')::numeric < 0 then return 'Pag-IBIG: the maximum fund salary can''t be negative.'; end if;

  elsif p_kind = 'bir' then
    if coalesce(c->>'period', '') not in ('WEEKLY','BI_WEEKLY','SEMI_MONTHLY','MONTHLY') then return 'BIR: choose the table''s period.'; end if;
    if jsonb_typeof(c->'rounding') <> 'object' or coalesce(c->'rounding'->>'mode', '') not in ('HALF_UP','HALF_EVEN','DOWN','UP')
       or jsonb_typeof(c->'rounding'->'scale') <> isnum then return 'BIR: rounding mode and decimal places are required.'; end if;
    if jsonb_typeof(c->'brackets') <> 'array' or jsonb_array_length(c->'brackets') = 0 then return 'BIR: the tax table is empty.'; end if;
    n := jsonb_array_length(c->'brackets');
    for i in 0 .. n - 1 loop
      b := c->'brackets'->i;
      for k in select unnest(array['over','base_tax','rate','excess_over']) loop
        if jsonb_typeof(b->k) <> isnum then return format('BIR: bracket %s is missing %s.', i + 1, replace(k, '_', ' ')); end if;
      end loop;
      if (b->>'rate')::numeric not between 0 and 1 then return format('BIR: bracket %s rate is a fraction (0.15 = 15%%).', i + 1); end if;
      if i = n - 1 then
        if jsonb_typeof(b->'up_to') is distinct from 'null' and b ? 'up_to' then return 'BIR: the last bracket must be open-ended ("and above").'; end if;
      else
        if jsonb_typeof(b->'up_to') <> isnum or (b->>'up_to')::numeric <> ((c->'brackets'->(i + 1))->>'over')::numeric then
          return format('BIR: bracket %s must end where bracket %s starts.', i + 1, i + 2);
        end if;
      end if;
    end loop;
    if c ? 'other_benefits_cap' then
      if jsonb_typeof(c->'other_benefits_cap'->'annual_amount') <> isnum then return 'BIR: the 13th-month / other benefits cap needs an amount.'; end if;
      if coalesce(c->'other_benefits_cap'->>'de_minimis_excess_treatment', '') not in ('ADD_TO_OTHER_BENEFITS','TAXABLE') then return 'BIR: choose how de minimis excess is treated.'; end if;
    end if;
    if c ? 'de_minimis' then
      if jsonb_typeof(c->'de_minimis') <> 'object' then return 'BIR: de minimis must be a list of benefits.'; end if;
      for k, v in select key, value from jsonb_each(c->'de_minimis') loop
        if coalesce(v->>'limit_type', '') not in ('AMOUNT','PCT_OF_MIN_WAGE','DAYS') then return 'BIR: de minimis ' || k || ' needs a limit type.'; end if;
        if coalesce(v->>'period', '') = '' then return 'BIR: de minimis ' || k || ' needs a period.'; end if;
        if v->>'limit_type' = 'PCT_OF_MIN_WAGE' and jsonb_typeof(v->'pct') <> isnum then return 'BIR: de minimis ' || k || ' needs a percentage.'; end if;
        if v->>'limit_type' <> 'PCT_OF_MIN_WAGE' and jsonb_typeof(v->'limit') <> isnum then return 'BIR: de minimis ' || k || ' needs a limit.'; end if;
      end loop;
    end if;

  elsif p_kind = 'labor' then
    if jsonb_typeof(c->'pay_frequencies') <> 'object' then return 'Labor: pay frequencies are required.'; end if;
    for k in select unnest(array['WEEKLY','BI_WEEKLY','SEMI_MONTHLY','MONTHLY']) loop
      if jsonb_typeof(c->'pay_frequencies'->k->'periods_per_year') <> isnum or (c->'pay_frequencies'->k->>'periods_per_year')::numeric <= 0 then
        return 'Labor: periods per year for ' || k || ' must be above 0.';
      end if;
    end loop;
    if jsonb_typeof(c->'night_differential'->'rate') <> isnum then return 'Labor: the night differential rate is required.'; end if;
    if jsonb_typeof(c->'mwe'->'exempt_categories') <> 'array' then return 'Labor: minimum wage earner exempt pay types are required.'; end if;
    if jsonb_typeof(c->'premiums') <> 'object' then return 'Labor: premiums are required.'; end if;
    for k, v in select key, value from jsonb_each(c->'premiums') loop
      if coalesce(v->>'category', '') not in ('OVERTIME','HOLIDAY_PAY') then return 'Labor: premium ' || k || ' needs a category.'; end if;
      if jsonb_typeof(v->'multiplier') <> isnum or (v->>'multiplier')::numeric <= 0 then return 'Labor: premium ' || k || ' needs a multiplier above 0.'; end if;
      if coalesce(v->>'name', '') = '' then return 'Labor: premium ' || k || ' needs a name.'; end if;
    end loop;
  else
    return 'Unknown rule type.';
  end if;
  return null;
exception when others then
  return 'Settings are malformed: ' || sqlerrm;
end;
$$;

-- Published versions are frozen. The only change allowed is the one the
-- publish function makes: closing the previous open version.
create or replace function public.payroll_rules_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if old.published_at is not null then raise exception 'Published payroll rules can''t be deleted.' using errcode = '42501'; end if;
    return old;
  end if;
  if old.published_at is not null then
    if old.effective_to is null and new.effective_to is not null
       and (to_jsonb(new) - 'effective_to' - 'updated_at') = (to_jsonb(old) - 'effective_to' - 'updated_at') then
      new.updated_at := now();
      return new;
    end if;
    raise exception 'Published payroll rules can''t be changed — make a new version instead.' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists trg_payroll_rules_guard on public.payroll_rules;
create trigger trg_payroll_rules_guard before update or delete on public.payroll_rules
  for each row execute function public.payroll_rules_guard();

create or replace function public.payroll_rules_audit_trg()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare act text; who uuid := auth.uid(); why text := coalesce(current_setting('payroll.reason', true), '');
        r public.payroll_rules;
begin
  if tg_op = 'INSERT' then
    r := new; act := case when new.published_at is null then 'draft_created' else 'published' end;
  elsif tg_op = 'DELETE' then
    r := old; act := 'draft_deleted';
  else
    r := new;
    act := case when old.published_at is null and new.published_at is not null then 'published'
                when old.published_at is not null then 'closed'
                else 'draft_edited' end;
  end if;
  insert into public.payroll_rule_audit (rule_id, kind, action, actor_id, actor_name, reason, before_row, after_row)
  select r.id, r.kind, act, who, coalesce(p.name, case when who is null then 'System' else '' end), why,
         case when tg_op <> 'INSERT' then to_jsonb(old) end,
         case when tg_op <> 'DELETE' then to_jsonb(new) end
    from (select 1) one left join public.profiles p on p.id = who;
  return null;
end;
$$;
drop trigger if exists trg_payroll_rules_audit on public.payroll_rules;
create trigger trg_payroll_rules_audit after insert or update or delete on public.payroll_rules
  for each row execute function public.payroll_rules_audit_trg();

create or replace function public.payroll_forbid_change()
returns trigger language plpgsql as $$
begin raise exception '% is append-only.', tg_table_name using errcode = '42501'; end $$;
drop trigger if exists trg_payroll_rule_audit_frozen on public.payroll_rule_audit;
create trigger trg_payroll_rule_audit_frozen before update or delete on public.payroll_rule_audit
  for each row execute function public.payroll_forbid_change();

-- ---- rule actions (the only way to write payroll_rules) --------------
create or replace function public.payroll_rule_new_draft(p_kind text, p_effective_from date, p_clone_from uuid default null)
returns uuid
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare src public.payroll_rules; new_id uuid;
begin
  if not public.has_perm('fin.payroll_rules', 'edit') then
    raise exception 'You need Edit access to Payroll Rules.' using errcode = '42501';
  end if;
  if exists (select 1 from public.payroll_rules where kind = p_kind and published_at is null) then
    raise exception 'There''s already a draft for this rule — finish or delete it first.';
  end if;
  if p_clone_from is not null then
    select * into src from public.payroll_rules where id = p_clone_from and kind = p_kind;
  else
    select * into src from public.payroll_rules where kind = p_kind and published_at is not null
     order by effective_from desc limit 1;
  end if;
  if src.id is null then raise exception 'Nothing to copy — there''s no version of this rule yet.'; end if;
  insert into public.payroll_rules (kind, version_label, config, legal_reference, notes, effective_from, created_by)
  values (p_kind, '', src.config, src.legal_reference, src.notes, coalesce(p_effective_from, current_date), auth.uid())
  returning id into new_id;
  return new_id;
end;
$$;

create or replace function public.payroll_rule_save_draft(
  p_id uuid, p_config jsonb, p_effective_from date, p_version_label text default '',
  p_legal_reference text default '', p_notes text default ''
) returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare r public.payroll_rules;
begin
  if not public.has_perm('fin.payroll_rules', 'edit') then
    raise exception 'You need Edit access to Payroll Rules.' using errcode = '42501';
  end if;
  select * into r from public.payroll_rules where id = p_id for update;
  if r.id is null then raise exception 'That draft no longer exists.'; end if;
  if r.published_at is not null then raise exception 'Published payroll rules can''t be changed — make a new version instead.' using errcode = '42501'; end if;
  if p_config is null or jsonb_typeof(p_config) <> 'object' then raise exception 'Settings must be an object.'; end if;
  update public.payroll_rules
     set config = p_config, effective_from = coalesce(p_effective_from, effective_from),
         version_label = left(coalesce(p_version_label, ''), 80),
         legal_reference = left(coalesce(p_legal_reference, ''), 500),
         notes = left(coalesce(p_notes, ''), 2000)
   where id = p_id;
end;
$$;

create or replace function public.payroll_rule_delete_draft(p_id uuid, p_reason text default '')
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if not public.has_perm('fin.payroll_rules', 'edit') then
    raise exception 'You need Edit access to Payroll Rules.' using errcode = '42501';
  end if;
  perform set_config('payroll.reason', left(coalesce(p_reason, ''), 500), true);
  delete from public.payroll_rules where id = p_id and published_at is null;
  if not found then raise exception 'Only drafts can be deleted.'; end if;
end;
$$;

create or replace function public.payroll_rule_publish(p_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare r public.payroll_rules; latest date; problem text;
begin
  select * into r from public.payroll_rules where id = p_id for update;
  if r.id is null then raise exception 'That draft no longer exists.'; end if;
  if r.published_at is not null then raise exception 'This version is already published.'; end if;
  -- Approve access; delegation-aware; a staff member can't publish their own draft; password re-entry
  perform public.staff_approval_assert('fin.payroll_rules', null, r.created_by);
  if coalesce(btrim(p_reason), '') = '' then raise exception 'Say why this version is being published (e.g. the circular or wage order).'; end if;
  problem := public.payroll_rule_problem(r.kind, r.config);
  if problem is not null then raise exception '%', problem; end if;
  select max(effective_from) into latest from public.payroll_rules where kind = r.kind and published_at is not null;
  if latest is not null and r.effective_from <= latest then
    raise exception 'A version starting % is already published — this one has to start after it.', to_char(latest, 'Mon DD, YYYY');
  end if;
  perform set_config('payroll.reason', left(p_reason, 500), true);
  update public.payroll_rules set effective_to = r.effective_from - 1
   where kind = r.kind and published_at is not null and effective_to is null;
  update public.payroll_rules
     set published_at = now(), published_by = auth.uid(),
         version_label = case when version_label = '' then upper(kind) || '-' || to_char(effective_from, 'YYYY-MM-DD') else version_label end
   where id = p_id;
end;
$$;

-- The published version of every rule in force on a date (Phase 3 pins these)
create or replace function public.payroll_rules_at(p_date date)
returns setof public.payroll_rules
language sql stable security definer
set search_path = public, pg_temp
as $$
  select * from public.payroll_rules
   where published_at is not null and effective_from <= p_date and (effective_to is null or effective_to >= p_date)
     and (public.has_perm('fin.payroll_rules', 'view') or public.has_perm('hr.payroll_setup', 'view'));
$$;


-- ---------------------------------------------------------------------
-- 3. Company-wide payroll settings (one row)
-- ---------------------------------------------------------------------
create table if not exists public.payroll_settings (
  id                       smallint primary key default 1 check (id = 1),
  default_pay_frequency    text not null default 'SEMI_MONTHLY' check (default_pay_frequency in ('WEEKLY','BI_WEEKLY','SEMI_MONTHLY','MONTHLY')),
  default_working_days     numeric(5,1) not null default 313 check (default_working_days > 0 and default_working_days <= 366),
  default_hours_per_day    numeric(4,2) not null default 8 check (default_hours_per_day > 0 and default_hours_per_day <= 24),
  contribution_timing      text not null default 'SPLIT_EQUAL' check (contribution_timing in ('SPLIT_EQUAL','FIRST_CUTOFF','LAST_CUTOFF')),
  minimum_net_pay          numeric(12,2) not null default 0 check (minimum_net_pay >= 0),
  grace_minutes            smallint not null default 0 check (grace_minutes between 0 and 120),
  updated_by               uuid references public.profiles(id) on delete set null,
  updated_at               timestamptz not null default now()
);
insert into public.payroll_settings (id) values (1) on conflict (id) do nothing;


-- ---------------------------------------------------------------------
-- 4. Employee pay setup
-- ---------------------------------------------------------------------
create table if not exists public.payroll_employees (
  profile_id              uuid primary key references public.profiles(id) on delete cascade,
  employee_no             text,
  employment_status       text not null default 'regular'
                          check (employment_status in ('regular','probationary','contractual','project','part_time')),
  hire_date               date,
  rate_type               text not null default 'DAILY' check (rate_type in ('MONTHLY','DAILY','HOURLY')),
  base_rate               numeric(12,2) not null default 0 check (base_rate >= 0),
  pay_frequency           text not null default 'SEMI_MONTHLY' check (pay_frequency in ('WEEKLY','BI_WEEKLY','SEMI_MONTHLY','MONTHLY')),
  working_days_per_year   numeric(5,1) not null default 313 check (working_days_per_year > 0 and working_days_per_year <= 366),
  hours_per_day           numeric(4,2) not null default 8 check (hours_per_day > 0 and hours_per_day <= 24),
  shift_start             time not null default '08:00',
  shift_end               time not null default '17:00',
  break_minutes           smallint not null default 60 check (break_minutes between 0 and 240),
  rest_days               smallint[] not null default '{0}',   -- 0 = Sunday … 6 = Saturday
  is_mwe                  boolean not null default false,
  regional_min_daily_wage numeric(10,2) check (regional_min_daily_wage is null or regional_min_daily_wage > 0),
  sss_enabled             boolean not null default true,
  philhealth_enabled      boolean not null default true,
  pagibig_enabled         boolean not null default true,
  tax_enabled             boolean not null default true,
  payout_method           text not null default 'cash' check (payout_method in ('cash','bank','gcash','maya')),
  payout_bank             text not null default '',
  payout_account_name     text not null default '',
  payout_account_no       text not null default '',
  is_active               boolean not null default true,
  notes                   text not null default '',
  created_by              uuid references public.profiles(id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_by              uuid references public.profiles(id) on delete set null,
  updated_at              timestamptz not null default now(),
  check (rest_days <@ '{0,1,2,3,4,5,6}'::smallint[]),
  check (not is_mwe or regional_min_daily_wage is not null)
);
create unique index if not exists payroll_employees_no_uq on public.payroll_employees (lower(employee_no)) where coalesce(employee_no, '') <> '';

create table if not exists public.payroll_rate_history (
  id          bigint generated always as identity primary key,
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  rate_type   text not null,
  base_rate   numeric(12,2) not null,
  effective   date not null default current_date,
  changed_by  uuid references public.profiles(id) on delete set null,
  changed_by_name text not null default '',
  changed_at  timestamptz not null default now()
);
create index if not exists payroll_rate_history_idx on public.payroll_rate_history (profile_id, changed_at desc);
drop trigger if exists trg_payroll_rate_history_frozen on public.payroll_rate_history;
create trigger trg_payroll_rate_history_frozen before update or delete on public.payroll_rate_history
  for each row when (pg_trigger_depth() < 1) execute function public.payroll_forbid_change();

create or replace function public.payroll_employees_before()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare r text;
begin
  if tg_op = 'INSERT' or new.profile_id is distinct from old.profile_id then
    select role into r from public.profiles where id = new.profile_id;
    if r is null or r not in ('technician','staff') then
      raise exception 'Only technicians and office staff can be set up for payroll.';
    end if;
  end if;
  new.employee_no := nullif(btrim(coalesce(new.employee_no, '')), '');
  new.rest_days := (select coalesce(array_agg(distinct d order by d), '{}') from unnest(new.rest_days) d);
  if tg_op = 'INSERT' then new.created_by := coalesce(new.created_by, auth.uid()); new.created_at := now(); end if;
  new.updated_by := auth.uid(); new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists trg_payroll_employees_before on public.payroll_employees;
create trigger trg_payroll_employees_before before insert or update on public.payroll_employees
  for each row execute function public.payroll_employees_before();

create or replace function public.payroll_employees_after()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' or new.rate_type is distinct from old.rate_type or new.base_rate is distinct from old.base_rate then
    insert into public.payroll_rate_history (profile_id, rate_type, base_rate, changed_by, changed_by_name)
    select new.profile_id, new.rate_type, new.base_rate, auth.uid(), coalesce(p.name, '')
      from (select 1) one left join public.profiles p on p.id = auth.uid();
  end if;
  return null;
end;
$$;
drop trigger if exists trg_payroll_employees_after on public.payroll_employees;
create trigger trg_payroll_employees_after after insert or update on public.payroll_employees
  for each row execute function public.payroll_employees_after();

create table if not exists public.payroll_gov_ids (
  profile_id    uuid primary key references public.profiles(id) on delete cascade,
  tin           text not null default '',
  sss_no        text not null default '',
  philhealth_no text not null default '',
  pagibig_no    text not null default '',
  updated_by    uuid references public.profiles(id) on delete set null,
  updated_at    timestamptz not null default now()
);
create or replace function public.payroll_gov_ids_before()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from public.profiles where id = new.profile_id and role in ('technician','staff')) then
    raise exception 'Only technicians and office staff can be set up for payroll.';
  end if;
  new.tin := btrim(new.tin); new.sss_no := btrim(new.sss_no);
  new.philhealth_no := btrim(new.philhealth_no); new.pagibig_no := btrim(new.pagibig_no);
  new.updated_by := auth.uid(); new.updated_at := now();
  return new;
end $$;
drop trigger if exists trg_payroll_gov_ids_before on public.payroll_gov_ids;
create trigger trg_payroll_gov_ids_before before insert or update on public.payroll_gov_ids
  for each row execute function public.payroll_gov_ids_before();


-- ---------------------------------------------------------------------
-- 5. Holidays
-- ---------------------------------------------------------------------
create table if not exists public.payroll_holidays (
  id           uuid primary key default gen_random_uuid(),
  holiday_date date not null,
  name         text not null check (btrim(name) <> ''),
  kind         text not null check (kind in ('REGULAR','SPECIAL_NON_WORKING','SPECIAL_WORKING')),
  scope        text not null default 'National',   -- 'National' or a city / province
  notes        text not null default '',
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now()
);
create unique index if not exists payroll_holidays_uq on public.payroll_holidays (holiday_date, lower(scope));
create index if not exists payroll_holidays_date_idx on public.payroll_holidays (holiday_date);

-- Fixed-date holidays for a year (Holy Week, National Heroes Day, the Eids,
-- Chinese New Year and any moved dates still have to be added by hand from
-- that year's proclamation). Skips dates already on the list.
create or replace function public.payroll_holidays_prefill(p_year int)
returns int
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare n int;
begin
  if not public.has_perm('hr.payroll_setup', 'edit') then
    raise exception 'You need Edit access to Payroll Setup.' using errcode = '42501';
  end if;
  if p_year not between 2000 and 2100 then raise exception 'Enter a year like 2027.'; end if;
  insert into public.payroll_holidays (holiday_date, name, kind, scope, notes, created_by)
  select make_date(p_year, m, d), nm, k, 'National', 'Fixed date — check this year''s proclamation', auth.uid()
    from (values
      (1, 1,  'New Year''s Day',              'REGULAR'),
      (4, 9,  'Araw ng Kagitingan',           'REGULAR'),
      (5, 1,  'Labor Day',                    'REGULAR'),
      (6, 12, 'Independence Day',             'REGULAR'),
      (11,30, 'Bonifacio Day',                'REGULAR'),
      (12,25, 'Christmas Day',                'REGULAR'),
      (12,30, 'Rizal Day',                    'REGULAR'),
      (8, 21, 'Ninoy Aquino Day',             'SPECIAL_NON_WORKING'),
      (11,1,  'All Saints'' Day',             'SPECIAL_NON_WORKING'),
      (12,8,  'Feast of the Immaculate Conception', 'SPECIAL_NON_WORKING'),
      (12,31, 'Last Day of the Year',         'SPECIAL_NON_WORKING')
    ) v(m, d, nm, k)
  on conflict (holiday_date, lower(scope)) do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;


-- ---------------------------------------------------------------------
-- 6. Row-level security
-- ---------------------------------------------------------------------
alter table public.payroll_rules        enable row level security;
alter table public.payroll_rule_audit   enable row level security;
alter table public.payroll_settings     enable row level security;
alter table public.payroll_employees    enable row level security;
alter table public.payroll_rate_history enable row level security;
alter table public.payroll_gov_ids      enable row level security;
alter table public.payroll_holidays     enable row level security;

-- rules: readable by payroll people; written only through the functions above
drop policy if exists payroll_rules_read on public.payroll_rules;
create policy payroll_rules_read on public.payroll_rules for select to authenticated
  using ((select public.has_perm('fin.payroll_rules', 'view')) or (select public.has_perm('hr.payroll_setup', 'view')));
drop policy if exists payroll_rule_audit_read on public.payroll_rule_audit;
create policy payroll_rule_audit_read on public.payroll_rule_audit for select to authenticated
  using ((select public.has_perm('fin.payroll_rules', 'view')));

drop policy if exists payroll_settings_read on public.payroll_settings;
create policy payroll_settings_read on public.payroll_settings for select to authenticated
  using ((select public.has_perm('hr.payroll_setup', 'view')) or (select public.has_perm('fin.payroll_rules', 'view')));
drop policy if exists payroll_settings_write on public.payroll_settings;
create policy payroll_settings_write on public.payroll_settings for update to authenticated
  using ((select public.has_perm('hr.payroll_setup', 'edit'))) with check ((select public.has_perm('hr.payroll_setup', 'edit')));

-- pay setup: own row, or payroll staff
drop policy if exists payroll_employees_read on public.payroll_employees;
create policy payroll_employees_read on public.payroll_employees for select to authenticated
  using (profile_id = auth.uid() or (select public.has_perm('hr.payroll_setup', 'view')));
drop policy if exists payroll_employees_write on public.payroll_employees;
create policy payroll_employees_write on public.payroll_employees for all to authenticated
  using ((select public.has_perm('hr.payroll_setup', 'edit'))) with check ((select public.has_perm('hr.payroll_setup', 'edit')));

drop policy if exists payroll_rate_history_read on public.payroll_rate_history;
create policy payroll_rate_history_read on public.payroll_rate_history for select to authenticated
  using (profile_id = auth.uid() or (select public.has_perm('hr.payroll_setup', 'view')));

-- government IDs: own row, or payroll staff with Edit (View can't see them)
drop policy if exists payroll_gov_ids_read on public.payroll_gov_ids;
create policy payroll_gov_ids_read on public.payroll_gov_ids for select to authenticated
  using (profile_id = auth.uid() or (select public.has_perm('hr.payroll_setup', 'edit')));
drop policy if exists payroll_gov_ids_write on public.payroll_gov_ids;
create policy payroll_gov_ids_write on public.payroll_gov_ids for all to authenticated
  using ((select public.has_perm('hr.payroll_setup', 'edit'))) with check ((select public.has_perm('hr.payroll_setup', 'edit')));

-- holidays: everyone who works for the company can see the calendar
drop policy if exists payroll_holidays_read on public.payroll_holidays;
create policy payroll_holidays_read on public.payroll_holidays for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin','technician','staff')));
drop policy if exists payroll_holidays_write on public.payroll_holidays;
create policy payroll_holidays_write on public.payroll_holidays for all to authenticated
  using ((select public.has_perm('hr.payroll_setup', 'edit'))) with check ((select public.has_perm('hr.payroll_setup', 'edit')));

-- names of the people being set up (technicians already readable by some
-- staff; this adds office staff and technicians for Payroll Setup)
drop policy if exists profiles_select_for_payroll on public.profiles;
create policy profiles_select_for_payroll on public.profiles for select to authenticated
  using (role in ('technician','staff') and (select public.has_perm('hr.payroll_setup', 'view')));

revoke all on public.payroll_rules, public.payroll_rule_audit, public.payroll_settings, public.payroll_employees,
  public.payroll_rate_history, public.payroll_gov_ids, public.payroll_holidays from anon, public;
grant select on public.payroll_rules, public.payroll_rule_audit, public.payroll_rate_history to authenticated;
grant select, update on public.payroll_settings to authenticated;
grant select, insert, update, delete on public.payroll_employees, public.payroll_gov_ids, public.payroll_holidays to authenticated;

revoke execute on function public.payroll_rule_new_draft(text, date, uuid), public.payroll_rule_save_draft(uuid, jsonb, date, text, text, text),
  public.payroll_rule_delete_draft(uuid, text), public.payroll_rule_publish(uuid, text), public.payroll_rules_at(date),
  public.payroll_holidays_prefill(int), public.payroll_rule_problem(text, jsonb) from public, anon;
grant execute on function public.payroll_rule_new_draft(text, date, uuid), public.payroll_rule_save_draft(uuid, jsonb, date, text, text, text),
  public.payroll_rule_delete_draft(uuid, text), public.payroll_rule_publish(uuid, text), public.payroll_rules_at(date),
  public.payroll_holidays_prefill(int), public.payroll_rule_problem(text, jsonb) to authenticated, service_role;
revoke execute on function public.payroll_rules_guard(), public.payroll_rules_audit_trg(), public.payroll_forbid_change(),
  public.payroll_employees_before(), public.payroll_employees_after(), public.payroll_gov_ids_before() from public, anon, authenticated;

-- activity log (government IDs are left out so the numbers aren't copied into the log)
do $$
declare t text;
begin
  if to_regprocedure('public.activity_log_trigger()') is null then return; end if;
  foreach t in array array['payroll_employees','payroll_holidays','payroll_settings'] loop
    execute format('drop trigger if exists trg_activity_log on public.%I', t);
    execute format('create trigger trg_activity_log after insert or update or delete on public.%I
                    for each row execute function public.activity_log_trigger()', t);
  end loop;
end $$;


-- ---------------------------------------------------------------------
-- 7. Seed drafts (only if the rule has never been set up)
--    Figures as understood for 2026 — VERIFY each one before publishing.
-- ---------------------------------------------------------------------
do $$
declare sss_brackets jsonb;
begin
  if not exists (select 1 from public.payroll_rules where kind = 'sss') then
    select jsonb_agg(jsonb_build_object(
             'msc', msc,
             'comp_from', case when i = 0 then 0 else msc - 250 end,
             'comp_to', case when i = 60 then null else msc + 249.99 end,
             'regular_msc', least(msc, 20000),
             'mpf_msc', greatest(msc - 20000, 0)) order by i)
      into sss_brackets
      from (select i, 5000 + i * 500 as msc from generate_series(0, 60) i) s;
    insert into public.payroll_rules (kind, config, legal_reference, notes, effective_from)
    values ('sss', jsonb_build_object(
              'employee_rate', 0.05, 'employer_rate', 0.10,
              'ec', jsonb_build_object('threshold_msc', 15000, 'below_amount', 10, 'at_or_above_amount', 30),
              'brackets', sss_brackets),
            'RA 11199 — SSS 2025 contribution schedule (15%, MSC ₱5,000–₱35,000)',
            'Seeded draft. Verify against the current SSS circular before publishing.', '2026-01-01');
  end if;

  if not exists (select 1 from public.payroll_rules where kind = 'philhealth') then
    insert into public.payroll_rules (kind, config, legal_reference, notes, effective_from)
    values ('philhealth', jsonb_build_object(
              'premium_rate', 0.05, 'employee_split', 0.5, 'employer_split', 0.5,
              'salary_floor', 10000, 'salary_ceiling', 100000,
              'min_total_premium', 500, 'max_total_premium', 5000),
            'RA 11223 (UHC Act) — 5% premium, ₱10,000 floor, ₱100,000 ceiling',
            'Seeded draft. Verify against the current PhilHealth circular before publishing.', '2026-01-01');
  end if;

  if not exists (select 1 from public.payroll_rules where kind = 'pagibig') then
    insert into public.payroll_rules (kind, config, legal_reference, notes, effective_from)
    values ('pagibig', jsonb_build_object(
              'employee_rate', 0.02, 'employer_rate', 0.02, 'max_fund_salary', 10000,
              'max_employee_contribution', 200, 'max_employer_contribution', 200),
            'HDMF Circular 460 — 2% / 2%, ₱10,000 maximum fund salary',
            'Seeded draft. Employees earning ₱1,500 or less pay 1% — the engine uses one rate, so set a manual override for them. Verify before publishing.', '2026-01-01');
  end if;

  if not exists (select 1 from public.payroll_rules where kind = 'bir') then
    insert into public.payroll_rules (kind, config, legal_reference, notes, effective_from)
    values ('bir', $json${
      "period": "MONTHLY",
      "rounding": {"mode": "HALF_UP", "scale": 2},
      "brackets": [
        {"over": 0,      "up_to": 20833,  "base_tax": 0,        "rate": 0,    "excess_over": 0},
        {"over": 20833,  "up_to": 33333,  "base_tax": 0,        "rate": 0.15, "excess_over": 20833},
        {"over": 33333,  "up_to": 66667,  "base_tax": 1875,     "rate": 0.20, "excess_over": 33333},
        {"over": 66667,  "up_to": 166667, "base_tax": 8541.80,  "rate": 0.25, "excess_over": 66667},
        {"over": 166667, "up_to": 666667, "base_tax": 33541.80, "rate": 0.30, "excess_over": 166667},
        {"over": 666667, "up_to": null,   "base_tax": 183541.80,"rate": 0.35, "excess_over": 666667}
      ],
      "other_benefits_cap": {
        "annual_amount": 90000,
        "covers": ["THIRTEENTH_MONTH", "BONUS", "OTHER_BENEFITS"],
        "de_minimis_excess_treatment": "ADD_TO_OTHER_BENEFITS"
      },
      "de_minimis": {
        "RICE_SUBSIDY":       {"limit_type": "AMOUNT", "limit": 2500,  "period": "MONTH"},
        "UNIFORM_ALLOWANCE":  {"limit_type": "AMOUNT", "limit": 8000,  "period": "YEAR"},
        "LAUNDRY_ALLOWANCE":  {"limit_type": "AMOUNT", "limit": 400,   "period": "MONTH"},
        "ACHIEVEMENT_AWARDS": {"limit_type": "AMOUNT", "limit": 12000, "period": "YEAR"},
        "CHRISTMAS_GIFTS":    {"limit_type": "AMOUNT", "limit": 6000,  "period": "YEAR"},
        "CBA_PRODUCTIVITY":   {"limit_type": "AMOUNT", "limit": 12000, "period": "YEAR", "pool": "CBA_PRODUCTIVITY"},
        "OT_NIGHT_MEAL":      {"limit_type": "PCT_OF_MIN_WAGE", "pct": 0.30, "period": "DAY"},
        "LEAVE_MONETIZATION": {"limit_type": "DAYS",   "limit": 12,    "period": "YEAR"}
      }
    }$json$::jsonb,
    'TRAIN Law (RA 10963) withholding table effective 2023; de minimis per RR 11-2018 as amended (RR 4-2025)',
    'Seeded draft. Monthly table — semi-monthly and weekly pay use it month-to-date. Verify every figure before publishing.', '2026-01-01');
  end if;

  if not exists (select 1 from public.payroll_rules where kind = 'labor') then
    insert into public.payroll_rules (kind, config, legal_reference, notes, effective_from)
    values ('labor', $json${
      "pay_frequencies": {
        "WEEKLY":       {"periods_per_year": 52},
        "BI_WEEKLY":    {"periods_per_year": 26},
        "SEMI_MONTHLY": {"periods_per_year": 24},
        "MONTHLY":      {"periods_per_year": 12}
      },
      "night_differential": {"rate": 0.10, "start": "22:00", "end": "06:00"},
      "mwe": {"exempt_categories": ["BASIC","OVERTIME","HOLIDAY_PAY","NIGHT_DIFFERENTIAL","HAZARD_PAY"]},
      "premiums": {
        "OT_REGULAR":                  {"name": "Overtime, ordinary day",                "category": "OVERTIME",    "multiplier": 1.25},
        "REST_DAY":                    {"name": "Rest day worked",                       "category": "HOLIDAY_PAY", "multiplier": 1.30},
        "REST_DAY_OT":                 {"name": "Overtime, rest day",                    "category": "OVERTIME",    "multiplier": 1.69},
        "SPECIAL_HOLIDAY":             {"name": "Special non-working day worked",        "category": "HOLIDAY_PAY", "multiplier": 1.30},
        "SPECIAL_HOLIDAY_OT":          {"name": "Overtime, special non-working day",     "category": "OVERTIME",    "multiplier": 1.69},
        "SPECIAL_HOLIDAY_REST_DAY":    {"name": "Special day on rest day worked",        "category": "HOLIDAY_PAY", "multiplier": 1.50},
        "SPECIAL_HOLIDAY_REST_DAY_OT": {"name": "Overtime, special day on rest day",     "category": "OVERTIME",    "multiplier": 1.95},
        "HOLIDAY_REGULAR_WORKED":      {"name": "Regular holiday worked",                "category": "HOLIDAY_PAY", "multiplier": 2.00, "monthly_paid_multiplier": 1.00},
        "HOLIDAY_REGULAR_OT":          {"name": "Overtime, regular holiday",             "category": "OVERTIME",    "multiplier": 2.60},
        "HOLIDAY_REGULAR_REST_DAY":    {"name": "Regular holiday on rest day worked",    "category": "HOLIDAY_PAY", "multiplier": 2.60, "monthly_paid_multiplier": 1.60},
        "HOLIDAY_REGULAR_REST_DAY_OT": {"name": "Overtime, regular holiday on rest day", "category": "OVERTIME",    "multiplier": 3.38}
      }
    }$json$::jsonb,
    'Labor Code of the Philippines, premium pay and night shift differential (Arts. 86–94)',
    'Seeded draft. Confirm against company policy and DOLE guidance before publishing.', '2026-01-01');
  end if;

  -- every seeded rule must pass its own shape check
  if exists (select 1 from public.payroll_rules where public.payroll_rule_problem(kind, config) is not null) then
    raise exception 'Payroll rule seed is malformed: %',
      (select string_agg(kind || ': ' || public.payroll_rule_problem(kind, config), '; ') from public.payroll_rules
        where public.payroll_rule_problem(kind, config) is not null);
  end if;
end $$;

commit;

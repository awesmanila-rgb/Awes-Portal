-- =====================================================================
-- AWES App — Payroll, Phase 3: pay runs and payslips
--
--   HR › Pay Runs (module hr.payroll_runs)
--     1. Start a pay run from a LOCKED timesheet period (one run per period).
--     2. Add one-off earnings / deductions (bonus, 13th month, adjustments),
--        and pull in cash-advance balances (excess to return → deduction,
--        amount to reimburse → non-taxable earning).
--     3. Compute: the payroll-compute Edge Function reads everything with
--        payroll_run_inputs(), runs the payroll engine (engine.ts) for each
--        person with the rules in force on the pay date, and saves the
--        result with payroll_run_store() (service role only — nobody can
--        type numbers into a payslip).
--     4. Submit → Finance approves (fin.payroll_approve: Approve access,
--        peso limit on total net pay, can't approve a run they computed,
--        password re-entry) or sends it back with a reason.
--     5. Release (fin.payroll_approve Edit): payslips appear in My HR ›
--        My Payslips, cash advances included are marked settled and loan
--        balances go down.
--   Allowances & loans that repeat every pay run live in
--   payroll_recurring_items (Payroll Setup › Employees).
--
--   Any change to a run's adjustments sends it back to draft (numbers
--   cleared) so a stale computation can never be approved. Released runs
--   are final. A timesheet period with a pay run can't be unlocked.
--
-- Requires 20261005_01_payroll_timesheets.sql. Safe to re-run.
-- =====================================================================

begin;

do $$ begin
  if to_regclass('public.payroll_timesheet_days') is null then
    raise exception 'Run 20261005_01_payroll_timesheets.sql first.';
  end if;
end $$;

insert into public.app_modules (key, department, section, label, sort, approvable, has_limit, is_switch) values
  ('hr.payroll_runs',     'hr',      'HR',      'Pay Runs',        46, false, false, false),
  ('fin.payroll_approve', 'finance', 'Finance', 'Payroll Approval', 35, true,  true,  false)
on conflict (key) do update set label = excluded.label, sort = excluded.sort, section = excluded.section,
  department = excluded.department, approvable = excluded.approvable, has_limit = excluded.has_limit;

-- ---------------------------------------------------------------------
-- 1. Recurring allowances / deductions (loans have a balance)
-- ---------------------------------------------------------------------
create table if not exists public.payroll_recurring_items (
  id              uuid primary key default gen_random_uuid(),
  profile_id      uuid not null references public.profiles(id) on delete cascade,
  kind            text not null check (kind in ('earning','deduction')),
  code            text not null check (code ~ '^[A-Z0-9_]{2,40}$'),
  name            text not null check (btrim(name) <> ''),
  category        text not null default 'ALLOWANCE',
  amount          numeric(12,2) not null check (amount > 0),        -- per pay run
  is_taxable      boolean not null default true,
  is_de_minimis   boolean not null default false,
  de_minimis_code text,
  priority        smallint,
  allow_partial   boolean not null default true,
  balance         numeric(12,2) check (balance is null or balance >= 0), -- loans: what is still owed
  start_date      date,
  end_date        date,
  is_active       boolean not null default true,
  notes           text not null default '',
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (not is_de_minimis or de_minimis_code is not null),
  check (kind = 'deduction' or balance is null),
  check (end_date is null or start_date is null or end_date >= start_date)
);
create unique index if not exists payroll_recurring_code_uq on public.payroll_recurring_items (profile_id, code);


-- ---------------------------------------------------------------------
-- 2. Runs, one-off adjustments, lines (= payslips)
-- ---------------------------------------------------------------------
create table if not exists public.payroll_runs (
  id                 uuid primary key default gen_random_uuid(),
  period_id          uuid not null unique references public.payroll_periods(id),
  status             text not null default 'draft' check (status in ('draft','computed','submitted','approved','released')),
  rule_ids           jsonb,              -- the five published rule versions the numbers came from
  rule_labels        text not null default '',
  headcount          int not null default 0,
  total_gross        numeric(14,2) not null default 0,
  total_deductions   numeric(14,2) not null default 0,
  total_net          numeric(14,2) not null default 0,
  total_employer     numeric(14,2) not null default 0,   -- employer contributions
  total_cost         numeric(14,2) not null default 0,   -- gross + employer contributions
  warnings           int not null default 0,
  sent_back_note     text not null default '',
  created_by         uuid references public.profiles(id) on delete set null,
  created_at         timestamptz not null default now(),
  computed_by        uuid references public.profiles(id) on delete set null,
  computed_at        timestamptz,
  submitted_by       uuid references public.profiles(id) on delete set null,
  submitted_at       timestamptz,
  approved_by        uuid references public.profiles(id) on delete set null,
  approved_at        timestamptz,
  released_by        uuid references public.profiles(id) on delete set null,
  released_at        timestamptz
);

create table if not exists public.payroll_run_adjustments (
  id              uuid primary key default gen_random_uuid(),
  run_id          uuid not null references public.payroll_runs(id) on delete cascade,
  profile_id      uuid not null references public.profiles(id) on delete cascade,
  kind            text not null check (kind in ('earning','deduction')),
  code            text not null default '',
  name            text not null check (btrim(name) <> ''),
  category        text not null default 'ADJUSTMENT',
  amount          numeric(12,2) not null check (amount > 0),
  quantity        numeric(10,2) check (quantity is null or quantity > 0),
  is_taxable      boolean not null default true,
  is_de_minimis   boolean not null default false,
  de_minimis_code text,
  priority        smallint,
  allow_partial   boolean not null default true,
  source          text not null default 'manual' check (source in ('manual','cash_advance')),
  ref_id          uuid,                 -- cash_advance_requests.id
  note            text not null default '',
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  check (not is_de_minimis or de_minimis_code is not null)
);
create index if not exists payroll_run_adj_idx on public.payroll_run_adjustments (run_id, profile_id);
create unique index if not exists payroll_run_adj_ca_uq on public.payroll_run_adjustments (run_id, ref_id) where ref_id is not null;

create table if not exists public.payroll_lines (
  run_id          uuid not null references public.payroll_runs(id) on delete cascade,
  profile_id      uuid not null references public.profiles(id) on delete cascade,
  pay_date        date not null,
  period_end      date not null,
  pay_frequency   text not null,
  input           jsonb not null,
  result          jsonb not null,
  gross           numeric(14,2) not null,
  taxable_income  numeric(14,2) not null,
  withholding_tax numeric(14,2) not null,
  ee_contrib      numeric(14,2) not null,
  er_contrib      numeric(14,2) not null,
  deductions      numeric(14,2) not null,
  net             numeric(14,2) not null,
  warnings        jsonb not null default '[]',
  computed_at     timestamptz not null default now(),
  primary key (run_id, profile_id)
);
create index if not exists payroll_lines_person_idx on public.payroll_lines (profile_id, pay_date);


-- ---------------------------------------------------------------------
-- 3. Guards
-- ---------------------------------------------------------------------
-- adjustments: only while the run is draft / computed; any change clears the numbers
create or replace function public.payroll_run_adj_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare rid uuid := case when tg_op = 'DELETE' then old.run_id else new.run_id end; st text;
begin
  select status into st from public.payroll_runs where id = rid;
  if st is not null and st not in ('draft','computed') then
    raise exception 'This pay run is % — send it back before changing it.', st using errcode = '42501';
  end if;
  if tg_op <> 'DELETE' then
    if not exists (select 1 from public.payroll_timesheets t join public.payroll_runs r on r.period_id = t.period_id
                    where r.id = new.run_id and t.profile_id = new.profile_id) then
      raise exception 'That person isn''t in this pay run''s timesheets.';
    end if;
    if tg_op = 'INSERT' then new.created_by := coalesce(new.created_by, auth.uid()); end if;
    if coalesce(new.code, '') = '' then
      new.code := case when new.source = 'cash_advance' then 'CA_' else 'ADJ_' end || upper(left(replace(new.id::text, '-', ''), 8));
    end if;
    new.code := upper(regexp_replace(new.code, '[^A-Za-z0-9_]', '_', 'g'));
  end if;
  if st = 'computed' then
    delete from public.payroll_lines where run_id = rid;
    update public.payroll_runs set status = 'draft', headcount = 0, total_gross = 0, total_deductions = 0, total_net = 0,
           total_employer = 0, total_cost = 0, warnings = 0, computed_at = null, computed_by = null where id = rid;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists trg_payroll_run_adj_guard on public.payroll_run_adjustments;
create trigger trg_payroll_run_adj_guard before insert or update or delete on public.payroll_run_adjustments
  for each row execute function public.payroll_run_adj_guard();

create or replace function public.payroll_recurring_before()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from public.profiles where id = new.profile_id and role in ('technician','staff')) then
    raise exception 'Only technicians and office staff can have payroll items.';
  end if;
  new.code := upper(regexp_replace(btrim(new.code), '[^A-Za-z0-9_]', '_', 'g'));
  if tg_op = 'INSERT' then new.created_by := coalesce(new.created_by, auth.uid()); end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists trg_payroll_recurring_before on public.payroll_recurring_items;
create trigger trg_payroll_recurring_before before insert or update on public.payroll_recurring_items
  for each row execute function public.payroll_recurring_before();

-- a timesheet period that has a pay run can't be unlocked
create or replace function public.payroll_period_unlock(p_period uuid, p_reason text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare per public.payroll_periods; r public.payroll_runs;
begin
  perform public.staff_approval_assert('hr.timesheets', null, null);
  if coalesce(btrim(p_reason), '') = '' then raise exception 'Say why the period is being unlocked.'; end if;
  select * into per from public.payroll_periods where id = p_period for update;
  if per.status <> 'locked' then raise exception 'This period isn''t locked.'; end if;
  select * into r from public.payroll_runs where period_id = p_period;
  if r.id is not null then
    raise exception 'This period has a pay run (%) — %.', r.status,
      case when r.status in ('draft','computed') then 'delete the pay run first' else 'it can''t be unlocked any more' end;
  end if;
  update public.payroll_periods set status = 'open', locked_at = null, locked_by = null where id = p_period;
  perform public.log_activity_as(auth.uid(), 'unlock', 'payroll_periods', p_period::text, per.label, jsonb_build_object('reason', p_reason));
end $$;


-- ---------------------------------------------------------------------
-- 4. Totals without the permission filter (for the pay run only)
-- ---------------------------------------------------------------------
create or replace function public.payroll_period_totals_raw(p_period uuid)
returns table (
  profile_id uuid, days_present int, days_absent int, days_paid_leave numeric, days_unpaid_leave numeric,
  unworked_regular_holidays int, regular_hours numeric, late_hours numeric, undertime_hours numeric,
  premium_hours jsonb, ot_hours jsonb, nd_hours jsonb
)
language sql stable security definer set search_path = public, pg_temp as $$
  with d as (select * from public.payroll_timesheet_days where period_id = p_period),
  prem as (select profile_id, jsonb_object_agg(day_type, round(m / 60.0, 2)) j from (
      select profile_id, day_type, sum(premium_min) m from d where day_type <> 'ORDINARY' and premium_min > 0 group by 1, 2) x group by 1),
  ot as (select profile_id, jsonb_object_agg(code, round(m / 60.0, 2)) j from (
      select profile_id, public.payroll_ot_code(day_type) code, sum(ot_paid_min) m from d where ot_paid_min > 0 group by 1, 2) x group by 1),
  nd as (select profile_id, jsonb_object_agg(code, round(m / 60.0, 2)) j from (
      select profile_id, case when day_type = 'ORDINARY' then '' else day_type end code, sum(nd_min) m from d where nd_min > 0 group by 1, 2
      union all
      select profile_id, public.payroll_ot_code(day_type), sum(nd_ot_min) from d where nd_ot_min > 0 group by 1, 2) x group by 1)
  select d.profile_id,
         count(*) filter (where d.status in ('present','incomplete'))::int,
         count(*) filter (where d.status = 'absent' and d.day_type = 'ORDINARY')::int,
         count(*) filter (where d.status = 'leave' and d.leave_paid and d.day_type = 'ORDINARY')::numeric,
         count(*) filter (where d.status = 'leave' and not coalesce(d.leave_paid, false) and d.day_type = 'ORDINARY')::numeric,
         count(*) filter (where d.status = 'holiday' and d.holiday_kind = 'REGULAR')::int,
         round(sum(d.regular_min) / 60.0, 2), round(sum(d.late_min) / 60.0, 2), round(sum(d.undertime_min) / 60.0, 2),
         coalesce(max(prem.j::text)::jsonb, '{}'), coalesce(max(ot.j::text)::jsonb, '{}'), coalesce(max(nd.j::text)::jsonb, '{}')
    from d
    left join prem on prem.profile_id = d.profile_id
    left join ot on ot.profile_id = d.profile_id
    left join nd on nd.profile_id = d.profile_id
   group by d.profile_id;
$$;


-- ---------------------------------------------------------------------
-- 5. Run actions
-- ---------------------------------------------------------------------
create or replace function public.payroll_run_create(p_period uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare per public.payroll_periods; new_id uuid;
begin
  if not public.has_perm('hr.payroll_runs', 'edit') then
    raise exception 'You need Edit access to Pay Runs.' using errcode = '42501';
  end if;
  select * into per from public.payroll_periods where id = p_period;
  if per.id is null then raise exception 'That pay period no longer exists.'; end if;
  if per.status <> 'locked' then raise exception 'Lock the timesheets for % first.', per.label; end if;
  if exists (select 1 from public.payroll_runs where period_id = p_period) then
    raise exception 'There''s already a pay run for %.', per.label;
  end if;
  insert into public.payroll_runs (period_id, created_by) values (p_period, auth.uid()) returning id into new_id;
  return new_id;
end $$;

create or replace function public.payroll_run_delete(p_run uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare st text;
begin
  if not public.has_perm('hr.payroll_runs', 'edit') then
    raise exception 'You need Edit access to Pay Runs.' using errcode = '42501';
  end if;
  select status into st from public.payroll_runs where id = p_run for update;
  if st is null then raise exception 'That pay run no longer exists.'; end if;
  if st not in ('draft','computed') then raise exception 'A % pay run can''t be deleted.', st; end if;
  delete from public.payroll_lines where run_id = p_run;
  delete from public.payroll_run_adjustments where run_id = p_run;
  delete from public.payroll_runs where id = p_run;
end $$;

-- cash-advance balances not yet settled → adjustments (skips ones already in a run that isn't released)
create or replace function public.payroll_run_add_cash_advances(p_run uuid)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.payroll_runs; n int;
begin
  if not public.has_perm('hr.payroll_runs', 'edit') then
    raise exception 'You need Edit access to Pay Runs.' using errcode = '42501';
  end if;
  select * into r from public.payroll_runs where id = p_run;
  if r.status not in ('draft','computed') then raise exception 'This pay run is % — send it back first.', r.status; end if;
  insert into public.payroll_run_adjustments (run_id, profile_id, kind, name, category, amount, is_taxable, source, ref_id, note, priority, allow_partial)
  select p_run, c.technician_id,
         case when s->>'type' = 'return' then 'deduction' else 'earning' end,
         case when s->>'type' = 'return' then 'Cash advance — unreturned excess' else 'Cash advance — reimbursement' end,
         case when s->>'type' = 'return' then 'CASH_ADVANCE' else 'REIMBURSEMENT' end,
         round((s->>'amount')::numeric, 2), false, 'cash_advance', c.id,
         'Cash advance of ' || to_char(c.submitted_at at time zone 'Asia/Manila', 'Mon DD, YYYY'), 1, false
    from public.cash_advance_requests c
    cross join lateral (select c.data->'liquidation'->'settlement' as s) x
   where c.status = 'approved'
     and c.data->'liquidation'->>'status' = 'approved'
     and s->>'type' in ('return','reimburse')
     and coalesce((s->>'settled')::boolean, false) = false
     and coalesce((s->>'amount')::numeric, 0) > 0
     and exists (select 1 from public.payroll_timesheets t where t.period_id = r.period_id and t.profile_id = c.technician_id)
     and not exists (select 1 from public.payroll_run_adjustments a join public.payroll_runs rr on rr.id = a.run_id
                      where a.ref_id = c.id and (rr.id = p_run or rr.status <> 'released'))
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- Everything the engine needs, for the Edge Function (called with the user's JWT)
create or replace function public.payroll_run_inputs(p_run uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r public.payroll_runs; per public.payroll_periods; rules jsonb; missing text; out jsonb;
begin
  if not public.has_perm('hr.payroll_runs', 'edit') then
    raise exception 'You need Edit access to Pay Runs.' using errcode = '42501';
  end if;
  select * into r from public.payroll_runs where id = p_run;
  if r.id is null then raise exception 'That pay run no longer exists.'; end if;
  if r.status not in ('draft','computed') then raise exception 'This pay run is % — send it back before computing again.', r.status; end if;
  select * into per from public.payroll_periods where id = r.period_id;
  if per.status <> 'locked' then raise exception 'The timesheets for % aren''t locked.', per.label; end if;

  select jsonb_object_agg(kind, jsonb_build_object('id', id, 'label', version_label, 'config', config)) into rules
    from public.payroll_rules
   where published_at is not null and effective_from <= per.pay_date and (effective_to is null or effective_to >= per.pay_date);
  select string_agg(k, ', ') into missing from unnest(array['sss','philhealth','pagibig','bir','labor']) k
   where not coalesce(rules ? k, false);
  if missing is not null then
    raise exception 'No published payroll rule for % on the pay date (%) — publish it in Payroll Rules.', missing, to_char(per.pay_date, 'Mon DD, YYYY');
  end if;

  select jsonb_build_object(
    'run', jsonb_build_object('id', r.id, 'status', r.status),
    'period', to_jsonb(per),
    'settings', (select to_jsonb(s) from public.payroll_settings s where id = 1),
    'rules', rules,
    'employees', coalesce((
      select jsonb_agg(jsonb_build_object(
        'profile_id', t.profile_id,
        'name', p.name,
        'employee', to_jsonb(e),
        'totals', to_jsonb(tt),
        'recurring', coalesce((select jsonb_agg(to_jsonb(ri) order by ri.kind, ri.code) from public.payroll_recurring_items ri
                                where ri.profile_id = t.profile_id and ri.is_active
                                  and (ri.start_date is null or ri.start_date <= per.pay_date)
                                  and (ri.end_date is null or ri.end_date >= per.pay_date)
                                  and (ri.balance is null or ri.balance > 0)), '[]'),
        'adjustments', coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at) from public.payroll_run_adjustments a
                                  where a.run_id = r.id and a.profile_id = t.profile_id), '[]'),
        -- earlier approved / released lines this year (month-to-date tax, 13th-month cap, de minimis limits)
        'history', coalesce((select jsonb_agg(jsonb_build_object('pay_date', l.pay_date, 'period_end', l.period_end, 'pay_frequency', l.pay_frequency,
                                    'taxable_income', l.taxable_income, 'withholding_tax', l.withholding_tax,
                                    'carry_forward', l.result->'carryForward') order by l.pay_date)
                               from public.payroll_lines l join public.payroll_runs rr on rr.id = l.run_id
                              where l.profile_id = t.profile_id and rr.id <> r.id and rr.status in ('approved','released')
                                and extract(year from l.period_end) = extract(year from per.period_end)
                                and l.period_end < per.period_end), '[]')
      ) order by p.name)
        from public.payroll_timesheets t
        join public.profiles p on p.id = t.profile_id
        join public.payroll_employees e on e.profile_id = t.profile_id
        left join public.payroll_period_totals_raw(per.id) tt on tt.profile_id = t.profile_id
       where t.period_id = per.id), '[]')
  ) into out;
  return out;
end $$;

-- Saves computed lines. Service role only (the payroll-compute Edge Function).
create or replace function public.payroll_run_store(p_run uuid, p_lines jsonb, p_rules jsonb, p_actor uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.payroll_runs; per public.payroll_periods; l jsonb; n_expected int; n_got int;
begin
  select * into r from public.payroll_runs where id = p_run for update;
  if r.id is null then raise exception 'That pay run no longer exists.'; end if;
  if r.status not in ('draft','computed') then raise exception 'This pay run is % — it can''t be recomputed.', r.status; end if;
  select * into per from public.payroll_periods where id = r.period_id;
  select count(*) into n_expected from public.payroll_timesheets t
    join public.payroll_employees e on e.profile_id = t.profile_id where t.period_id = per.id;
  n_got := jsonb_array_length(p_lines);
  if n_got <> n_expected then raise exception 'Expected % pay lines, got %.', n_expected, n_got; end if;
  delete from public.payroll_lines where run_id = p_run;
  for l in select * from jsonb_array_elements(p_lines) loop
    insert into public.payroll_lines (run_id, profile_id, pay_date, period_end, pay_frequency, input, result,
      gross, taxable_income, withholding_tax, ee_contrib, er_contrib, deductions, net, warnings)
    values (p_run, (l->>'profile_id')::uuid, per.pay_date, per.period_end, per.pay_frequency, l->'input', l->'result',
      (l->'result'->'totals'->>'grossPay')::numeric, (l->'result'->'totals'->>'taxableIncome')::numeric,
      (l->'result'->'totals'->>'withholdingTax')::numeric, (l->'result'->'totals'->>'employeeMandatoryContributions')::numeric,
      (l->'result'->'totals'->>'employerContributions')::numeric, (l->'result'->'totals'->>'totalDeductions')::numeric,
      (l->'result'->'totals'->>'netPay')::numeric, coalesce(l->'result'->'warnings', '[]'));
  end loop;
  update public.payroll_runs r2 set status = 'computed', computed_at = now(), computed_by = p_actor, rule_ids = p_rules,
         rule_labels = coalesce((select string_agg(v->>'label', ' · ' order by k) from jsonb_each(p_rules) x(k, v)), ''),
         headcount = x.n, total_gross = x.g, total_deductions = x.d, total_net = x.net, total_employer = x.er,
         total_cost = x.g + x.er, warnings = x.w, sent_back_note = ''
    from (select count(*) n, coalesce(sum(gross), 0) g, coalesce(sum(deductions), 0) d, coalesce(sum(net), 0) net,
                 coalesce(sum(er_contrib), 0) er, coalesce(sum(jsonb_array_length(warnings)), 0)::int w
            from public.payroll_lines where run_id = p_run) x
   where r2.id = p_run;
  perform public.log_activity_as(p_actor, 'compute', 'payroll_runs', p_run::text, per.label, jsonb_build_object('people', n_got));
end $$;

create or replace function public.payroll_run_submit(p_run uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.payroll_runs;
begin
  if not public.has_perm('hr.payroll_runs', 'edit') then
    raise exception 'You need Edit access to Pay Runs.' using errcode = '42501';
  end if;
  select * into r from public.payroll_runs where id = p_run for update;
  if r.status <> 'computed' then raise exception 'Compute the pay run before submitting it.'; end if;
  if r.headcount = 0 then raise exception 'Nobody is in this pay run.'; end if;
  update public.payroll_runs set status = 'submitted', submitted_at = now(), submitted_by = auth.uid() where id = p_run;
end $$;

create or replace function public.payroll_run_send_back(p_run uuid, p_reason text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.payroll_runs;
begin
  if not (public.has_perm('hr.payroll_runs', 'edit') or public.has_perm('fin.payroll_approve', 'approve')) then
    raise exception 'You don''t have access to send pay runs back.' using errcode = '42501';
  end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'Say why it''s being sent back.'; end if;
  select * into r from public.payroll_runs where id = p_run for update;
  if r.status <> 'submitted' then raise exception 'Only a submitted pay run can be sent back.'; end if;
  update public.payroll_runs set status = 'computed', submitted_at = null, submitted_by = null, sent_back_note = left(p_reason, 500) where id = p_run;
  perform public.log_activity_as(auth.uid(), 'send_back', 'payroll_runs', p_run::text,
    (select label from public.payroll_periods where id = r.period_id), jsonb_build_object('reason', p_reason));
end $$;

create or replace function public.payroll_run_approve(p_run uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.payroll_runs;
begin
  select * into r from public.payroll_runs where id = p_run for update;
  if r.id is null then raise exception 'That pay run no longer exists.'; end if;
  if r.status <> 'submitted' then raise exception 'Only a submitted pay run can be approved.'; end if;
  -- Approve access, limit on total net pay, not the person who computed it, password re-entry
  perform public.staff_approval_assert('fin.payroll_approve', r.total_net, r.computed_by);
  update public.payroll_runs set status = 'approved', approved_at = now(), approved_by = auth.uid() where id = p_run;
end $$;

create or replace function public.payroll_run_release(p_run uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.payroll_runs; per public.payroll_periods; a record; applied numeric; me text; n_ca int := 0; n_loans int := 0; ri record;
begin
  if not public.has_perm('fin.payroll_approve', 'edit') then
    raise exception 'You need Edit access to Payroll Approval to release pay.' using errcode = '42501';
  end if;
  select * into r from public.payroll_runs where id = p_run for update;
  if r.status <> 'approved' then raise exception 'Only an approved pay run can be released.'; end if;
  select * into per from public.payroll_periods where id = r.period_id;
  me := coalesce((select name from public.profiles where id = auth.uid()), 'Payroll');

  -- cash advances fully deducted / reimbursed → settled
  for a in select adj.*, l.result from public.payroll_run_adjustments adj
             join public.payroll_lines l on l.run_id = adj.run_id and l.profile_id = adj.profile_id
            where adj.run_id = p_run and adj.source = 'cash_advance' loop
    if a.kind = 'deduction' then
      select coalesce((d->>'appliedAmount')::numeric, 0) into applied
        from jsonb_array_elements(a.result->'voluntaryDeductions') d where d->>'code' = a.code;
    else
      applied := a.amount;
    end if;
    if coalesce(applied, 0) >= a.amount then
      perform set_config('awes.endorse_request', a.ref_id::text, true);   -- lets this one update past the cash-advance guard
      update public.cash_advance_requests
         set data = jsonb_set(data, '{liquidation,settlement}', coalesce(data->'liquidation'->'settlement', '{}'::jsonb) ||
               jsonb_build_object('settled', true, 'settledAt', now(), 'settledBy', me, 'method', 'Payroll — ' || per.label))
       where id = a.ref_id;
      perform set_config('awes.endorse_request', '', true);
      n_ca := n_ca + 1;
    end if;
  end loop;

  -- loan balances
  for ri in select i.id, i.balance, coalesce((d->>'appliedAmount')::numeric, 0) amt
              from public.payroll_lines l
              cross join lateral jsonb_array_elements(l.result->'voluntaryDeductions') d
              join public.payroll_recurring_items i on i.profile_id = l.profile_id and i.code = d->>'code' and i.kind = 'deduction'
             where l.run_id = p_run and i.balance is not null loop
    update public.payroll_recurring_items set balance = greatest(0, ri.balance - ri.amt),
           is_active = case when ri.balance - ri.amt <= 0 then false else is_active end where id = ri.id;
    n_loans := n_loans + 1;
  end loop;

  update public.payroll_runs set status = 'released', released_at = now(), released_by = auth.uid() where id = p_run;
  perform public.log_activity_as(auth.uid(), 'release', 'payroll_runs', p_run::text, per.label,
    jsonb_build_object('net', r.total_net, 'cash_advances_settled', n_ca, 'loans_updated', n_loans));
  return jsonb_build_object('cash_advances_settled', n_ca, 'loans_updated', n_loans);
end $$;


-- ---------------------------------------------------------------------
-- 6. Row-level security
-- ---------------------------------------------------------------------
alter table public.payroll_recurring_items enable row level security;
alter table public.payroll_runs            enable row level security;
alter table public.payroll_run_adjustments enable row level security;
alter table public.payroll_lines           enable row level security;

create or replace function public.payroll_run_reader()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public.has_perm('hr.payroll_runs', 'view') or public.has_perm('fin.payroll_approve', 'view');
$$;

-- (definer helpers so the runs ↔ lines policies don't read each other)
create or replace function public.payroll_run_released(p_run uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.payroll_runs where id = p_run and status = 'released');
$$;
create or replace function public.payroll_run_has_my_line(p_run uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.payroll_lines where run_id = p_run and profile_id = auth.uid());
$$;

drop policy if exists payroll_recurring_read on public.payroll_recurring_items;
create policy payroll_recurring_read on public.payroll_recurring_items for select to authenticated
  using (profile_id = auth.uid() or (select public.has_perm('hr.payroll_setup', 'view')) or (select public.payroll_run_reader()));
drop policy if exists payroll_recurring_write on public.payroll_recurring_items;
create policy payroll_recurring_write on public.payroll_recurring_items for all to authenticated
  using ((select public.has_perm('hr.payroll_setup', 'edit'))) with check ((select public.has_perm('hr.payroll_setup', 'edit')));

drop policy if exists payroll_runs_read on public.payroll_runs;
create policy payroll_runs_read on public.payroll_runs for select to authenticated
  using ((select public.payroll_run_reader())
         or (status = 'released' and public.payroll_run_has_my_line(id)));

drop policy if exists payroll_run_adj_read on public.payroll_run_adjustments;
create policy payroll_run_adj_read on public.payroll_run_adjustments for select to authenticated
  using ((select public.payroll_run_reader()));
drop policy if exists payroll_run_adj_write on public.payroll_run_adjustments;
create policy payroll_run_adj_write on public.payroll_run_adjustments for all to authenticated
  using ((select public.has_perm('hr.payroll_runs', 'edit'))) with check ((select public.has_perm('hr.payroll_runs', 'edit')));

drop policy if exists payroll_lines_read on public.payroll_lines;
create policy payroll_lines_read on public.payroll_lines for select to authenticated
  using ((select public.payroll_run_reader())
         or (profile_id = auth.uid() and public.payroll_run_released(run_id)));

-- names for the run screens
drop policy if exists profiles_select_for_payruns on public.profiles;
create policy profiles_select_for_payruns on public.profiles for select to authenticated
  using (role in ('technician','staff') and (select public.payroll_run_reader()));
-- payslip header needs the period and the employee's own number
drop policy if exists payroll_periods_read_runs on public.payroll_periods;
create policy payroll_periods_read_runs on public.payroll_periods for select to authenticated
  using ((select public.payroll_run_reader()));

revoke all on public.payroll_recurring_items, public.payroll_runs, public.payroll_run_adjustments, public.payroll_lines from anon, public;
grant select on public.payroll_recurring_items, public.payroll_runs, public.payroll_run_adjustments, public.payroll_lines to authenticated;
grant insert, update, delete on public.payroll_recurring_items to authenticated;
grant insert, delete on public.payroll_run_adjustments to authenticated;
grant update (name, amount, quantity, is_taxable, is_de_minimis, de_minimis_code, category, priority, allow_partial, note) on public.payroll_run_adjustments to authenticated;

revoke execute on function public.payroll_run_create(uuid), public.payroll_run_delete(uuid), public.payroll_run_add_cash_advances(uuid),
  public.payroll_run_inputs(uuid), public.payroll_run_submit(uuid), public.payroll_run_send_back(uuid, text),
  public.payroll_run_approve(uuid), public.payroll_run_release(uuid), public.payroll_run_reader() from public, anon;
grant execute on function public.payroll_run_create(uuid), public.payroll_run_delete(uuid), public.payroll_run_add_cash_advances(uuid),
  public.payroll_run_inputs(uuid), public.payroll_run_submit(uuid), public.payroll_run_send_back(uuid, text),
  public.payroll_run_approve(uuid), public.payroll_run_release(uuid), public.payroll_run_reader() to authenticated, service_role;
-- the only way numbers get into payslips
revoke execute on function public.payroll_run_store(uuid, jsonb, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.payroll_run_store(uuid, jsonb, jsonb, uuid) to service_role;
revoke execute on function public.payroll_period_totals_raw(uuid) from public, anon, authenticated;
grant execute on function public.payroll_period_totals_raw(uuid) to service_role;
revoke execute on function public.payroll_run_adj_guard(), public.payroll_recurring_before() from public, anon, authenticated;

do $$ begin
  if to_regprocedure('public.activity_log_trigger()') is not null then
    drop trigger if exists trg_activity_log on public.payroll_runs;
    create trigger trg_activity_log after insert or update or delete on public.payroll_runs
      for each row execute function public.activity_log_trigger();
    drop trigger if exists trg_activity_log on public.payroll_run_adjustments;
    create trigger trg_activity_log after insert or update or delete on public.payroll_run_adjustments
      for each row execute function public.activity_log_trigger();
    drop trigger if exists trg_activity_log on public.payroll_recurring_items;
    create trigger trg_activity_log after insert or update or delete on public.payroll_recurring_items
      for each row execute function public.activity_log_trigger();
  end if;
end $$;

commit;

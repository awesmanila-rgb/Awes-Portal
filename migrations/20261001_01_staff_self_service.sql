-- =====================================================================
-- AWES App — "My HR" for office staff: attendance, leave, cash advance,
-- liquidation and reimbursement, with Head endorsement and a team view
--
-- Office staff (Heads and sub-users) now use the same self-service HR as
-- technicians. Their records live in the same tables (dtr_records,
-- leave_requests, cash_advance_requests), filed under their own id — the
-- existing rules already let each person file and read only their own.
--
-- NEW
--   request_endorsements   A sub-user's leave, cash advance or
--       reimbursement first waits for their Head. HR / Finance cannot
--       approve it until the Head endorses (the database refuses; only the
--       Super Admin can override). A Head who declines closes it as
--       disapproved, with their reason. Heads' own requests, and
--       technicians', need no endorsement.
--   staff_endorse()        the one way to endorse / decline (Head of that
--       person, or the Super Admin).
--   Team view (read only)  a Head reads their own sub-users' attendance,
--       leave and cash requests — nobody else's, and can't change them.
--   HR reads office staff names (attendance table, profiles) with an HR page.
--   Inbox                  "…to endorse (your team)" items for the Head;
--       HR / Finance "to approve" items appear only once endorsed.
--   Department Heads' own requests   decided by the SUPER ADMIN only:
--       approving / disapproving their leave, cash advance and
--       reimbursement, and reviewing their liquidation. HR / Finance staff
--       are refused; the Inbox and escalations route these to the Super
--       Admin. (Finance still records cash given and settlements once the
--       Super Admin has approved.)
--
-- Attendance: office staff use the same rules as technicians — one
-- registered device, location recorded at time-in and time-out (the
-- screens; device_locks already works per person). They are not shown on
-- the field Live Tracker.
--
-- This migration holds the current versions of guard_leave_decision,
-- guard_cash_decision, inbox_all_items, inbox_items and inbox_escalations_due;
-- the older copies in 20260926_04 / _05 / 20260928_01 skip themselves once
-- it's installed.
-- Requires 20260926_01 … 20260930_01. Idempotent.
-- =====================================================================

begin;

do $$ begin
  if to_regprocedure('public.inbox_items()') is null or to_regprocedure('public.app_is_internal()') is null then
    raise exception 'Run the earlier migrations (20260926_01 … 20260930_01) first.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. Endorsements
-- ---------------------------------------------------------------------
create table if not exists public.request_endorsements (
  request_kind  text not null check (request_kind in ('leave', 'cash')),   -- cash = advance or reimbursement
  request_id    uuid not null,
  requester     uuid not null references public.profiles(id) on delete cascade,
  head          uuid not null references public.profiles(id) on delete cascade,
  status        text not null default 'pending' check (status in ('pending', 'endorsed', 'declined')),
  comment       text not null default '',
  decided_at    timestamptz,
  decided_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  primary key (request_kind, request_id)
);
create index if not exists request_endorsements_head_idx on public.request_endorsements (head) where status = 'pending';

alter table public.request_endorsements enable row level security;
drop policy if exists request_endorsements_read on public.request_endorsements;
create policy request_endorsements_read on public.request_endorsements for select to authenticated
  using (public.is_admin() or requester = auth.uid() or public.is_supervisor_of(requester)
         or (request_kind = 'leave' and (select public.has_perm('hr.leaves', 'view')))
         or (request_kind = 'cash' and ((select public.has_perm('fin.cash_advance', 'view')) or (select public.has_perm('fin.reimbursement', 'view'))
                                        or (select public.has_perm('fin.liquidation', 'view')))));
revoke all on public.request_endorsements from anon;
grant select on public.request_endorsements to authenticated;
revoke insert, update, delete on public.request_endorsements from authenticated;

-- A new request from a sub-user opens an endorsement for their Head
create or replace function public.staff_request_open_endorsement()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_sup uuid;
begin
  select supervisor_id into v_sup from public.profiles where id = new.technician_id and role = 'staff';
  if v_sup is not null and public.staff_is_active(v_sup) then
    insert into public.request_endorsements (request_kind, request_id, requester, head)
    values (case tg_table_name when 'leave_requests' then 'leave' else 'cash' end, new.id, new.technician_id, v_sup)
    on conflict do nothing;
  end if;
  return null;
end;
$$;
drop trigger if exists trg_open_endorsement on public.leave_requests;
create trigger trg_open_endorsement after insert on public.leave_requests
  for each row execute function public.staff_request_open_endorsement();
drop trigger if exists trg_open_endorsement on public.cash_advance_requests;
create trigger trg_open_endorsement after insert on public.cash_advance_requests
  for each row execute function public.staff_request_open_endorsement();

-- Endorse or decline (the Head of that person, or the Super Admin)
create or replace function public.staff_endorse(p_kind text, p_request uuid, p_decision text, p_comment text default '')
returns text
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare e public.request_endorsements; me text; now_j jsonb := to_jsonb(now()); reason text;
begin
  select * into e from public.request_endorsements where request_kind = p_kind and request_id = p_request;
  if not found then raise exception 'There is nothing to endorse for this request.' using errcode = 'P0001'; end if;
  if not (public.is_admin() or (public.is_staff() and public.is_supervisor_of(e.requester))) then
    raise exception 'Only this person''s Head can endorse their requests.' using errcode = '42501';
  end if;
  if e.status <> 'pending' then raise exception 'This request was already %.', e.status using errcode = 'P0001'; end if;
  if p_decision not in ('endorse', 'decline') then raise exception 'Choose endorse or decline.' using errcode = 'P0001'; end if;
  if p_decision = 'decline' and coalesce(trim(p_comment), '') = '' then
    raise exception 'Give a reason for declining — the person will see it.' using errcode = 'P0001';
  end if;
  me := coalesce((select nullif(name, '') from public.profiles where id = auth.uid()), 'Head');

  update public.request_endorsements
     set status = case when p_decision = 'endorse' then 'endorsed' else 'declined' end,
         comment = coalesce(trim(p_comment), ''), decided_at = now(), decided_by = auth.uid()
   where request_kind = p_kind and request_id = p_request;

  if p_decision = 'decline' then
    reason := 'Declined by ' || me || ': ' || trim(p_comment);
    perform set_config('awes.endorse_request', p_request::text, true);
    if p_kind = 'leave' then
      update public.leave_requests set status = 'disapproved',
             data = coalesce(data, '{}'::jsonb) || jsonb_build_object('status', 'disapproved', 'comment', reason, 'decidedBy', me, 'decidedAt', now_j)
       where id = p_request and status = 'pending';
    else
      update public.cash_advance_requests set status = 'disapproved',
             data = coalesce(data, '{}'::jsonb) || jsonb_build_object('status', 'disapproved', 'comment', reason, 'decidedBy', me, 'decidedAt', now_j)
       where id = p_request and status = 'pending';
    end if;
    perform set_config('awes.endorse_request', '', true);
  end if;

  perform public.log_activity_as(auth.uid(), 'staff.' || p_decision, case p_kind when 'leave' then 'leave_requests' else 'cash_advance_requests' end,
    p_request::text, coalesce((select name from public.profiles where id = e.requester), ''), jsonb_build_object('comment', p_comment));
  return case when p_decision = 'endorse' then 'endorsed' else 'declined' end;
end;
$$;
revoke execute on function public.staff_endorse(text, uuid, text, text) from public, anon;
grant execute on function public.staff_endorse(text, uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- Department Heads' requests are decided by the Super Admin
-- ---------------------------------------------------------------------
create or replace function public.staff_is_head(p_user uuid)
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.staff_departments d join public.profiles p on p.id = d.user_id
                  where d.user_id = p_user and d.is_head and p.role = 'staff');
$$;
revoke execute on function public.staff_is_head(uuid) from public, anon, authenticated;
grant execute on function public.staff_is_head(uuid) to service_role;

-- For reviewer screens: which of these requesters are department Heads
-- (company people only — never customers or signed-out visitors)
create or replace function public.staff_heads_among(p_ids uuid[])
returns uuid[] language sql stable security definer
set search_path = public, pg_temp
as $$
  select case when public.app_is_internal()
              then coalesce((select array_agg(distinct u) from unnest(p_ids) u where public.staff_is_head(u)), '{}')
              else '{}'::uuid[] end;
$$;
revoke execute on function public.staff_heads_among(uuid[]) from public, anon;
grant execute on function public.staff_heads_among(uuid[]) to authenticated;

-- ---------------------------------------------------------------------
-- 2. Decision guards: nothing is approved before the Head endorses
--    (current versions — the copies in 20260926_04 / _05 skip themselves)
-- ---------------------------------------------------------------------
create or replace function public.guard_leave_decision()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old public.leave_requests%rowtype;
  v_is_new boolean;
  s_keys text[] := array['status','comment','decidedAt','decidedBy'];
  s_me text;
begin
  -- A Head declining through staff_endorse(): the one change it makes (the
  -- request becomes disapproved, with the Head's reason) is allowed here.
  if tg_op = 'UPDATE' and coalesce(current_setting('awes.endorse_request', true), '') = old.id::text then
    return new;
  end if;
  if public.is_admin() then
    return new;
  end if;

  -- ---- Department staff deciding someone else's request ---------------
  if tg_op = 'UPDATE' and public.is_staff() and old.technician_id is distinct from auth.uid() then
    new.id := old.id; new.technician_id := old.technician_id; new.submitted_at := old.submitted_at;
    if (coalesce(new.data, '{}'::jsonb) - s_keys) is distinct from (coalesce(old.data, '{}'::jsonb) - s_keys) then
      raise exception 'Only the person who filed this leave can change what''s in it.' using errcode = '42501';
    end if;
    if new.status is distinct from old.status or (new.data->'status') is distinct from (old.data->'status') then
      if old.status <> 'pending' then
        raise exception 'This leave request was already %.', old.status using errcode = 'P0001';
      end if;
      if new.status not in ('approved', 'disapproved') then
        raise exception 'A leave request can only be approved or disapproved.' using errcode = 'P0001';
      end if;
      if public.staff_is_head(old.technician_id) then
        raise exception 'Requests from department Heads are decided by the Super Admin.' using errcode = '42501';
      end if;
      if exists (select 1 from public.request_endorsements e
                  where e.request_kind = 'leave' and e.request_id = old.id and e.status = 'pending') then
        raise exception 'Waiting for %''s endorsement first.',
          coalesce((select p.name from public.request_endorsements e join public.profiles p on p.id = e.head
                     where e.request_kind = 'leave' and e.request_id = old.id), 'the Head') using errcode = 'P0001';
      end if
;
      perform public.staff_approval_assert('hr.leaves', null, old.technician_id);
      s_me := coalesce((select nullif(name, '') from public.profiles where id = auth.uid()), 'Staff');
      new.data := coalesce(new.data, '{}'::jsonb) || jsonb_build_object(
        'status', new.status, 'comment', coalesce(new.data->'comment', '""'::jsonb),
        'decidedBy', s_me, 'decidedAt', to_jsonb(now()));
    else
      new.status := old.status;
      new.data := old.data;          -- nothing else a reviewer may change
    end if;
    return new;
  end if;

  -- ---- Technician (own request) — unchanged from 20260822_01 ----------
  if tg_op = 'UPDATE' then
    v_old := old;
    v_is_new := false;
  else
    select * into v_old from public.leave_requests where id = new.id;
    v_is_new := not found;
  end if;

  if v_is_new then
    new.status := 'pending';
    new.data := coalesce(new.data, '{}'::jsonb) || jsonb_build_object(
      'status',    'pending',
      'comment',   '',
      'decidedAt', null,
      'decidedBy', null);
    return new;
  end if;

  new.id := v_old.id;
  new.technician_id := v_old.technician_id;
  new.status := v_old.status;
  new.submitted_at := v_old.submitted_at;
  new.data := coalesce(new.data, '{}'::jsonb) || jsonb_build_object(
    'status',    coalesce(v_old.data -> 'status', to_jsonb(v_old.status)),
    'comment',   coalesce(v_old.data -> 'comment', '""'::jsonb),
    'decidedAt', coalesce(v_old.data -> 'decidedAt', 'null'::jsonb),
    'decidedBy', coalesce(v_old.data -> 'decidedBy', 'null'::jsonb));
  return new;
end;
$$;;

create or replace function public.guard_cash_decision()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old public.cash_advance_requests%rowtype;
  v_is_new boolean;
  v_old_liq jsonb;
  v_new_liq jsonb;
  -- staff path
  s_mod text; s_me text; s_now jsonb; o jsonb; n jsonb; ol jsonb; nl jsonb;
  s_req_keys text[] := array['status','comment','decidedAt','decidedBy','disbursed','dateGiven','amountGiven','disbursedAt','disbursedBy','liquidation'];
  s_pay_keys text[] := array['disbursed','dateGiven','amountGiven','disbursedAt','disbursedBy'];
  s_liq_keys text[] := array['status','comment','decidedAt','decidedBy','settlement'];
  s_given numeric; s_total numeric; s_diff numeric;
begin
  -- A Head declining through staff_endorse(): the one change it makes (the
  -- request becomes disapproved, with the Head's reason) is allowed here.
  if tg_op = 'UPDATE' and coalesce(current_setting('awes.endorse_request', true), '') = old.id::text then
    return new;
  end if;
  if public.is_admin() then
    return new;
  end if;

  -- ---- Department staff acting on someone else's request ------------
  if tg_op = 'UPDATE' and public.is_staff() and old.technician_id is distinct from auth.uid() then
    s_mod := public.cash_module(old.data);
    s_me  := coalesce((select nullif(name, '') from public.profiles where id = auth.uid()), 'Staff');
    s_now := to_jsonb(now());
    o := coalesce(old.data, '{}'::jsonb);
    n := coalesce(new.data, '{}'::jsonb);
    new.id := old.id; new.technician_id := old.technician_id; new.submitted_at := old.submitted_at;

    if (n - s_req_keys) is distinct from (o - s_req_keys) then
      raise exception 'Only the person who filed this request can change what''s in it.' using errcode = '42501';
    end if;

    -- a) approve / disapprove
    if new.status is distinct from old.status or (n->'status') is distinct from (o->'status') then
      if old.status <> 'pending' then
        raise exception 'This request was already %.', old.status using errcode = 'P0001';
      end if;
      if new.status not in ('approved', 'disapproved') then
        raise exception 'A request can only be approved or disapproved.' using errcode = 'P0001';
      end if;
      if public.staff_is_head(old.technician_id) then
        raise exception 'Requests from department Heads are decided by the Super Admin.' using errcode = '42501';
      end if;
      if exists (select 1 from public.request_endorsements e
                  where e.request_kind = 'cash' and e.request_id = old.id and e.status = 'pending') then
        raise exception 'Waiting for %''s endorsement first.',
          coalesce((select p.name from public.request_endorsements e join public.profiles p on p.id = e.head
                     where e.request_kind = 'cash' and e.request_id = old.id), 'the Head') using errcode = 'P0001';
      end if
;
      perform public.staff_approval_assert(s_mod, nullif(o->>'amount', '')::numeric, old.technician_id);
      n := n || jsonb_build_object('status', new.status, 'comment', coalesce(n->'comment', '""'::jsonb),
                                   'decidedBy', s_me, 'decidedAt', s_now);
    else
      new.status := old.status;
      n := n || jsonb_build_object(
        'status',    coalesce(o->'status', to_jsonb(old.status)),
        'comment',   coalesce(o->'comment', '""'::jsonb),
        'decidedAt', coalesce(o->'decidedAt', 'null'::jsonb),
        'decidedBy', coalesce(o->'decidedBy', 'null'::jsonb));
    end if;

    -- b) cash given / reimbursement paid
    if (select jsonb_object_agg(k, n->k) from unnest(s_pay_keys) k) is distinct from
       (select jsonb_object_agg(k, o->k) from unnest(s_pay_keys) k) then
      if not public.has_perm(s_mod, 'edit') then
        raise exception 'You need Edit access for % to record a payment.',
          (select label from public.app_modules where key = s_mod) using errcode = '42501';
      end if;
      if new.status <> 'approved' then
        raise exception 'Approve the request before recording the payment.' using errcode = 'P0001';
      end if;
      if coalesce((o->>'disbursed')::boolean, false) then
        raise exception 'The payment was already recorded.' using errcode = 'P0001';
      end if;
      if coalesce(nullif(n->>'amountGiven', '')::numeric, 0) <= 0 or coalesce(n->>'dateGiven', '') = '' then
        raise exception 'Enter the date and the amount given.' using errcode = 'P0001';
      end if;
      n := n || jsonb_build_object('disbursed', true, 'disbursedBy', s_me, 'disbursedAt', s_now);
    end if;

    -- c) liquidation verdict / settlement
    ol := o->'liquidation'; nl := n->'liquidation';
    if nl is distinct from ol then
      if s_mod = 'fin.reimbursement' or ol is null or jsonb_typeof(ol) <> 'object' or nl is null or jsonb_typeof(nl) <> 'object' then
        raise exception 'There is no liquidation to review.' using errcode = 'P0001';
      end if;
      if (nl - s_liq_keys) is distinct from (ol - s_liq_keys) then
        raise exception 'Only the technician can change the liquidation itself.' using errcode = '42501';
      end if;
      if (nl->'status') is distinct from (ol->'status') then
        if ol->>'status' = 'approved' then
          raise exception 'This liquidation was already approved.' using errcode = 'P0001';
        end if;
        if nl->>'status' not in ('approved', 'disapproved') then
          raise exception 'A liquidation can only be approved or disapproved.' using errcode = 'P0001';
        end if;
        if public.staff_is_head(old.technician_id) then
          raise exception 'Liquidations from department Heads are reviewed by the Super Admin.' using errcode = '42501';
        end if;
        perform public.staff_approval_assert('fin.liquidation', nullif(ol->>'totalAmount', '')::numeric, old.technician_id);
        nl := nl || jsonb_build_object('decidedBy', s_me, 'decidedAt', s_now);
        if nl->>'status' = 'approved' then
          -- the balance is worked out here, not taken from the screen
          s_given := coalesce(nullif(o->>'amountGiven', '')::numeric, 0);
          s_total := coalesce(nullif(ol->>'totalAmount', '')::numeric, 0);
          s_diff  := s_given - s_total;
          nl := nl || jsonb_build_object('settlement', case when abs(s_diff) < 0.005 then
              jsonb_build_object('type', 'none', 'amount', 0, 'settled', true, 'settledAt', s_now, 'settledBy', s_me, 'method', null)
            else
              jsonb_build_object('type', case when s_diff > 0 then 'return' else 'reimburse' end, 'amount', round(abs(s_diff), 2),
                                 'settled', false, 'settledAt', null, 'settledBy', null, 'method', null)
            end);
        else
          nl := nl - 'settlement';
        end if;
      elsif (nl->'settlement') is distinct from (ol->'settlement') then
        if not public.has_perm('fin.liquidation', 'edit') then
          raise exception 'You need Edit access for Liquidation to settle a balance.' using errcode = '42501';
        end if;
        if ol->'settlement' is null or coalesce((ol->'settlement'->>'settled')::boolean, false) then
          raise exception 'There is no open balance to settle.' using errcode = 'P0001';
        end if;
        nl := jsonb_set(ol, '{settlement}', (ol->'settlement') || jsonb_build_object(
                'settled', true, 'settledAt', s_now, 'settledBy', s_me,
                'method', coalesce(nl->'settlement'->'method', '""'::jsonb)));
      else
        nl := ol;     -- nothing else in the verdict may be edited on its own
      end if;
      n := jsonb_set(n, '{liquidation}', nl);
    end if;

    new.data := n;
    return new;
  end if;

  -- ---- Technician (own request) — unchanged from 20260822_01 ----------
  if tg_op = 'UPDATE' then
    v_old := old;
    v_is_new := false;
  else
    select * into v_old from public.cash_advance_requests where id = new.id;
    v_is_new := not found;
  end if;

  if v_is_new then
    new.status := 'pending';
    new.data := coalesce(new.data, '{}'::jsonb) || jsonb_build_object(
      'status',       'pending',
      'comment',      '',
      'decidedAt',    null,
      'decidedBy',    null,
      'disbursed',    false,
      'dateGiven',    null,
      'amountGiven',  null,
      'disbursedAt',  null,
      'disbursedBy',  null,
      'liquidation',  null);
    return new;
  end if;

  new.id := v_old.id;
  new.technician_id := v_old.technician_id;
  new.status := v_old.status;
  new.submitted_at := v_old.submitted_at;

  new.data := coalesce(new.data, '{}'::jsonb) || jsonb_build_object(
    'status',      coalesce(v_old.data -> 'status', to_jsonb(v_old.status)),
    'comment',     coalesce(v_old.data -> 'comment', '""'::jsonb),
    'decidedAt',   coalesce(v_old.data -> 'decidedAt', 'null'::jsonb),
    'decidedBy',   coalesce(v_old.data -> 'decidedBy', 'null'::jsonb),
    'disbursed',   coalesce(v_old.data -> 'disbursed', 'false'::jsonb),
    'dateGiven',   coalesce(v_old.data -> 'dateGiven', 'null'::jsonb),
    'amountGiven', coalesce(v_old.data -> 'amountGiven', 'null'::jsonb),
    'disbursedAt', coalesce(v_old.data -> 'disbursedAt', 'null'::jsonb),
    'disbursedBy', coalesce(v_old.data -> 'disbursedBy', 'null'::jsonb));

  v_old_liq := v_old.data -> 'liquidation';
  v_new_liq := new.data -> 'liquidation';

  if v_new_liq is not null and jsonb_typeof(v_new_liq) = 'object' then
    if v_old_liq is null or jsonb_typeof(v_old_liq) <> 'object' then
      v_new_liq := v_new_liq || jsonb_build_object(
        'status', 'pending', 'comment', '', 'decidedAt', null, 'decidedBy', null);
    else
      v_new_liq := v_new_liq || jsonb_build_object(
        'status',    coalesce(v_old_liq -> 'status', '"pending"'::jsonb),
        'comment',   coalesce(v_old_liq -> 'comment', '""'::jsonb),
        'decidedAt', coalesce(v_old_liq -> 'decidedAt', 'null'::jsonb),
        'decidedBy', coalesce(v_old_liq -> 'decidedBy', 'null'::jsonb));
    end if;
    new.data := jsonb_set(new.data, '{liquidation}', v_new_liq);
  elsif v_old_liq is not null then
    new.data := jsonb_set(new.data, '{liquidation}', v_old_liq);
  end if;

  return new;
end;
$$;;

-- ---------------------------------------------------------------------
-- 3. Team view for Heads (read only) and staff names for HR
--    (separate rules, added to the existing ones)
-- ---------------------------------------------------------------------
drop policy if exists dtr_select_team on public.dtr_records;
create policy dtr_select_team on public.dtr_records for select to authenticated using (public.is_supervisor_of(technician_id));
drop policy if exists leave_select_team on public.leave_requests;
create policy leave_select_team on public.leave_requests for select to authenticated using (public.is_supervisor_of(technician_id));
drop policy if exists cash_select_team on public.cash_advance_requests;
create policy cash_select_team on public.cash_advance_requests for select to authenticated using (public.is_supervisor_of(technician_id));

drop policy if exists profiles_select_staff_for_hr on public.profiles;
create policy profiles_select_staff_for_hr on public.profiles for select to authenticated
  using (role = 'staff' and ((select public.has_perm('hr.staff_attendance', 'view')) or (select public.has_perm('hr.leaves', 'view'))
                             or (select public.has_perm('hr.tech_profiles', 'view'))));

-- ---------------------------------------------------------------------
-- 4. Inbox: endorsement items; approvals only once endorsed
--    (current versions — the copies in 20260928_01 skip themselves)
-- ---------------------------------------------------------------------
insert into public.inbox_sla (kind, label, department, module, level, warn_hours, escalate_hours, sort) values
  ('leave_endorse', 'Leave to endorse (your team)',         'hr',      'hr.leaves',         'view', 24, 48, 29),
  ('ca_endorse',    'Cash advance to endorse (your team)',  'finance', 'fin.cash_advance',  'view',  8, 24, 19),
  ('rb_endorse',    'Reimbursement to endorse (your team)', 'finance', 'fin.reimbursement', 'view', 24, 72, 27)
on conflict (kind) do update set label = excluded.label, department = excluded.department, module = excluded.module, level = excluded.level, sort = excluded.sort;

create or replace function public.inbox_all_items()
returns table (kind text, ref_id text, ref_label text, title text, since timestamptz, owner uuid)
language sql stable security definer
set search_path = public, pg_temp
as $$
  -- Purchasing
  select 'mr_review', m.id::text, coalesce(m.mrf_no, ''), 'From ' || coalesce(nullif(m.requester_name, ''), 'a technician'),
         coalesce(m.submitted_at, m.updated_at), m.requested_by
    from public.material_requisitions m where m.status = 'submitted'
  union all
  select 'mr_fulfil', m.id::text, coalesce(m.mrf_no, ''), 'Approved — ' || coalesce(nullif(m.requester_name, ''), 'a technician') || ' is waiting',
         coalesce(m.reviewed_at, m.updated_at), null::uuid
    from public.material_requisitions m where m.status = 'approved' and m.fulfilled_at is null
  union all
  select 'po_draft', p.id::text, coalesce(p.po_no, ''), coalesce(p.supplier_snapshot->>'name', 'Draft purchase order'), p.created_at, p.created_by
    from public.purchase_orders p where p.status = 'draft'
  union all
  select 'po_receive', p.id::text, coalesce(p.po_no, ''), coalesce(p.supplier_snapshot->>'name', 'Purchase order') || ' — items still to receive',
         coalesce(p.issued_at, p.updated_at), null::uuid
    from public.purchase_orders p
   where p.status = 'issued'
     and exists (select 1 from public.purchase_order_items i where i.po_id = p.id and i.qty_received < i.qty)
  -- Accounting & Finance
  union all
  select 'ca_approve', c.id::text, '₱' || to_char(coalesce(nullif(c.data->>'amount','')::numeric, 0), 'FM999,999,990.00'),
         coalesce(nullif(c.data->>'technicianName',''), nullif(c.data->>'userName',''), 'Cash advance'), c.submitted_at, c.technician_id
    from public.cash_advance_requests c where c.status = 'pending' and public.cash_module(c.data) = 'fin.cash_advance' and not exists (select 1 from public.request_endorsements e where e.request_kind = 'cash' and e.request_id = c.id and e.status <> 'endorsed')
  union all
  select 'ca_release', c.id::text, '₱' || to_char(coalesce(nullif(c.data->>'amount','')::numeric, 0), 'FM999,999,990.00'),
         coalesce(nullif(c.data->>'technicianName',''), nullif(c.data->>'userName',''), 'Cash advance') || ' — cash not yet given',
         coalesce(nullif(c.data->>'decidedAt','')::timestamptz, c.submitted_at), null::uuid
    from public.cash_advance_requests c
   where c.status = 'approved' and public.cash_module(c.data) = 'fin.cash_advance' and not coalesce((c.data->>'disbursed')::boolean, false)
  union all
  select 'liq_submit', c.id::text, '₱' || to_char(coalesce(nullif(c.data->>'amountGiven','')::numeric, 0), 'FM999,999,990.00'),
         coalesce(nullif(c.data->>'technicianName',''), nullif(c.data->>'userName',''), 'Cash advance') || ' — not yet liquidated',
         coalesce(nullif(c.data->>'dateGiven','')::date::timestamptz, nullif(c.data->>'disbursedAt','')::timestamptz), null::uuid
    from public.cash_advance_requests c
   where public.cash_module(c.data) = 'fin.cash_advance' and coalesce((c.data->>'disbursed')::boolean, false)
     and (c.data->'liquidation' is null or jsonb_typeof(c.data->'liquidation') <> 'object')
  union all
  select 'liq_review', c.id::text, '₱' || to_char(coalesce(nullif(c.data->'liquidation'->>'totalAmount','')::numeric, 0), 'FM999,999,990.00'),
         coalesce(nullif(c.data->>'technicianName',''), nullif(c.data->>'userName',''), 'Liquidation'),
         coalesce(nullif(c.data->'liquidation'->>'submittedAt','')::timestamptz, c.submitted_at), c.technician_id
    from public.cash_advance_requests c
   where public.cash_module(c.data) = 'fin.cash_advance' and c.data->'liquidation'->>'status' = 'pending'
  union all
  select 'liq_settle', c.id::text, '₱' || to_char(coalesce(nullif(c.data->'liquidation'->'settlement'->>'amount','')::numeric, 0), 'FM999,999,990.00'),
         coalesce(nullif(c.data->>'technicianName',''), nullif(c.data->>'userName',''), 'Liquidation') || ' — '
           || case c.data->'liquidation'->'settlement'->>'type' when 'return' then 'to return' else 'to reimburse' end,
         coalesce(nullif(c.data->'liquidation'->>'decidedAt','')::timestamptz, c.submitted_at), null::uuid
    from public.cash_advance_requests c
   where public.cash_module(c.data) = 'fin.cash_advance' and c.data->'liquidation'->>'status' = 'approved'
     and c.data->'liquidation'->'settlement' is not null
     and not coalesce((c.data->'liquidation'->'settlement'->>'settled')::boolean, false)
  union all
  select 'rb_approve', c.id::text, '₱' || to_char(coalesce(nullif(c.data->>'amount','')::numeric, 0), 'FM999,999,990.00'),
         coalesce(nullif(c.data->>'technicianName',''), nullif(c.data->>'userName',''), 'Reimbursement'), c.submitted_at, c.technician_id
    from public.cash_advance_requests c where c.status = 'pending' and public.cash_module(c.data) = 'fin.reimbursement' and not exists (select 1 from public.request_endorsements e where e.request_kind = 'cash' and e.request_id = c.id and e.status <> 'endorsed')
  union all
  select 'rb_pay', c.id::text, '₱' || to_char(coalesce(nullif(c.data->>'amount','')::numeric, 0), 'FM999,999,990.00'),
         coalesce(nullif(c.data->>'technicianName',''), nullif(c.data->>'userName',''), 'Reimbursement') || ' — not yet paid',
         coalesce(nullif(c.data->>'decidedAt','')::timestamptz, c.submitted_at), null::uuid
    from public.cash_advance_requests c
   where c.status = 'approved' and public.cash_module(c.data) = 'fin.reimbursement' and not coalesce((c.data->>'disbursed')::boolean, false)
  -- Human Resources
  union all
  select 'leave_decide', l.id::text,
         coalesce(nullif(l.data->>'dateFrom',''), nullif(l.data->>'from',''), ''),
         coalesce(nullif(l.data->>'userName',''), nullif(l.data->>'technicianName',''), (select name from public.profiles where id = l.technician_id), 'Leave')
           || ' — ' || coalesce(nullif(l.data->>'leaveType',''), nullif(l.data->>'type',''), 'leave'),
         l.submitted_at, l.technician_id
    from public.leave_requests l where l.status = 'pending' and not exists (select 1 from public.request_endorsements e where e.request_kind = 'leave' and e.request_id = l.id and e.status <> 'endorsed')
  -- Operations
  union all
  select 'sr_new', r.id::text, left(r.description, 60), coalesce((select name from public.customers where id = r.customer_id), 'Service request'), r.created_at, null::uuid
    from public.service_requests r where r.status = 'new'
  union all
  select 'jo_late', t.id, t.id, coalesce(nullif(t.data->>'custName',''), nullif(t.data->>'customer',''), 'Job order') || ' — scheduled ' || (t.data->>'date'),
         ((nullif(t.data->>'date','')::date + 1)::timestamp at time zone 'Asia/Manila'), null::uuid
    from public.dispatch_tickets t
   where t.status in ('open', 'acknowledged', 'preparing', 'scheduled')
     and nullif(t.data->>'date','')::date < public.manila_today()
  union all
  select 'tool_defect', d.id::text, coalesce(d.defect_no, ''),
         coalesce((select asset_tag || ' ' || name from public.tools where id = d.tool_id), 'Tool') || ' — ' || left(coalesce(d.description, ''), 60),
         d.created_at, null::uuid
    from public.tool_defects d where d.status = 'open'
  -- A sub-user's request waiting for their Head (the Head acts: endorse / decline)
  union all
  select case when e.request_kind = 'leave' then 'leave_endorse'
              when public.cash_module(c.data) = 'fin.reimbursement' then 'rb_endorse' else 'ca_endorse' end,
         e.request_id::text,
         case when e.request_kind = 'leave' then coalesce(nullif(l.data->>'dateFrom',''), nullif(l.data->>'from',''), '')
              else '₱' || to_char(coalesce(nullif(c.data->>'amount','')::numeric, 0), 'FM999,999,990.00') end,
         coalesce((select name from public.profiles where id = e.requester), 'Your team') || ' — ' ||
           case when e.request_kind = 'leave' then coalesce(nullif(l.data->>'leaveType',''), 'leave')
                when public.cash_module(c.data) = 'fin.reimbursement' then 'reimbursement' else 'cash advance' end,
         e.created_at, e.requester
    from public.request_endorsements e
    left join public.leave_requests l on e.request_kind = 'leave' and l.id = e.request_id
    left join public.cash_advance_requests c on e.request_kind = 'cash' and c.id = e.request_id
   where e.status = 'pending'
     and ((e.request_kind = 'leave' and l.status = 'pending') or (e.request_kind = 'cash' and c.status = 'pending'));
$$;;

create or replace function public.inbox_items()
returns jsonb
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(to_jsonb(x) - 'owner' order by
           case x.state when 'escalated' then 0 when 'overdue' then 1 else 2 end, x.age_hours desc), '[]'::jsonb)
    from public.inbox_items_with_state() x
   where (x.owner is null or x.owner is distinct from auth.uid() or public.is_admin())
     and (public.is_admin()
      -- endorsement items: only the requester's own Head
      or (x.kind like '%\_endorse' escape '\' and public.is_supervisor_of(x.owner))
      or (x.kind not like '%\_endorse' escape '\' and public.has_perm(x.module, x.level)
          and not (x.kind in ('leave_decide', 'ca_approve', 'rb_approve', 'liq_review') and public.staff_is_head(x.owner)))
      or (x.state = 'escalated' and x.kind not like '%\_endorse' escape '\' and public.has_perm(x.module, 'view')
          and not (x.kind in ('leave_decide', 'ca_approve', 'rb_approve', 'liq_review') and public.staff_is_head(x.owner))
          and exists (select 1 from public.staff_departments d where d.user_id = auth.uid() and d.department_id = x.department and d.is_head)));
$$;;

create or replace function public.inbox_escalations_due()
returns table (key text, kind text, ref_id text, ref_label text, title text, label text, level smallint,
               age_hours numeric, module text, recipients uuid[])
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare r record; heads uuid[]; admins uuid[];
begin
  select coalesce(array_agg(id), '{}') into admins from public.profiles where role = 'admin' and active;
  for r in select * from public.inbox_items_with_state() x where x.state = 'escalated' loop
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
         and d.user_id is distinct from r.owner;   -- not their own request
      key := r.kind || ':' || r.ref_id || ':L1'; kind := r.kind; ref_id := r.ref_id; ref_label := r.ref_label; title := r.title;
      label := r.label; level := 1; age_hours := r.age_hours; module := r.module;
      recipients := case when r.kind in ('leave_decide', 'ca_approve', 'rb_approve', 'liq_review') and public.staff_is_head(r.owner) then admins   -- a Head's own request: only the Super Admin decides it
                         when cardinality(heads) > 0 then heads else admins end;
      return next;
    end if;
  end loop;
end;
$$;;
revoke execute on function public.inbox_escalations_due() from public, anon, authenticated;
grant execute on function public.inbox_escalations_due() to service_role;

revoke execute on function public.inbox_all_items() from public, anon, authenticated;
grant execute on function public.inbox_all_items() to service_role;
revoke execute on function public.inbox_items() from public, anon;
grant execute on function public.inbox_items() to authenticated, service_role;

commit;

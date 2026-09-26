-- =====================================================================
-- AWES App — Open ACCOUNTING & FINANCE to department staff (Phase 3c)
--
-- Pages opened: Cash Advance (fin.cash_advance), Liquidation
-- (fin.liquidation), Reimbursement (fin.reimbursement). All three live in
-- cash_advance_requests (data.kind = 'reimbursement' marks a
-- reimbursement; anything else is a cash advance, whose liquidation sits
-- inside it).
--
--   View     see the requests on that page
--   Edit     record the cash actually given / the reimbursement paid
--            (Cash Advance, Reimbursement); mark a liquidation balance
--            settled (Liquidation)
--   Approve  approve / disapprove requests (Cash Advance, Reimbursement)
--            and liquidations (Liquidation)
--
-- Approvals go through staff_approval_assert(): Approve level, within the
-- peso limit (the amount requested; for a liquidation, the amount
-- liquidated), not their own request, password re-entered. The database
-- — not the screen — now stamps who decided / paid / settled and when,
-- and works out the liquidation balance itself.
--
-- Staff can never change what a technician wrote (amounts, items,
-- receipts); only the decision, payment and settlement fields.
-- Technicians and the Super Admin behave exactly as before.
--
-- Requires 20260926_01 and 20260926_02 (staff_approval_assert). Idempotent.
-- =====================================================================

begin;

do $$ begin
  if to_regprocedure('public.staff_approval_assert(text,numeric,uuid)') is null then
    raise exception 'Run 20260926_01 and 20260926_02 first.';
  end if;
end $$;

-- Which page a request belongs to
create or replace function public.cash_module(p_data jsonb)
returns text language sql immutable as $$
  select case when coalesce(p_data->>'kind', '') = 'reimbursement' then 'fin.reimbursement' else 'fin.cash_advance' end;
$$;

-- ---------------------------------------------------------------------
-- 1. Guard: the technician path is unchanged; a new staff path
-- ---------------------------------------------------------------------
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
$$;


-- ---------------------------------------------------------------------
-- 2. Row-level security
-- ---------------------------------------------------------------------
-- Advances (and the liquidations inside them): Cash Advance or Liquidation.
-- Reimbursements: Reimbursement.
drop policy if exists cash_select_own_or_admin on public.cash_advance_requests;
create policy cash_select_own_or_admin on public.cash_advance_requests for select to authenticated
  using (technician_id = auth.uid() or public.is_admin()
         or (public.cash_module(data) = 'fin.cash_advance'
             and ((select public.has_perm('fin.cash_advance', 'view')) or (select public.has_perm('fin.liquidation', 'view'))))
         or (public.cash_module(data) = 'fin.reimbursement' and (select public.has_perm('fin.reimbursement', 'view'))));

drop policy if exists cash_update_own_or_admin on public.cash_advance_requests;
create policy cash_update_own_or_admin on public.cash_advance_requests for update to authenticated
  using (public.is_admin() or technician_id = auth.uid()
         or (public.cash_module(data) = 'fin.cash_advance'
             and ((select public.has_perm('fin.cash_advance', 'edit')) or (select public.has_perm('fin.liquidation', 'edit'))))
         or (public.cash_module(data) = 'fin.reimbursement' and (select public.has_perm('fin.reimbursement', 'edit'))))
  with check (public.is_admin() or technician_id = auth.uid()
         or (public.cash_module(data) = 'fin.cash_advance'
             and ((select public.has_perm('fin.cash_advance', 'edit')) or (select public.has_perm('fin.liquidation', 'edit'))))
         or (public.cash_module(data) = 'fin.reimbursement' and (select public.has_perm('fin.reimbursement', 'edit'))));

-- Receipt photos: finance staff may open them (upload / delete unchanged).
do $$ begin
  if to_regclass('storage.objects') is not null then
    drop policy if exists liqrcpt_select_own_or_admin on storage.objects;
    create policy liqrcpt_select_own_or_admin on storage.objects for select to authenticated
      using (bucket_id = 'liquidation-receipts' and (
               (storage.foldername(name))[1] = auth.uid()::text or public.is_admin()
               or (select public.has_perm('fin.cash_advance', 'view')) or (select public.has_perm('fin.liquidation', 'view'))
               or (select public.has_perm('fin.reimbursement', 'view'))));
  end if;
end $$;

commit;

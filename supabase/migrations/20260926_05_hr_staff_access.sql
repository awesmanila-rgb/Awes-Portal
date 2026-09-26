-- =====================================================================
-- AWES App — Open HUMAN RESOURCES to department staff (Phase 3d)
--
-- Pages opened:
--   Attendance (DTR)     hr.attendance    View: today's attendance table and
--                                          each technician's DTR history.
--                                          (DTR is written only by the
--                                          technician's own time-in/out; there
--                                          are no staff edits.)
--   Leave Requests       hr.leaves        View: all leave requests.
--                                          Approve: approve / disapprove —
--                                          password re-entered, not their own.
--   Technician Profiles  hr.tech_profiles View: profile, violations, documents.
--                                          Edit: add / remove violations and
--                                          documents (memos, contracts…).
--
-- Still Super Admin only: creating, editing, restricting or removing
-- technician accounts and resetting DTR devices (Users & Roles).
--
-- Requires 20260926_01 and 20260926_02 (staff_approval_assert). Idempotent.
-- =====================================================================

begin;

do $$ begin
  if to_regprocedure('public.staff_approval_assert(text,numeric,uuid)') is null then
    raise exception 'Run 20260926_01 and 20260926_02 first.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. Leave decision guard: technician path unchanged; new staff path
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
$$;


-- ---------------------------------------------------------------------
-- 2. Row-level security
-- ---------------------------------------------------------------------
-- DTR: read only for staff
drop policy if exists dtr_select_own_or_admin on public.dtr_records;
create policy dtr_select_own_or_admin on public.dtr_records for select to authenticated
  using (technician_id = auth.uid() or public.is_admin() or (select public.has_perm('hr.attendance', 'view')));

-- Leave requests: read with View; decide with Approve (the guard above
-- lets staff change nothing but the decision).
drop policy if exists leave_select_own_or_admin on public.leave_requests;
create policy leave_select_own_or_admin on public.leave_requests for select to authenticated
  using (technician_id = auth.uid() or public.is_admin() or (select public.has_perm('hr.leaves', 'view')));
drop policy if exists leave_update_own_or_admin on public.leave_requests;
create policy leave_update_own_or_admin on public.leave_requests for update to authenticated
  using (public.is_admin() or (technician_id = auth.uid() and status = 'pending')
         or (select public.has_perm('hr.leaves', 'approve')))
  with check (public.is_admin() or technician_id = auth.uid() or (select public.has_perm('hr.leaves', 'approve')));

-- Violations & documents: View reads, Edit adds / removes
drop policy if exists tviolations_select_own_or_admin on public.technician_violations;
create policy tviolations_select_own_or_admin on public.technician_violations for select to authenticated
  using (technician_id = auth.uid() or public.is_admin() or (select public.has_perm('hr.tech_profiles', 'view')));
drop policy if exists tviolations_write_admin on public.technician_violations;
create policy tviolations_write_admin on public.technician_violations for insert to authenticated
  with check ((select public.has_perm('hr.tech_profiles', 'edit'))
              and exists (select 1 from public.profiles p where p.id = technician_id and p.role = 'technician'));
drop policy if exists tviolations_update_admin on public.technician_violations;
create policy tviolations_update_admin on public.technician_violations for update to authenticated
  using ((select public.has_perm('hr.tech_profiles', 'edit'))) with check ((select public.has_perm('hr.tech_profiles', 'edit')));
drop policy if exists tviolations_delete_admin on public.technician_violations;
create policy tviolations_delete_admin on public.technician_violations for delete to authenticated
  using ((select public.has_perm('hr.tech_profiles', 'edit')));

drop policy if exists tdocuments_select_own_or_admin on public.technician_documents;
create policy tdocuments_select_own_or_admin on public.technician_documents for select to authenticated
  using (technician_id = auth.uid() or public.is_admin() or (select public.has_perm('hr.tech_profiles', 'view')));
drop policy if exists tdocuments_write_admin on public.technician_documents;
create policy tdocuments_write_admin on public.technician_documents for insert to authenticated
  with check ((select public.has_perm('hr.tech_profiles', 'edit'))
              and exists (select 1 from public.profiles p where p.id = technician_id and p.role = 'technician'));
drop policy if exists tdocuments_delete_admin on public.technician_documents;
create policy tdocuments_delete_admin on public.technician_documents for delete to authenticated
  using ((select public.has_perm('hr.tech_profiles', 'edit')));

-- Technician names / photos for HR screens (extends the inventory policy
-- from 20260926_03 — reading only; account changes stay Super Admin).
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

-- Table privileges: Supabase grants these by default; stated explicitly so
-- the rules above are what decide (a project created without the default
-- grants would otherwise refuse even the Super Admin).
grant select, insert, update, delete on public.technician_violations, public.technician_documents to authenticated;

commit;

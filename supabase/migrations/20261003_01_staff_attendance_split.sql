-- =====================================================================
-- AWES App — Attendance splits into two pages
--
--   Technician Attendance    (hr.attendance, was "Attendance (DTR)")
--       technicians' time records only
--   Office Staff Attendance  (hr.staff_attendance, NEW)
--       office staff's time records
--
-- So you can give, say, Operations dispatchers technician attendance
-- without letting them see office staff's DTR. The database enforces it:
-- someone with Technician Attendance only can't read office staff's time
-- records (or their names through HR's rules).
--
-- Nobody loses anything: everyone who has Attendance now also gets Office
-- Staff Attendance at the same level and end date (Heads before their
-- sub-users), and role templates with Attendance gain it too. Adjust people
-- afterwards in Department Staff.
--
-- Requires 20260926_01 … 20261002_01. Safe to re-run: the copy in step 2
-- happens only the first time (recorded in app_one_time_steps).
-- =====================================================================

begin;

do $$ begin
  if to_regprocedure('public.inventory_move_to_administration()') is null then
    raise exception 'Run the earlier migrations (20260926_01 … 20261002_01) first.';
  end if;
end $$;

-- 1. The catalog
insert into public.app_modules (key, department, section, label, sort, approvable, has_limit, is_switch) values
  ('hr.attendance',       'hr', 'HR', 'Technician Attendance',   40, false, false, false),
  ('hr.staff_attendance', 'hr', 'HR', 'Office Staff Attendance', 41, false, false, false),
  ('hr.leaves',           'hr', 'HR', 'Leave Requests',          42, true,  false, false),
  ('hr.tech_profiles',    'hr', 'HR', 'Technician Profiles',     43, false, false, false)
on conflict (key) do update set label = excluded.label, sort = excluded.sort, section = excluded.section, department = excluded.department;

-- 2–3. Everyone with Attendance keeps seeing office staff (a function so
--      the verify probe runs exactly this code)
create or replace function public.hr_split_attendance_access()
returns integer
language plpgsql security definer
set search_path = public, pg_temp
as $fn$
declare n int := 0; k int;
begin
  -- 2. Everyone with Attendance keeps seeing office staff: give them the new
  --    page at the same level / end date. Top-level people first so their
  --    sub-users' copies stay within their Head's access.
  insert into public.staff_access (user_id, module_key, level, approve_limit, expires_at, granted_by)
  select a.user_id, 'hr.staff_attendance', a.level, null, a.expires_at, a.granted_by
    from public.staff_access a join public.profiles p on p.id = a.user_id
   where a.module_key = 'hr.attendance' and p.supervisor_id is null
  on conflict (user_id, module_key) do nothing;
  insert into public.staff_access (user_id, module_key, level, approve_limit, expires_at, granted_by)
  select a.user_id, 'hr.staff_attendance', a.level, null, a.expires_at, a.granted_by
    from public.staff_access a join public.profiles p on p.id = a.user_id
   where a.module_key = 'hr.attendance' and p.supervisor_id is not null
     and exists (select 1 from public.staff_access h where h.user_id = p.supervisor_id and h.module_key = 'hr.staff_attendance')
  on conflict (user_id, module_key) do nothing;

  -- 3. Role templates
  update public.access_templates t
     set access = t.access || jsonb_build_array(jsonb_build_object('module', 'hr.staff_attendance', 'level', x.lvl)), updated_at = now()
    from (select id, (select a->>'level' from jsonb_array_elements(access) a where a->>'module' = 'hr.attendance' limit 1) as lvl
            from public.access_templates) x
   where x.id = t.id and x.lvl is not null
     and not exists (select 1 from jsonb_array_elements(t.access) a where a->>'module' = 'hr.staff_attendance');

  select count(*) into n from public.staff_access where module_key = 'hr.staff_attendance';
  return n;
end;
$fn$;
revoke execute on function public.hr_split_attendance_access() from public, anon, authenticated;
grant execute on function public.hr_split_attendance_access() to service_role;

-- Run the copy ONCE per database. Re-running this migration later must not
-- give Office Staff Attendance back to people you've since set to
-- Technician Attendance only.
create table if not exists public.app_one_time_steps (
  step     text primary key,
  done_at  timestamptz not null default now(),
  result   jsonb
);
alter table public.app_one_time_steps enable row level security;
revoke all on public.app_one_time_steps from anon, authenticated;

create or replace function public.hr_split_attendance_once()
returns boolean
language plpgsql security definer
set search_path = public, pg_temp
as $fn$
declare n int;
begin
  if exists (select 1 from public.app_one_time_steps where step = 'hr_attendance_split') then return false; end if;
  n := public.hr_split_attendance_access();
  insert into public.app_one_time_steps (step, result) values ('hr_attendance_split', jsonb_build_object('office_staff_attendance_grants', n));
  return true;
end;
$fn$;
revoke execute on function public.hr_split_attendance_once() from public, anon, authenticated;
grant execute on function public.hr_split_attendance_once() to service_role;

select public.hr_split_attendance_once();

-- 4. Who reads whose time records (same definition as 20260926_05)
-- Whose time records can the viewer read? Technicians' need Technician
-- Attendance (hr.attendance); office staff's need Office Staff Attendance
-- (hr.staff_attendance). Same definition in 20260926_05 and 20261003_01.
create or replace function public.hr_sees_dtr_of(p_person uuid)
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.profiles t where t.id = p_person and (
           (t.role = 'technician' and public.has_perm('hr.attendance', 'view'))
        or (t.role = 'staff' and public.has_perm('hr.staff_attendance', 'view'))));
$$;
revoke execute on function public.hr_sees_dtr_of(uuid) from public, anon;
grant execute on function public.hr_sees_dtr_of(uuid) to authenticated, service_role;

drop policy if exists dtr_select_own_or_admin on public.dtr_records;
create policy dtr_select_own_or_admin on public.dtr_records for select to authenticated
  using (technician_id = auth.uid() or public.is_admin() or public.hr_sees_dtr_of(technician_id));

-- 5. Office staff names for HR: Office Staff Attendance (no longer Technician
--    Attendance), Leave Requests or Technician Profiles (same as 20261001_01)
drop policy if exists profiles_select_staff_for_hr on public.profiles;
create policy profiles_select_staff_for_hr on public.profiles for select to authenticated
  using (role = 'staff' and ((select public.has_perm('hr.staff_attendance', 'view')) or (select public.has_perm('hr.leaves', 'view'))
                             or (select public.has_perm('hr.tech_profiles', 'view'))));

commit;

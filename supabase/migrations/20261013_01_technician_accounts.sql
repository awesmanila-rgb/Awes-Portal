-- =====================================================================
-- Technician accounts under Employees (Operations)
--
-- Technicians belong to Operations, so the Operations Head manages their
-- accounts; HR keeps the records (Technician Profiles, attendance, leave,
-- payroll — unchanged).
--
--   ops.technicians   Operations › Technicians
--       View  — see the technician list (names, usernames, active, restrictions)
--       Edit  — add technicians, edit details / username / restrictions,
--               reset passwords, deactivate / reactivate, clear the DTR
--               device lock
--   Account changes go through the admin-create-staff Edge Function
--   (tech_* actions), which checks this access server-side — redeploy it.
--   The Super Admin can do all of it as before. Storekeeper warehouses stay
--   Super Admin only.
-- Safe to re-run.
-- =====================================================================
begin;

insert into public.app_modules (key, department, section, label, sort, approvable, has_limit, is_switch) values
  ('ops.technicians', 'operations', 'Operations', 'Technicians', 59, false, false, false)
on conflict (key) do update set label = excluded.label, section = excluded.section, sort = excluded.sort, department = excluded.department;

drop policy if exists profiles_select_for_tech_admin on public.profiles;
create policy profiles_select_for_tech_admin on public.profiles for select to authenticated
  using (role = 'technician' and (select public.has_perm('ops.technicians', 'view')));

drop policy if exists locks_select_for_tech_admin on public.device_locks;
create policy locks_select_for_tech_admin on public.device_locks for select to authenticated
  using ((select public.has_perm('ops.technicians', 'view')));
drop policy if exists locks_delete_for_tech_admin on public.device_locks;
create policy locks_delete_for_tech_admin on public.device_locks for delete to authenticated
  using ((select public.has_perm('ops.technicians', 'edit')));

commit;

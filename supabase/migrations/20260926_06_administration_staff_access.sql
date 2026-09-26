-- =====================================================================
-- AWES App — Open ADMINISTRATION to department staff (Phase 3e)
--
-- Pages opened:
--   Customers           adm.customers      View: customer records (everyone
--                                            signed in could already read them)
--                                            and their equipment + service
--                                            history. Edit: add / change /
--                                            remove customers and their
--                                            equipment; renaming a customer
--                                            also renames it on its reports.
--   Customer Equipment  adm.equipment      View: the equipment list, photos and
--                                            each unit's service history.
--                                            Edit: change / remove equipment,
--                                            manage photos.
--   Announcements       adm.announcements  Edit: post / change / remove.
--   Dropdown Lists      adm.dropdowns      Edit: the report form's lists
--                                            (settings/fieldLists only — no
--                                            other setting).
--
-- Still Super Admin only: customer portal logins (Users & Roles), e-mail /
-- secret settings, and every other app setting.
--
-- Requires 20260926_01. Idempotent.
-- =====================================================================

begin;

do $$ begin
  if to_regprocedure('public.has_perm(text,text)') is null then
    raise exception 'Run 20260926_01_departments_access.sql first.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. Customers
-- ---------------------------------------------------------------------
drop policy if exists customers_insert_admin on public.customers;
create policy customers_insert_admin on public.customers for insert to authenticated
  with check ((select public.has_perm('adm.customers', 'edit')));
drop policy if exists customers_update_admin on public.customers;
create policy customers_update_admin on public.customers for update to authenticated
  using ((select public.has_perm('adm.customers', 'edit'))) with check ((select public.has_perm('adm.customers', 'edit')));
drop policy if exists customers_delete_admin on public.customers;
create policy customers_delete_admin on public.customers for delete to authenticated
  using ((select public.has_perm('adm.customers', 'edit')));

-- Renaming a customer carries the new name onto its service reports (the
-- Super Admin's screen did that with a direct update; staff can't update
-- reports, so it goes through this one narrow function instead).
create or replace function public.rename_customer_on_reports(p_old text, p_new text)
returns integer
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare n integer;
begin
  if not public.has_perm('adm.customers', 'edit') then
    raise exception 'You need Edit access for Customers.' using errcode = '42501';
  end if;
  if coalesce(trim(p_old), '') = '' or coalesce(trim(p_new), '') = '' then return 0; end if;
  update public.service_reports set cust_name = trim(p_new)
   where lower(trim(cust_name)) = lower(trim(p_old));
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function public.rename_customer_on_reports(text, text) from public, anon;
grant execute on function public.rename_customer_on_reports(text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 2. Customer equipment & photos (edited from both pages)
-- ---------------------------------------------------------------------
drop policy if exists cequip_update_admin on public.customer_equipment;
create policy cequip_update_admin on public.customer_equipment for update to authenticated
  using ((select public.has_perm('adm.equipment', 'edit')) or (select public.has_perm('adm.customers', 'edit')));
drop policy if exists cequip_delete_admin on public.customer_equipment;
create policy cequip_delete_admin on public.customer_equipment for delete to authenticated
  using ((select public.has_perm('adm.equipment', 'edit')) or (select public.has_perm('adm.customers', 'edit')));

drop policy if exists "read own or admin" on public.equipment_photos;
create policy "read own or admin" on public.equipment_photos for select to authenticated
  using (public.is_admin()
         or (select public.has_perm('adm.equipment', 'view')) or (select public.has_perm('adm.customers', 'view'))
         or customer_id in (select customer_login_links.customer_id from public.customer_login_links
                             where customer_login_links.profile_id = auth.uid()));
drop policy if exists "admin writes photos" on public.equipment_photos;
create policy "admin writes photos" on public.equipment_photos for all to authenticated
  using ((select public.has_perm('adm.equipment', 'edit')) or (select public.has_perm('adm.customers', 'edit')))
  with check ((select public.has_perm('adm.equipment', 'edit')) or (select public.has_perm('adm.customers', 'edit')));

-- Each unit's service history (the same visits its customer sees)
drop policy if exists reports_select_for_admin_staff on public.service_reports;
create policy reports_select_for_admin_staff on public.service_reports for select to authenticated
  using ((select public.has_perm('adm.equipment', 'view')) or (select public.has_perm('adm.customers', 'view')));

-- ---------------------------------------------------------------------
-- 3. Announcements
-- ---------------------------------------------------------------------
drop policy if exists announcements_write_admin on public.announcements;
create policy announcements_write_admin on public.announcements for all to authenticated
  using ((select public.has_perm('adm.announcements', 'edit')))
  with check ((select public.has_perm('adm.announcements', 'edit')));

-- ---------------------------------------------------------------------
-- 4. Dropdown lists — settings/fieldLists only
-- ---------------------------------------------------------------------
drop policy if exists settings_admin_write on public.app_settings;
create policy settings_admin_write on public.app_settings for insert to authenticated
  with check (public.is_admin() or (key = 'settings/fieldLists' and (select public.has_perm('adm.dropdowns', 'edit'))));
drop policy if exists settings_admin_update on public.app_settings;
create policy settings_admin_update on public.app_settings for update to authenticated
  using (public.is_admin() or (key = 'settings/fieldLists' and (select public.has_perm('adm.dropdowns', 'edit'))))
  with check (public.is_admin() or (key = 'settings/fieldLists' and (select public.has_perm('adm.dropdowns', 'edit'))));

-- Table privileges: Supabase grants these by default; stated explicitly so
-- the rules above are what decide.
grant select, insert, update, delete on public.announcements, public.equipment_photos to authenticated;
grant select on public.customer_login_links to authenticated;   -- rows still limited by its own rules

commit;

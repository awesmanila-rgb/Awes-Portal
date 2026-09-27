-- =====================================================================
-- AWES App — Close read access that was wider than each account needs
--
-- An audit reading every table as each kind of account (signed out,
-- technician, storekeeper, customer, staff with one page, finance staff,
-- Head, deactivated staff) found tables any signed-in account could read:
--
--   customers            a CUSTOMER login could read every company —
--                         names, addresses, contacts — not just its own
--   customer_equipment   … and every company's units; anyone signed in
--                         could also ADD a unit under any customer
--   announcements        internal notices for staff/technicians were
--                         readable by customers
--   materials, material_categories, warehouses, supplier directory,
--   report dropdown lists (app_settings)
--                        internal company data readable by customers
--   customers / equipment were also readable by office staff with no page
--   that uses them
--
-- After this migration:
--   customers, customer_equipment   Super Admin; active technicians (they
--       pick customers and units on reports); staff whose pages use them
--       (Customers, Customer Equipment, Dispatch, Service Requests,
--       Service Reports, Record Past Service, Projects); a customer login
--       — only the companies it's linked to.
--   adding equipment   Super Admin, active technicians, staff with Edit on
--       one of those pages. (Customers never add units.)
--   announcements, materials, categories, warehouses, supplier directory,
--   non-secret settings   the company's own people only: Super Admin,
--       active technicians, active staff. Never customers or signed-out
--       visitors. Deactivated accounts see none of it.
--
-- Nothing an account legitimately uses changes. Idempotent; re-runnable.
-- Requires 20260926_01 (has_perm, is_staff).
-- =====================================================================

begin;

do $$ begin
  if to_regprocedure('public.has_perm(text,text)') is null then
    raise exception 'Run 20260926_01_departments_access.sql first.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Who is asking
-- ---------------------------------------------------------------------
create or replace function public.app_is_technician()
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$ select exists (select 1 from public.profiles where id = auth.uid() and role = 'technician' and active); $$;

-- The company's own people: Super Admin, active technicians, active staff
create or replace function public.app_is_internal()
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$ select public.is_admin() or public.app_is_technician() or public.is_staff(); $$;

-- A customer login's own companies
create or replace function public.app_customer_is_mine(p_customer uuid)
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1 from public.customer_login_links l join public.profiles p on p.id = l.profile_id
     where l.profile_id = auth.uid() and l.customer_id = p_customer and p.active);
$$;

-- Staff whose pages show customers and their equipment
create or replace function public.staff_sees_customers(p_level text default 'view')
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$
  select public.has_perm('adm.customers', p_level) or public.has_perm('adm.equipment', p_level)
      or public.has_perm('ops.dispatch', p_level) or public.has_perm('ops.service_requests', p_level)
      or public.has_perm('ops.service_reports', p_level) or public.has_perm('ops.past_service', p_level)
      or public.has_perm('ops.projects', p_level);
$$;

revoke execute on function public.app_is_technician(), public.app_is_internal(), public.app_customer_is_mine(uuid),
  public.staff_sees_customers(text) from public, anon;
grant execute on function public.app_is_technician(), public.app_is_internal(), public.app_customer_is_mine(uuid),
  public.staff_sees_customers(text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------
drop policy if exists customers_select_authenticated on public.customers;
drop policy if exists customers_select_scoped on public.customers;
create policy customers_select_scoped on public.customers for select to authenticated
  using ((select public.is_admin()) or (select public.app_is_technician()) or (select public.staff_sees_customers())
         or public.app_customer_is_mine(id));

-- ---------------------------------------------------------------------
-- Customer equipment (the customer portal keeps "customers read own
-- equipment"; this replaces the read-all rule)
-- ---------------------------------------------------------------------
drop policy if exists cequip_select_authenticated on public.customer_equipment;
drop policy if exists cequip_select_scoped on public.customer_equipment;
create policy cequip_select_scoped on public.customer_equipment for select to authenticated
  using ((select public.is_admin()) or (select public.app_is_technician()) or (select public.staff_sees_customers()));

drop policy if exists cequip_insert_authenticated on public.customer_equipment;
drop policy if exists cequip_insert_scoped on public.customer_equipment;
create policy cequip_insert_scoped on public.customer_equipment for insert to authenticated
  with check ((select public.is_admin()) or (select public.app_is_technician()) or (select public.staff_sees_customers('edit')));

-- ---------------------------------------------------------------------
-- Internal company data: the company's own people only
-- ---------------------------------------------------------------------
drop policy if exists announcements_select on public.announcements;
create policy announcements_select on public.announcements for select to authenticated
  using ((select public.app_is_internal()));

drop policy if exists materials_read on public.materials;
create policy materials_read on public.materials for select to authenticated
  using ((is_active and (select public.app_is_internal()))
         or (select public.has_perm('pur.materials', 'view')) or (select public.has_perm('pur.purchase_orders', 'view'))
         or (select public.has_perm('pur.requisitions', 'view')));

drop policy if exists material_categories_read on public.material_categories;
create policy material_categories_read on public.material_categories for select to authenticated
  using ((select public.app_is_internal()));

drop policy if exists warehouses_read on public.warehouses;
create policy warehouses_read on public.warehouses for select to authenticated
  using ((select public.app_is_internal()));

drop policy if exists settings_select_nonsecret on public.app_settings;
create policy settings_select_nonsecret on public.app_settings for select to authenticated
  using (public.is_admin()
         or ((select public.app_is_internal())
             and key <> all (array['settings/emailjs', 'emailjs', 'settings/secrets', 'secrets'])));

-- Supplier directory view (it runs with its owner's rights, so the filter
-- has to be inside the view)
create or replace view public.suppliers_directory with (security_invoker = false) as
  select id, code, coalesce(nullif(trade_name, ''), name) as display_name, name, address, city, delivers, supplies
    from public.suppliers s
   where is_active and public.app_is_internal();

commit;

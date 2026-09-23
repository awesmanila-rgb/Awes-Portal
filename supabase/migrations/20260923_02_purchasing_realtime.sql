-- ---------------------------------------------------------------------
-- Purchasing — live updates
--
-- Adds the purchasing tables to the supabase_realtime publication so the
-- Supplier Database and Materials Database screens refresh by themselves
-- when anything changes (on this device or another admin's).
--
-- No REPLICA IDENTITY FULL: the screens re-fetch on any change instead of
-- reading field values out of the event, so the default (primary key only
-- for the old row) is enough and keeps the WAL small.
--
-- Realtime still applies each table's RLS to every subscriber, so these
-- events only ever reach admins (materials: any signed-in user, matching
-- its read policy).
--
-- Depends on 20260923_01_purchasing_suppliers_materials.sql. Safe to re-run.
-- ---------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['suppliers', 'supplier_contacts', 'supplier_documents',
                           'materials', 'supplier_materials'] loop
    if to_regclass('public.' || t) is null then
      raise exception 'public.% is missing — run 20260923_01_purchasing_suppliers_materials.sql first.', t;
    end if;
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
      raise notice 'Realtime enabled for public.%', t;
    end if;
  end loop;
end $$;

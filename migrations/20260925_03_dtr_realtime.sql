-- ---------------------------------------------------------------------
-- DTR: realtime for the admin Technician Attendance table
--
-- The attendance table (and the admin Priority panel) subscribe to
-- changes on public.dtr_records, but the table was never added to the
-- supabase_realtime publication — so no events were ever sent and the
-- page only changed on reload. This publishes it.
--
-- Realtime still respects RLS: admins receive every technician's rows,
-- a technician only their own. Safe to re-run.
-- ---------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'dtr_records') then
    alter publication supabase_realtime add table public.dtr_records;
  end if;
end $$;

-- Lets UPDATE/DELETE events carry technician_id (used to refresh only the
-- DTR history that's open), not just the primary key.
alter table public.dtr_records replica identity full;

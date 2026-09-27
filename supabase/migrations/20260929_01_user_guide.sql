-- =====================================================================
-- AWES App — In-app guide: per-user progress (tours, tips, checklist,
-- language)
--
-- One row per signed-in person (Super Admin, staff, technician or
-- customer): which page tips they closed, which tours and checklist items
-- they finished, and English / Tagalog. Kept in the database so it
-- follows them from phone to phone; the app falls back to this device
-- only if this migration isn't installed.
--
-- Each person reads and writes only their own row. Independent of the
-- department-staff migrations. Idempotent.
-- =====================================================================

begin;

create table if not exists public.user_guide_progress (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

alter table public.user_guide_progress enable row level security;

drop policy if exists user_guide_progress_own on public.user_guide_progress;
create policy user_guide_progress_own on public.user_guide_progress for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke all on public.user_guide_progress from anon;
grant select, insert, update, delete on public.user_guide_progress to authenticated;

commit;

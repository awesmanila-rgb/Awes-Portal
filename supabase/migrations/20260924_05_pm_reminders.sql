-- =====================================================================
-- PM reminders for customers (customer portal redesign, feature 2)
--
-- The pm-reminders Edge Function runs once a day (see
-- supabase/setup/pm_reminders_cron.sql). It finds units whose
-- customer_equipment.next_pm_date falls within the next 7 days and sends
-- the customer's devices one push per account: "N units are due for
-- maintenance on <date>". This table remembers what was already sent so a
-- unit is reminded once per PM date — changing the date re-arms it.
--
-- Service role only: RLS is on with no policies, so the browser client
-- can neither read nor write it.
-- Safe to re-run.
-- =====================================================================
create table if not exists public.pm_reminder_log (
  equipment_id  text        not null,
  pm_date       date        not null,
  customer_id   text,
  sent_at       timestamptz not null default now(),
  primary key (equipment_id, pm_date)
);
create index if not exists pm_reminder_log_sent_idx on public.pm_reminder_log (sent_at);
alter table public.pm_reminder_log enable row level security;

-- ---------------------------------------------------------------------
-- Fix: push_subscriptions.customer_id was created as bigint
-- (20260916_03_push_subscriptions.sql), but customers.id is a uuid. A
-- customer turning on notifications sends their uuid, which a bigint
-- column rejects — so customer devices could never be registered and no
-- customer push (including these reminders) could be delivered.
-- Only runs while the column is still bigint; a value there can only be
-- a stray number (never a real customer id), so it is cleared.
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'push_subscriptions'
                and column_name = 'customer_id' and data_type = 'bigint') then
    alter table public.push_subscriptions alter column customer_id type uuid using null;
  end if;
end $$;

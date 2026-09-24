-- ---------------------------------------------------------------------
-- Admin alerts (urgent push + 7:00 AM digest): de-duplication log
--
-- The admin-alerts Edge Function runs every 5 minutes. Each alert it sends
-- is written here under a unique key (late:<JO>:<date>:<dispatch time>,
-- sr:<request id>, digest:<date>) so it is sent exactly once, even if two
-- runs overlap (the primary key makes the second insert fail). The
-- function prunes rows older than 14 days.
--
-- Service role only: RLS on, no policies, no grants to app users.
-- Safe to re-run. The cron schedule itself is in
-- supabase/setup/admin_alerts_cron.sql (it needs your project URL + secret).
-- ---------------------------------------------------------------------
create table if not exists public.admin_alert_log (
  key     text primary key,
  sent_at timestamptz not null default now()
);
alter table public.admin_alert_log enable row level security;
revoke all on public.admin_alert_log from anon, authenticated;
create index if not exists admin_alert_log_sent_idx on public.admin_alert_log (sent_at);

-- The function filters tickets by their scheduled date inside the jsonb.
create index if not exists dispatch_tickets_data_date_idx on public.dispatch_tickets ((data->>'date'));

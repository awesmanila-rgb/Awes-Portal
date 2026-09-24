-- ---------------------------------------------------------------------
-- Schedule the pm-reminders Edge Function once a day at 8:00 AM (Manila).
--
-- Before running:
--   1. Run migration 20260924_05_pm_reminders.sql.
--   2. pg_cron and pg_net are already enabled if you set up admin alerts;
--      otherwise enable both under Dashboard → Database → Extensions.
--   3. Deploy the function:
--        supabase functions deploy pm-reminders --no-verify-jwt
--   4. Set a secret (any long random string):
--        supabase secrets set PM_REMINDERS_SECRET=<your-long-random-string>
--   5. Replace <PROJECT_REF> and <PM_REMINDERS_SECRET> below, then run this
--      in the SQL Editor.
--
-- 8:00 AM Manila = 00:00 UTC. Re-running replaces the job.
-- To stop:  select cron.unschedule('awes-pm-reminders');
-- ---------------------------------------------------------------------
select cron.unschedule('awes-pm-reminders')
 where exists (select 1 from cron.job where jobname = 'awes-pm-reminders');

select cron.schedule(
  'awes-pm-reminders',
  '0 0 * * *',
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/pm-reminders',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '<PM_REMINDERS_SECRET>'),
    body    := '{}'::jsonb
  );
  $$
);

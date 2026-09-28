-- ---------------------------------------------------------------------
-- Schedule the admin-alerts Edge Function every 5 minutes.
--
-- Before running:
--   1. Dashboard → Database → Extensions: enable  pg_cron  and  pg_net.
--   2. Deploy the function:
--        supabase functions deploy admin-alerts --no-verify-jwt
--   3. Set a secret (any long random string, e.g. from a password manager):
--        supabase secrets set ADMIN_ALERTS_SECRET=<your-long-random-string>
--   4. Replace the two placeholders below, then run this in the SQL Editor:
--        <PROJECT_REF>  — the id in your Supabase URL (https://<PROJECT_REF>.supabase.co)
--        <ADMIN_ALERTS_SECRET>  — the same string as step 3
--
-- Re-running replaces the job. To stop alerts:  select cron.unschedule('awes-admin-alerts');
-- ---------------------------------------------------------------------
select cron.unschedule('awes-admin-alerts')
 where exists (select 1 from cron.job where jobname = 'awes-admin-alerts');

select cron.schedule(
  'awes-admin-alerts',
  '*/5 * * * *',
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/admin-alerts',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '<ADMIN_ALERTS_SECRET>'),
    body    := '{}'::jsonb
  );
  $$
);

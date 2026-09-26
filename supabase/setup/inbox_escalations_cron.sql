-- ---------------------------------------------------------------------
-- Schedule the inbox-escalations Edge Function every 15 minutes.
--
-- Before running:
--   1. Dashboard → Database → Extensions: pg_cron and pg_net enabled
--      (already on if you set up admin alerts / PM reminders).
--   2. Deploy the function:
--        supabase functions deploy inbox-escalations --no-verify-jwt
--   3. Set a secret (any long random string):
--        supabase secrets set INBOX_ESCALATIONS_SECRET=<your-long-random-string>
--   4. Replace the two placeholders below, then run this in the SQL Editor:
--        <PROJECT_REF>               — the id in your Supabase URL
--        <INBOX_ESCALATIONS_SECRET>  — the same string as step 3
--
-- Re-running replaces the job. To stop:  select cron.unschedule('awes-inbox-escalations');
-- ---------------------------------------------------------------------
select cron.unschedule('awes-inbox-escalations')
 where exists (select 1 from cron.job where jobname = 'awes-inbox-escalations');

select cron.schedule(
  'awes-inbox-escalations',
  '*/15 * * * *',
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/inbox-escalations',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '<INBOX_ESCALATIONS_SECRET>'),
    body    := '{}'::jsonb
  );
  $$
);

-- ---------------------------------------------------------------------
-- Create recurring errands automatically (hourly).
--
-- Before running: Dashboard → Database → Extensions → enable pg_cron.
-- Run this once in the SQL Editor. To stop:  select cron.unschedule('awes-errand-recurrence');
--
-- Without this, recurring errands are still created whenever someone with
-- Errands › Edit opens the Errands page — the schedule just makes it
-- happen on time, even if nobody opens the app.
-- ---------------------------------------------------------------------
select cron.unschedule('awes-errand-recurrence')
 where exists (select 1 from cron.job where jobname = 'awes-errand-recurrence');

select cron.schedule('awes-errand-recurrence', '5 * * * *', $$select public.errand_recur_run();$$);

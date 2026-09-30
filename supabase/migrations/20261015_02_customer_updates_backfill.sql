-- =====================================================================
-- Customer Updates — backfill for requests already in progress
--
-- 20261015_01 writes an update each time a request changes AFTER it was
-- run, so a request acknowledged before that had nothing to show. This
-- adds one update per open request that has none yet, describing where
-- it stands now (marked unread only if it's from the last 3 days).
-- Safe to re-run — requests that already have an update are skipped.
-- =====================================================================
begin;
insert into public.customer_updates (customer_id, request_id, kind, title, body, created_at, read_at)
select r.customer_id, r.id, r.status,
       case r.status
         when 'acknowledged' then 'We received your request'
         when 'fee_proposed' then 'Service fee ready for your review'
         when 'fee_accepted' then 'Fee accepted'
         when 'schedule_proposed' then 'Proposed schedule for your service'
         when 'schedule_confirmed' then 'Schedule confirmed'
         when 'preparing' then 'A technician has been scheduled'
         when 'dispatched' then 'A technician has been scheduled'
         when 'en_route' then 'Your technician is on the way'
         when 'in_progress' then 'Your technician has arrived'
         when 'completed' then 'Your service is complete'
       end,
       case r.status
         when 'acknowledged' then 'The office has acknowledged it and will send the fee or schedule shortly.'
         when 'fee_proposed' then 'A fee of ₱' || to_char(coalesce(r.fee_amount, 0), 'FM999,999,990.00') || ' was proposed. Open the request to accept or decline.'
         when 'fee_accepted' then 'The office will propose a schedule next.'
         when 'schedule_proposed' then 'Open the request to confirm the schedule.'
         else ''
       end,
       coalesce(r.updated_at, r.created_at),
       case when coalesce(r.updated_at, r.created_at) < now() - interval '3 days' then now() end
  from public.service_requests r
 where r.customer_id is not null
   and r.status in ('acknowledged','fee_proposed','fee_accepted','schedule_proposed','schedule_confirmed','preparing','dispatched','en_route','in_progress','completed')
   and not exists (select 1 from public.customer_updates u where u.request_id = r.id);
commit;

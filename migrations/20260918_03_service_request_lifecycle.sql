-- ---------------------------------------------------------------------
-- Job Order lifecycle, 3 of 3 — the customer-facing stages
--
-- The customer's status card now mirrors the technician's tracker word for
-- word: Preparing, En Route, Work in Progress, Completed, Closed. A
-- customer on the phone to the crew hears the same status they can see.
--
-- What moved, and why:
--   'dispatched' becomes 'preparing' — same moment in the flow (a job
--     order exists for this request), clearer word, and it matches the
--     stage the job order itself computes.
--   en_route now fires when EVERY assigned technician has acknowledged,
--     not from a separate "On my way" tap. That button is gone: it let a
--     technician tell the customer they were coming before accepting the
--     job, so the two signals could contradict each other.
--   in_progress now fires on the Arrived at Site tap rather than on
--     acknowledgement, which used to jump the customer straight to "work
--     has started" while the crew was still driving.
--   closed is new: admin's review-and-close step, after Completed.
--
-- This is the only file that touches existing rows. Nothing is deleted.
-- ---------------------------------------------------------------------


-- =====================================================================
-- Status vocabulary
--
-- ORDER MATTERS HERE, and the obvious order is wrong.
--
-- Migrating the rows first looks safer — get the data into the new
-- vocabulary, then widen the constraint to match. It isn't: the OLD
-- constraint is still enforced during that update, and it has no
-- 'preparing' in its allowed list, so it rejects the very rows being
-- migrated:
--
--   ERROR 23514: new row for relation "service_requests" violates check
--   constraint "service_requests_status_check"
--
-- So the constraint comes off first, the rows move while nothing is
-- enforcing a vocabulary, and the widened constraint goes back on. The
-- window between the drop and the add is inside this transaction, so no
-- other session ever sees the table unconstrained.
-- =====================================================================
alter table public.service_requests drop constraint if exists service_requests_status_check;

update public.service_requests set status = 'preparing' where status = 'dispatched';

alter table public.service_requests add constraint service_requests_status_check
  check (status in (
    'new','acknowledged','fee_proposed','fee_accepted',
    'schedule_proposed','schedule_confirmed',
    'preparing','en_route','in_progress','completed','closed','cancelled'
  ));


-- =====================================================================
-- The sync RPC
--
-- Normalise-don't-raise: an unexpected status returns false rather than
-- throwing, so a stale client can't break a technician's save. The
-- starting-status guards are what enforce ordering — each stage only
-- accepts the stage(s) that legitimately precede it, so a duplicate or
-- out-of-order call is a no-op instead of dragging a request backwards.
-- =====================================================================
create or replace function public.sync_service_request_ticket_status(p_ticket_id text, p_new_status text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_role text;
begin
  select role into v_role from public.profiles where id = auth.uid();
  if v_role is null or v_role not in ('admin','technician') then
    return false;
  end if;
  if p_new_status not in ('preparing','en_route','in_progress','completed','closed') then
    return false;
  end if;

  if p_new_status = 'preparing' then
    update public.service_requests set status = 'preparing'
      where linked_dispatch_ticket_id = p_ticket_id
        and status in ('schedule_confirmed','dispatched');

  elsif p_new_status = 'en_route' then
    -- Fired when the last assigned technician acknowledges. 'dispatched'
    -- is still accepted so any row written by a client that hasn't picked
    -- up the new bundle yet still moves forward normally.
    update public.service_requests set status = 'en_route'
      where linked_dispatch_ticket_id = p_ticket_id
        and status in ('preparing','dispatched');

  elsif p_new_status = 'in_progress' then
    -- Fired by the Arrived at Site tap. Accepts 'preparing' as well as
    -- 'en_route': admin can record an arrival directly, and a crew that
    -- acknowledged and arrived within the same minute may land both calls
    -- out of order.
    update public.service_requests set status = 'in_progress'
      where linked_dispatch_ticket_id = p_ticket_id
        and status in ('preparing','dispatched','en_route');

  elsif p_new_status = 'completed' then
    -- Fired automatically once every unit on the job order has either a
    -- Service Report or a Not Yet Done reason — never from a button.
    update public.service_requests set status = 'completed'
      where linked_dispatch_ticket_id = p_ticket_id
        and status not in ('completed','closed','cancelled');

  else
    -- 'closed' — admin's review step. Only ever entered from completed, so
    -- a request cannot be closed out while work is still open against it.
    update public.service_requests set status = 'closed'
      where linked_dispatch_ticket_id = p_ticket_id
        and status = 'completed';
  end if;

  return true;
end;
$$;

comment on function public.sync_service_request_ticket_status is
  'Moves a service_request forward to match its linked dispatch ticket: preparing (job order scheduled), en_route (all assigned technicians acknowledged), in_progress (Arrived at Site), completed (every equipment unit reported or flagged not done), closed (admin review). No-op if nothing is linked or the request is not in a status that legitimately precedes the new one.';

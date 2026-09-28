-- Adds an explicit "en route" moment between a ticket being dispatched and
-- a technician actually starting work on-site, so the customer's home
-- screen progress tracker (Received / En route / In progress) can show a
-- real middle state instead of jumping straight from "assigned" to
-- "working" with no signal that the technician has actually left.
--
-- en_route is entered via a new, separate "On my way" action a technician
-- can tap (see srMarkEnRouteByTicket in service-requests.js /
-- dtMarkEnRoute in dispatch.js) BEFORE they tap the existing Acknowledge
-- button. It deliberately does not touch dispatch_tickets at all — only
-- the linked service_request's own status — so the ticket's own
-- acknowledged/completed lifecycle (and every existing query against it)
-- is completely unaffected by this addition.

alter table public.service_requests drop constraint if exists service_requests_status_check;
alter table public.service_requests add constraint service_requests_status_check
  check (status in (
    'new','acknowledged','fee_proposed','fee_accepted',
    'schedule_proposed','schedule_confirmed',
    'dispatched','en_route','in_progress','completed','cancelled'
  ));

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
  if p_new_status not in ('en_route','in_progress','completed') then
    return false;
  end if;

  if p_new_status = 'en_route' then
    update public.service_requests set status = 'en_route'
      where linked_dispatch_ticket_id = p_ticket_id and status = 'dispatched';
  elsif p_new_status = 'in_progress' then
    -- Accepts either 'dispatched' or 'en_route' as the starting point —
    -- a technician who acknowledges without ever tapping "On my way"
    -- (or taps them in quick succession) still moves the request forward
    -- normally; "On my way" is an optional extra signal, not a required
    -- gate.
    update public.service_requests set status = 'in_progress'
      where linked_dispatch_ticket_id = p_ticket_id and status in ('dispatched','en_route');
  else
    update public.service_requests set status = 'completed'
      where linked_dispatch_ticket_id = p_ticket_id;
  end if;

  return true;
end;
$$;
comment on function public.sync_service_request_ticket_status is
  'Called by dispatch.js when a technician (or admin) marks a ticket as en route, acknowledges it, or completes it, to move any service_request linked to that ticket (via linked_dispatch_ticket_id) forward to match. No-op if nothing is linked or the request is not in the expected starting status.';

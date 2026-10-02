-- =====================================================================
-- AWES App — customer request card now closes when the job order closes
--
-- Problem: an admin closed the job order, but the customer's request card
-- stayed on its old step. Two causes in sync_service_request_ticket_status():
--
--   1. Role gate. It only accepted profiles.role 'admin' or 'technician'.
--      Office staff with Dispatch › Approve (role 'staff', see
--      20260926_07) can close job orders, but their sync call returned
--      false and wrote nothing — silently.
--   2. 'closed' only moved a request that was already 'completed'. That
--      earlier 'completed' write is a separate fire-and-forget call made
--      when the technician finishes; if it was lost (offline, error,
--      units flagged not-done and cleared later) the close matched zero
--      rows and still returned true.
--
-- Fix: staff with Dispatch edit may sync, 'closed' needs admin or
-- Dispatch › Approve, and 'closed' now also accepts a request that never
-- reached 'completed' (the app only asks for it when no unit is left not
-- done). Technicians can no longer move a request to 'closed'.
--
-- Part 2 repairs requests already stuck: ticket closed with every unit
-- reported, request still open. Limited to the last 30 days so customers
-- aren't sent "Your request is closed" for old jobs (the customer_updates
-- trigger fires on every status change). Widen the interval if you want.
--
-- Idempotent. Requires 20260926_01 (has_perm) and 20260918_03.
-- =====================================================================
begin;

do $$ begin
  if to_regprocedure('public.has_perm(text,text)') is null then
    raise exception 'Run 20260926_01_departments_access.sql first.';
  end if;
end $$;

create or replace function public.sync_service_request_ticket_status(p_ticket_id text, p_new_status text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_role text;
begin
  select role into v_role from public.profiles where id = auth.uid();
  if v_role is null then
    return false;
  end if;
  if not (v_role in ('admin','technician') or public.has_perm('ops.dispatch','edit')) then
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
    update public.service_requests set status = 'en_route'
      where linked_dispatch_ticket_id = p_ticket_id
        and status in ('preparing','dispatched');

  elsif p_new_status = 'in_progress' then
    update public.service_requests set status = 'in_progress'
      where linked_dispatch_ticket_id = p_ticket_id
        and status in ('preparing','dispatched','en_route');

  elsif p_new_status = 'completed' then
    update public.service_requests set status = 'completed'
      where linked_dispatch_ticket_id = p_ticket_id
        and status not in ('completed','closed','cancelled');

  else
    -- 'closed' — the review step. Admin or Dispatch › Approve only.
    if not (public.is_admin() or public.has_perm('ops.dispatch','approve')) then
      return false;
    end if;
    update public.service_requests set status = 'closed'
      where linked_dispatch_ticket_id = p_ticket_id
        and status not in ('closed','cancelled');
  end if;

  return true;
end;
$$;

-- Part 2: repair requests stuck behind a cleanly closed job order.
update public.service_requests sr
   set status = 'closed'
  from public.dispatch_tickets dt
 where sr.linked_dispatch_ticket_id = dt.id
   and dt.status = 'closed'
   and sr.status in ('preparing','en_route','in_progress','completed')
   and not jsonb_path_exists(dt.data, '$.equipmentList[*] ? (@.notDone == true)')
   and coalesce(nullif(dt.data->>'closedAt','')::timestamptz, now()) > now() - interval '30 days';

commit;

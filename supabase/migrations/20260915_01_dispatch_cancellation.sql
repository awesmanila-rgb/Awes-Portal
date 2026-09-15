-- ---------------------------------------------------------------------
-- "Cancel an ongoing dispatch" — customer can REQUEST cancellation once a
-- service request is dispatched/en_route/in_progress (pending admin
-- accept/reject); admin can also cancel one directly, either in response
-- to that request or on their own initiative. See dispatch.js's
-- dtCancelTicket / dtCancelSection and service-requests.js's
-- srRequestCancelActive / srAdminCancelActive / srAdminAcceptCancelRequest
-- / srAdminRejectCancelRequest / srCancelByTicket.
--
-- This does NOT touch customer_cancel_service_request (20260911_02) at
-- all — that one is for cancelling BEFORE dispatch, takes effect
-- immediately, and stays exactly as-is. This is a separate, later stage:
-- once dispatched, a customer can only ask; only admin can actually
-- cancel it (and admin's cancel also has to cancel the linked dispatch
-- ticket, not just the request — see dtCancelTicket in dispatch.js).
-- ---------------------------------------------------------------------

alter table public.service_requests
  add column if not exists cancel_requested boolean not null default false,
  add column if not exists cancel_requested_reason text,
  add column if not exists cancel_requested_at timestamptz;

create or replace function public.customer_request_cancel_dispatched_service(
  p_request_id uuid, p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_owned boolean;
begin
  if p_reason is null or trim(p_reason) = '' then
    return false;
  end if;

  select exists(
    select 1 from public.service_requests sr
    where sr.id = p_request_id
      and sr.customer_id in (select customer_id from public.customer_login_links where profile_id = auth.uid())
      and sr.status = any(array['dispatched','en_route','in_progress'])
      and sr.cancel_requested = false
  ) into v_owned;

  if not v_owned then
    return false;
  end if;

  update public.service_requests
    set cancel_requested = true, cancel_requested_reason = trim(p_reason), cancel_requested_at = now()
    where id = p_request_id;

  return true;
end;
$$;
grant execute on function public.customer_request_cancel_dispatched_service(uuid, text) to authenticated;

create or replace function public.customer_withdraw_cancel_request(p_request_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_owned boolean;
begin
  select exists(
    select 1 from public.service_requests sr
    where sr.id = p_request_id
      and sr.customer_id in (select customer_id from public.customer_login_links where profile_id = auth.uid())
      and sr.cancel_requested = true
  ) into v_owned;

  if not v_owned then
    return false;
  end if;

  update public.service_requests
    set cancel_requested = false, cancel_requested_reason = null, cancel_requested_at = null
    where id = p_request_id;

  return true;
end;
$$;
grant execute on function public.customer_withdraw_cancel_request(uuid) to authenticated;

comment on function public.customer_request_cancel_dispatched_service is
  'Lets a logged-in customer flag a pending cancellation REQUEST on a request they own, only while status is dispatched/en_route/in_progress and none is already pending. Does not change status by itself — admin accepts (srAdminAcceptCancelRequest) or rejects (srAdminRejectCancelRequest) it via the ordinary admin UPDATE policy, both in service-requests.js.';
comment on function public.customer_withdraw_cancel_request is
  'Lets a logged-in customer withdraw their own pending cancellation request before admin has acted on it.';

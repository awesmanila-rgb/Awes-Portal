-- =====================================================================
-- Customer Portal: an Updates feed (bell) for every step of a request
--
-- customer_updates holds one row per thing that happened to a customer's
-- request or report, written by the DATABASE (triggers), so nothing can be
-- missed whichever screen made the change:
--   service_requests  acknowledged · fee proposed · schedule proposed ·
--                     schedule confirmed · technician scheduled (preparing) ·
--                     on the way · arrived · completed · closed ·
--                     cancelled by the office (with the reason)
--   service_request_messages   a new message from the office
--   service_reports   a report is signed off (now visible in the portal)
-- The portal's bell shows the unread count; opening the list marks them
-- read (customer_updates_mark_read). The latest update on a request also
-- shows as a banner on its card for 24 hours.
-- Customers read only their own (customer_login_links). Safe to re-run.
-- =====================================================================
begin;

create table if not exists public.customer_updates (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  request_id  uuid references public.service_requests(id) on delete cascade,
  report_id   uuid,
  kind        text not null,
  title       text not null,
  body        text not null default '',
  created_at  timestamptz not null default now(),
  read_at     timestamptz
);
create index if not exists customer_updates_idx on public.customer_updates (customer_id, created_at desc);
create index if not exists customer_updates_req_idx on public.customer_updates (request_id, created_at desc);

create or replace function public.customer_update_add(p_customer uuid, p_request uuid, p_report uuid, p_kind text, p_title text, p_body text)
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into public.customer_updates (customer_id, request_id, report_id, kind, title, body)
  select p_customer, p_request, p_report, p_kind, p_title, coalesce(p_body, '')
   where p_customer is not null;
$$;

-- service request status changes
create or replace function public.sr_customer_updates() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare t text; b text; k text; when_txt text;
begin
  if new.fee_status = 'proposed' and old.fee_status is distinct from 'proposed' then
    perform public.customer_update_add(new.customer_id, new.id, null, 'fee_proposed', 'Service fee ready for your review',
      'A fee of ₱' || to_char(coalesce(new.fee_amount, 0), 'FM999,999,990.00') || ' was proposed. Open the request to accept or decline.');
  end if;
  if new.status is not distinct from old.status then return null; end if;
  when_txt := trim(coalesce(to_char(new.proposed_schedule_date, 'Mon DD, YYYY'), '') || ' ' || coalesce(new.proposed_schedule_time::text, ''));
  k := new.status;
  case new.status
    when 'acknowledged' then t := 'We received your request'; b := 'The office has acknowledged it and will send the fee or schedule shortly.';
    when 'schedule_proposed' then t := 'Proposed schedule for your service'; b := coalesce(nullif(when_txt, ''), 'A schedule') || ' — open the request to confirm.';
    when 'schedule_confirmed' then t := 'Schedule confirmed'; b := coalesce(nullif(when_txt, ''), 'Your schedule') || ' is confirmed.';
    when 'preparing' then t := 'A technician has been scheduled'; b := 'Your job is being prepared.';
    when 'dispatched' then t := 'A technician has been scheduled'; b := 'Your job is being prepared.';
    when 'en_route' then t := 'Your technician is on the way'; b := 'The crew has set out for your site.';
    when 'in_progress' then t := 'Your technician has arrived'; b := 'Work is under way.';
    when 'completed' then t := 'Your service is complete'; b := 'The service report will appear here once it''s signed off.';
    when 'closed' then t := 'Your request is closed'; b := 'Thank you — the service report is in your Service Reports.';
    when 'cancelled' then
      if coalesce(new.cancel_requested, false) and old.status is distinct from 'cancelled' and new.cancel_acknowledged then
        t := 'Your cancellation was accepted'; b := coalesce(nullif(new.cancel_reason, ''), '');
      else
        t := 'Your request was cancelled'; b := coalesce(nullif(new.cancel_reason, ''), 'Contact the office for details.');
      end if;
    else t := null;
  end case;
  if t is not null then perform public.customer_update_add(new.customer_id, new.id, null, k, t, b); end if;
  return null;
end $$;
drop trigger if exists trg_sr_customer_updates on public.service_requests;
create trigger trg_sr_customer_updates after update on public.service_requests
  for each row execute function public.sr_customer_updates();

-- a message from the office
create or replace function public.srm_customer_updates() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.sender_role = 'admin' then
    perform public.customer_update_add((select customer_id from public.service_requests where id = new.request_id), new.request_id, null,
      'message', 'New message about your service', left(new.body, 140));
  end if;
  return null;
end $$;
drop trigger if exists trg_srm_customer_updates on public.service_request_messages;
create trigger trg_srm_customer_updates after insert on public.service_request_messages
  for each row execute function public.srm_customer_updates();

-- a report signed off (reviewed_at set) — now visible in the portal
create or replace function public.report_customer_updates() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.reviewed_at is not null and old.reviewed_at is null and new.customer_id is not null
     and coalesce(new.reviewed_by, '') <> 'Before sign-off' then
    perform public.customer_update_add(new.customer_id, null, new.id, 'report', 'Your service report is ready',
      coalesce(new.sr_no, 'Service report') || coalesce(' — ' || nullif(new.equip_location, ''), '') || '. Open Service Reports to view or download it.');
  end if;
  return null;
end $$;
do $$ begin
  if exists (select 1 from information_schema.columns where table_name = 'service_reports' and column_name = 'reviewed_at') then
    execute 'drop trigger if exists trg_report_customer_updates on public.service_reports';
    execute 'create trigger trg_report_customer_updates after update on public.service_reports for each row execute function public.report_customer_updates()';
  end if;
end $$;

create or replace function public.customer_updates_mark_read(p_ids uuid[] default null)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  update public.customer_updates u set read_at = now()
   where u.read_at is null and (p_ids is null or u.id = any(p_ids))
     and u.customer_id in (select l.customer_id from public.customer_login_links l where l.profile_id = auth.uid());
  get diagnostics n = row_count;
  return n;
end $$;

alter table public.customer_updates enable row level security;
drop policy if exists customer_updates_read on public.customer_updates;
create policy customer_updates_read on public.customer_updates for select to authenticated
  using (customer_id in (select l.customer_id from public.customer_login_links l where l.profile_id = auth.uid())
         or public.is_admin());
revoke all on public.customer_updates from anon, public;
grant select on public.customer_updates to authenticated;
revoke execute on function public.customer_updates_mark_read(uuid[]) from public, anon;
grant execute on function public.customer_updates_mark_read(uuid[]) to authenticated;
revoke execute on function public.customer_update_add(uuid, uuid, uuid, text, text, text), public.sr_customer_updates(),
  public.srm_customer_updates(), public.report_customer_updates() from public, anon, authenticated;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'customer_updates') then
    execute 'alter publication supabase_realtime add table public.customer_updates';
  end if;
end $$;

commit;

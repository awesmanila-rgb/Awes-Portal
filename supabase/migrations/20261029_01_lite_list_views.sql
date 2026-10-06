-- =====================================================================
-- AWES App — faster dashboards: "lite" read-only views
--
-- Why: every service report stores its two signatures inline as base64 pictures, and every cash
-- advance / reimbursement stores its receipt photos inline in `data`. The dashboards and home
-- screens read EVERY row to count and list things, so they downloaded all those pictures (many
-- megabytes, growing every week) and then threw them away on the phone.
--
-- What: two views that return the SAME rows without those pictures. Nothing is moved or deleted;
-- the pictures stay in the real tables and are still fetched one record at a time when someone opens
-- a report or an attachment. security_invoker = true: the views apply the real tables' row-level
-- security for whoever is signed in, so nobody sees a row they could not see before.
--
--   service_reports_lite         every column of service_reports EXCEPT customer_signature, technician_signature
--   cash_advance_requests_lite   every column of cash_advance_requests, with the receipt pictures
--                                (items[].attachmentData, liquidation.items[].attachmentData) replaced by
--                                attachmentData = null, attachmentTruncated = true — exactly what the app
--                                already did after downloading.
-- Re-run this migration after a column is added to either table so the view picks it up. Safe to re-run.
-- Requires PostgreSQL 15+ (Supabase has it).
-- =====================================================================
create or replace function public._strip_attachment_items(items jsonb)
returns jsonb language sql immutable
as $$
  select case when jsonb_typeof(items) = 'array'
    then coalesce((select jsonb_agg(case when coalesce(i->>'attachmentData', '') <> ''
                                         then (i - 'attachmentData') || jsonb_build_object('attachmentData', null, 'attachmentTruncated', true)
                                         else i end)
                     from jsonb_array_elements(items) i), '[]'::jsonb)
    else items end;
$$;

create or replace function public._strip_ca_attachments(d jsonb)
returns jsonb language sql immutable
as $$
  select case
    when d is null then d
    else (case when jsonb_typeof(d->'items') = 'array'
               then jsonb_set(
                      case when jsonb_typeof(d#>'{liquidation,items}') = 'array'
                           then jsonb_set(d, '{liquidation,items}', public._strip_attachment_items(d#>'{liquidation,items}'))
                           else d end,
                      '{items}', public._strip_attachment_items(d->'items'))
               else (case when jsonb_typeof(d#>'{liquidation,items}') = 'array'
                          then jsonb_set(d, '{liquidation,items}', public._strip_attachment_items(d#>'{liquidation,items}'))
                          else d end)
          end)
  end;
$$;

do $$
declare cols text;
begin
  -- service reports: every column except the two signatures
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'service_reports' and column_name not in ('customer_signature', 'technician_signature');
  if cols is not null then
    execute 'drop view if exists public.service_reports_lite';
    execute 'create view public.service_reports_lite with (security_invoker = true) as select ' || cols || ' from public.service_reports';
    execute 'grant select on public.service_reports_lite to authenticated';
  end if;

  -- cash advances / reimbursements: `data` without the receipt pictures
  select string_agg(case when column_name = 'data' then 'public._strip_ca_attachments(data) as data' else quote_ident(column_name) end, ', ' order by ordinal_position) into cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'cash_advance_requests';
  if cols is not null then
    execute 'drop view if exists public.cash_advance_requests_lite';
    execute 'create view public.cash_advance_requests_lite with (security_invoker = true) as select ' || cols || ' from public.cash_advance_requests';
    execute 'grant select on public.cash_advance_requests_lite to authenticated';
  end if;
end $$;

-- =====================================================================
-- Customer portal status card: name the technician who will CREATE THE
-- SERVICE REPORT, not simply the first person on the crew.
--
-- Replaces customer_ticket_tech_names() from 20261007_01. Same access
-- rules, same return type (text[]), still names only — nothing else on
-- the ticket (remarks, requirements, ids) is exposed. The one change is
-- which names come back:
--   * data->'reportAllowedWorkerNames' (the "Can Create Service Report"
--     technicians) when the ticket has any,
--   * otherwise data->'assignedWorkerNames' (older tickets / none chosen).
-- The card shows the first name plus "+N" for the rest.
-- Safe to re-run.
-- =====================================================================
create or replace function public.customer_ticket_tech_names(p_ticket_id text)
returns text[]
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(array(select jsonb_array_elements_text(
           case when jsonb_typeof(t.data->'reportAllowedWorkerNames') = 'array'
                 and jsonb_array_length(t.data->'reportAllowedWorkerNames') > 0
                then t.data->'reportAllowedWorkerNames'
                else coalesce(t.data->'assignedWorkerNames', '[]'::jsonb)
           end)), '{}')
    from public.dispatch_tickets t
   where t.id = p_ticket_id
     and (
       public.is_admin()
       or (select public.has_perm('ops.dispatch', 'view'))
       or (select public.has_perm('ops.service_requests', 'view'))
       or exists (select 1 from public.service_requests sr
                   join public.customer_login_links l on l.customer_id = sr.customer_id
                  where sr.linked_dispatch_ticket_id = p_ticket_id and l.profile_id = auth.uid())
     );
$$;
revoke execute on function public.customer_ticket_tech_names(text) from public, anon;
grant execute on function public.customer_ticket_tech_names(text) to authenticated;

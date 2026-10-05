-- =====================================================================
-- Customer portal status card: count the WHOLE assigned crew.
--
-- Replaces customer_ticket_tech_names() from 20261017_01. Same access rules,
-- same return type (text[]), still names only — nothing else on the ticket
-- (remarks, requirements, ids) is exposed.
--
-- Why: 20261017_01 returned ONLY the "Can Create Service Report" technicians
-- whenever a ticket had any, so a job order with 5 technicians assigned showed
-- "Jason Pascua + 1" (2 names) under the label "Assigned technicians".
--
-- Now the list is:
--   1. the technician(s) who will create the service report, first (they stay the
--      "face" of the job: the card shows the first name), then
--   2. every other assigned technician, in the order they were assigned.
-- Nobody is listed twice (matched by id; by name only on older tickets that have no ids).
-- The card shows the first name plus "+N" for the rest, so 5 assigned = "Name + 4".
-- Tickets with no designated report writer behave exactly as before (the whole crew).
-- Safe to re-run.
-- =====================================================================
create or replace function public.customer_ticket_tech_names(p_ticket_id text)
returns text[]
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(array(
    select x.name from (
      -- 1. designated report writers
      select r.name, 0 as grp, r.ord
        from jsonb_array_elements_text(
               case when jsonb_typeof(t.data->'reportAllowedWorkerNames') = 'array'
                    then t.data->'reportAllowedWorkerNames' else '[]'::jsonb end) with ordinality as r(name, ord)
      union all
      -- 2. the rest of the assigned crew
      select n.name, 1 as grp, n.ord
        from jsonb_array_elements_text(
               case when jsonb_typeof(t.data->'assignedWorkerNames') = 'array'
                    then t.data->'assignedWorkerNames' else '[]'::jsonb end) with ordinality as n(name, ord)
        left join jsonb_array_elements_text(
               case when jsonb_typeof(t.data->'assignedWorkerIds') = 'array'
                    then t.data->'assignedWorkerIds' else '[]'::jsonb end) with ordinality as i(id, ord) on i.ord = n.ord
       where case
               when i.id is not null and jsonb_typeof(t.data->'reportAllowedWorkerIds') = 'array'
                 then not (t.data->'reportAllowedWorkerIds' @> to_jsonb(i.id))
               when jsonb_typeof(t.data->'reportAllowedWorkerNames') = 'array'
                 then not (t.data->'reportAllowedWorkerNames' @> to_jsonb(n.name))
               else true
             end
    ) x
    order by x.grp, x.ord
  ), '{}')
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

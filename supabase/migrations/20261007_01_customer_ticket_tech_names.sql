-- =====================================================================
-- Customer portal: show the assigned technician's name
--
-- The customer home card ("On the way", "On site" …) gets the crew's
-- names from the linked dispatch ticket. Customers can't read
-- dispatch_tickets at all (RLS: admin, assigned technicians, staff with
-- dispatch access), so the read always came back empty and the card kept
-- saying "Technician to be assigned".
--
-- Rather than open the whole ticket to customers (it carries internal
-- notes, requirements, crew ids), this returns ONLY the assigned names,
-- and only for a ticket linked to one of the caller's own service
-- requests (customer_login_links). Staff and admin get the same answer
-- through their normal access. Safe to re-run.
-- =====================================================================
create or replace function public.customer_ticket_tech_names(p_ticket_id text)
returns text[]
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(array(select jsonb_array_elements_text(coalesce(t.data->'assignedWorkerNames', '[]'::jsonb))), '{}')
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

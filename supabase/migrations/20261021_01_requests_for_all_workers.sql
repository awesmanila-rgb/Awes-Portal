-- =====================================================================
-- AWES App — material requests for every worker (rules, part 1)
--
--  1. Anyone who holds Dispatch (View) — the Operations head and Operations staff —
--     may link a material request to ANY job order. Everyone else still links
--     only job orders they are assigned to; people with Material Requisition
--     (Edit) are unchanged.
--  2. Nobody reviews their own request: a non-Super-Admin can't approve, reject
--     or return a request they made, or set approved quantities on it. The
--     Super Admin is exempt (and server-side jobs, which have no signed-in user).
--  3. inv_workers(): everyone who can receive materials — active technicians and
--     office staff (messengers, the Operations head, …) — for the Issue and
--     Return screens, which only listed technicians. Names only; available to the
--     people who post inventory documents.
--
-- Safe to re-run. Depends on 20260926_02 (mr_check_job_order) and the inventory
-- migrations (inv_is_storekeeper).
-- =====================================================================

-- 1. job-order link rule (body of 20260926_02, plus the Dispatch holders)
create or replace function public.mr_check_job_order()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  d jsonb;
begin
  if new.job_order_id is null or new.job_order_id = '' then
    new.job_order_id := null; new.job_order := null;
    return new;
  end if;
  if tg_op = 'UPDATE' and new.job_order_id is not distinct from old.job_order_id and new.job_order is not null then
    return new;
  end if;
  select data into d from public.dispatch_tickets where id = new.job_order_id;
  if d is null then
    raise exception 'Job order % was not found.', new.job_order_id using errcode = 'P0001';
  end if;
  if not public.has_perm('pur.requisitions', 'edit')
     and not public.has_perm('ops.dispatch', 'view')
     and not coalesce((d -> 'assignedWorkerIds') @> to_jsonb(auth.uid()::text), false) then
    raise exception 'You can only request materials for a job order assigned to you.' using errcode = 'P0001';
  end if;
  new.job_order := jsonb_build_object(
    'id', new.job_order_id, 'custName', coalesce(d ->> 'custName', ''),
    'siteAddress', coalesce(d ->> 'siteAddress', ''), 'category', coalesce(d ->> 'category', ''));
  return new;
end;
$function$;

-- 2. nobody reviews their own request
create or replace function public.mr_self_review_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if public.is_admin() or auth.uid() is null then return new; end if;
  if old.requested_by = auth.uid() and old.status = 'submitted' and new.status in ('approved', 'rejected', 'returned') then
    raise exception 'This is your own request, so someone else has to review it.' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists mr_zz_self_review_guard on public.material_requisitions;
create trigger mr_zz_self_review_guard before update on public.material_requisitions
  for each row execute function public.mr_self_review_guard();

create or replace function public.mr_items_self_review_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if public.is_admin() or auth.uid() is null then return new; end if;
  if new.qty_approved is distinct from old.qty_approved
     and exists (select 1 from public.material_requisitions m where m.id = new.mr_id and m.requested_by = auth.uid()) then
    raise exception 'This is your own request, so someone else has to approve the quantities.' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists mr_items_zz_self_review_guard on public.material_requisition_items;
create trigger mr_items_zz_self_review_guard before update on public.material_requisition_items
  for each row execute function public.mr_items_self_review_guard();

-- 3. who can receive materials
create or replace function public.inv_workers()
returns table (id uuid, name text, role text)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select p.id, p.name, p.role
    from public.profiles p
   where coalesce(p.active, true)
     and p.role in ('technician', 'staff')
     and (public.is_admin() or public.inv_is_storekeeper()
          or public.has_perm('inv.issue', 'view') or public.has_perm('inv.returns', 'view') or public.has_perm('inv.receive', 'view'))
   order by p.name;
$$;
revoke execute on function public.inv_workers() from public, anon;
grant execute on function public.inv_workers() to authenticated;

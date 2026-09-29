-- =====================================================================
-- Deleting customer equipment that already has service history
--
-- A unit with filed service reports (or a service request) couldn't be
-- deleted at all: service_reports.equipment_id and
-- service_requests.equipment_id point at it without ON DELETE, so the
-- database refused and the app only said "Could not remove" — even though
-- the confirmation promised "This does not affect past reports".
--
-- customer_equipment_delete() keeps that promise:
--   * refuses while a job order that isn't finished still lists the unit
--     (a report filed on it later would point at a unit that's gone), and
--     while an open service request is about it;
--   * unlinks past reports and closed requests (each report keeps its own
--     copy of the brand / model / serial / location it was filed with);
--   * then deletes the unit (its photos go with it, as before).
-- Same access as before: Equipment › Edit or Customers › Edit.
-- Safe to re-run.
-- =====================================================================
create or replace function public.customer_equipment_delete(p_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare jo text; n_rep int; n_req int; open_req int;
begin
  if not (public.has_perm('adm.equipment', 'edit') or public.has_perm('adm.customers', 'edit')) then
    raise exception 'You need Edit access to Equipment or Customers to delete equipment.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.customer_equipment where id = p_id) then
    raise exception 'That equipment record no longer exists.';
  end if;

  select coalesce(t.data->>'jobOrderNo', t.id) into jo
    from public.dispatch_tickets t
   where coalesce(t.status, 'open') not in ('completed','closed','cancelled')
     -- a never-acknowledged job order whose day has passed has expired
     and not (coalesce(t.status, 'open') in ('open','preparing')
              and coalesce(t.data->>'date', '9999-12-31') < to_char(now() at time zone 'Asia/Manila', 'YYYY-MM-DD'))
     and t.data->'equipmentList' @> jsonb_build_array(jsonb_build_object('equipmentId', p_id::text))
   limit 1;
  if jo is not null then
    raise exception 'This unit is on job order % which isn''t finished yet — close or cancel it (or remove the unit from it) first.', jo;
  end if;

  select count(*) into open_req from public.service_requests
   where equipment_id = p_id and status not in ('completed','closed','cancelled');
  if open_req > 0 then
    raise exception 'This unit has % open service request(s) — resolve them first.', open_req;
  end if;

  update public.service_reports set equipment_id = null where equipment_id = p_id;
  get diagnostics n_rep = row_count;
  update public.service_requests set equipment_id = null where equipment_id = p_id;
  get diagnostics n_req = row_count;
  delete from public.customer_equipment where id = p_id;
  return jsonb_build_object('reports_unlinked', n_rep, 'requests_unlinked', n_req);
end;
$$;
revoke execute on function public.customer_equipment_delete(uuid) from public, anon;
grant execute on function public.customer_equipment_delete(uuid) to authenticated;

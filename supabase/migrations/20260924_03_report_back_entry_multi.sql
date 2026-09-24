-- ---------------------------------------------------------------------
-- Record Past Service: several units in one go
--
-- admin_record_past_services(p_reports jsonb) takes a JSON array of the
-- same report objects admin_record_past_service() takes (one per unit)
-- and files them in ONE transaction: every unit gets its own SR number,
-- and if any one is rejected (wrong unit, future date…) none are saved,
-- so a half-filed multi-unit visit can't happen.
--
-- Depends on 20260924_02_report_back_entry.sql. Safe to re-run.
-- ---------------------------------------------------------------------
create or replace function public.admin_record_past_services(p_reports jsonb)
returns text[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_out  text[] := '{}';
  v_item jsonb;
  v_eq   uuid[] := '{}';
  v_id   uuid;
begin
  if not public.is_admin() then
    raise exception 'Only admin can record past service.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_reports) <> 'array' or jsonb_array_length(p_reports) = 0 then
    raise exception 'Add at least one unit.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_reports) > 50 then
    raise exception 'Record at most 50 units at a time.' using errcode = 'P0001';
  end if;
  for v_item in select * from jsonb_array_elements(p_reports) loop
    v_id := nullif(v_item->>'equipment_id', '')::uuid;
    if v_id is not null and v_id = any(v_eq) then
      raise exception 'The same unit was added twice.' using errcode = 'P0001';
    end if;
    v_eq := v_eq || v_id;
    v_out := v_out || public.admin_record_past_service(v_item);
  end loop;
  return v_out;
end;
$$;
revoke all on function public.admin_record_past_services(jsonb) from public, anon;
grant execute on function public.admin_record_past_services(jsonb) to authenticated;

NOTIFY pgrst, 'reload schema';

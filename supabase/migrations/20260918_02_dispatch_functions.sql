-- ---------------------------------------------------------------------
-- Job Order lifecycle, 2 of 3 — server clock and safe concurrent writes
--
-- The three functions the client leans on:
--
--   server_now()                    a clock it can trust
--   dispatch_mark_completed()       auto-completion, without a lost update
--   dispatch_set_equipment_state()  per-unit writes, without a lost update
--
-- Safe to re-run — all three are create-or-replace.
-- ---------------------------------------------------------------------


-- =====================================================================
-- server_now()
--
-- The job order lifecycle computes three things from the clock rather than
-- storing them: when the acknowledgement window opens (4 hours before the
-- scheduled time), when a job order expires (8 hours after it, if nobody
-- acknowledged), and which stage to show right now. Computing beats
-- storing here — no scheduled job to run and monitor, and nothing to clean
-- up when a date is edited — but it makes the clock load-bearing, and a
-- field phone can be wrong two different ways:
--
--   * a skewed clock, which a measured offset corrects
--   * a correct clock in the wrong timezone, which an offset does NOT
--
-- The client measures its offset against this once per session and derives
-- everything in a fixed business timezone, so neither failure lets a
-- technician acknowledge early or expire a job order late.
--
-- Returns timestamptz rather than a pre-formatted date so the timezone
-- decision stays in one place in the app instead of split across two
-- languages. Callable by any signed-in role: it exposes nothing but the
-- time, and every role needs it.
-- =====================================================================
create or replace function public.server_now()
returns timestamptz
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select now();
$$;

revoke all on function public.server_now() from public;
grant execute on function public.server_now() to authenticated;

comment on function public.server_now is
  'Returns the database server''s current instant. Called by syncServerTime() in core.js so the client can measure its clock offset — the job order acknowledgement window and expiry are computed from it.';


-- =====================================================================
-- dispatch_mark_completed()
--
-- Completion is no longer a button. A job order completes once every
-- equipment line has either a Service Report or a Not Yet Done reason, and
-- the client checks after each report is filed. That creates a race the
-- old "Mark Completed" tap never had:
--
--   Two technicians file the last two reports at the same moment. Each
--   client re-reads the ticket, merges its own change into the whole
--   `data` blob, and writes it back. The slower write wins and erases the
--   faster one's reportSrNo — the report row still exists, but the ticket
--   no longer knows about it, so that unit looks unreported forever and
--   the job order can never complete.
--
-- Writing only the status fields server-side, merged into whatever `data`
-- currently holds, removes the window: equipmentList is never sent from
-- the client here, so it cannot be clobbered. The completion CONDITION is
-- re-checked here rather than trusted from the caller, since a client that
-- read a stale row could otherwise complete a ticket with units still open.
-- =====================================================================
create or replace function public.dispatch_mark_completed(p_ticket_id text, p_completed_at timestamptz default now())
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role       text;
  v_data       jsonb;
  v_status     text;
  v_units      jsonb;
  v_unresolved int;
begin
  select role into v_role from public.profiles where id = auth.uid();
  if v_role is null or v_role not in ('admin','technician') then
    return false;
  end if;

  select data, status into v_data, v_status
    from public.dispatch_tickets where id = p_ticket_id
    for update;   -- serialises concurrent callers on this one row
  if v_data is null then return false; end if;

  if v_status in ('completed','closed','cancelled') then return false; end if;

  v_units := coalesce(v_data -> 'equipmentList', '[]'::jsonb);
  if jsonb_array_length(v_units) = 0 then return false; end if;

  -- A unit counts as resolved by a filed report OR an explicit not-done
  -- flag. Both are decisions; only an untouched unit blocks completion.
  select count(*) into v_unresolved
    from jsonb_array_elements(v_units) as u
    where coalesce(u ->> 'reportSrNo', '') = ''
      and coalesce((u ->> 'notDone')::boolean, false) = false;
  if v_unresolved > 0 then return false; end if;

  update public.dispatch_tickets
     set status = 'completed',
         data = data || jsonb_build_object('status','completed','completedAt', p_completed_at)
   where id = p_ticket_id;

  return true;
end;
$$;

revoke all on function public.dispatch_mark_completed(text, timestamptz) from public;
grant execute on function public.dispatch_mark_completed(text, timestamptz) to authenticated;

comment on function public.dispatch_mark_completed is
  'Completes a dispatch ticket if and only if every equipment line has a Service Report or a Not Yet Done flag. Re-checks the condition server-side and writes only the status fields, so two technicians filing the last reports at once cannot clobber each other''s equipmentList.';


-- =====================================================================
-- dispatch_set_equipment_state()
--
-- The same lost-update problem one level down, and far likelier to fire
-- because it happens during active work rather than at the end. Three
-- client paths write a single equipment line:
--
--   a Service Report was filed for this unit
--   a draft was autosaved against it
--   the technician flagged it as not serviceable
--
-- On a multi-technician, multi-unit job order — a plant or warehouse
-- visit, the normal case — two people touching two different units would
-- each send the whole list and erase the other's work.
--
-- The patch is merged into the existing element, so a caller setting
-- reportSrNo does not need to know or resend notDone, scope, or anything
-- else on that unit.
-- =====================================================================
create or replace function public.dispatch_set_equipment_state(
  p_ticket_id  text,
  p_equip_id   text,
  p_patch      jsonb,
  p_clear_keys text[] default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role  text;
  v_data  jsonb;
  v_units jsonb;
  v_new   jsonb := '[]'::jsonb;
  v_item  jsonb;
  v_hit   boolean := false;
  v_key   text;
begin
  select role into v_role from public.profiles where id = auth.uid();
  if v_role is null or v_role not in ('admin','technician') then
    return false;
  end if;

  select data into v_data from public.dispatch_tickets
    where id = p_ticket_id
    for update;
  if v_data is null then return false; end if;

  v_units := coalesce(v_data -> 'equipmentList', '[]'::jsonb);

  for v_item in select * from jsonb_array_elements(v_units) loop
    if (v_item ->> 'id') = p_equip_id then
      v_item := v_item || coalesce(p_patch, '{}'::jsonb);
      -- Keys are REMOVED rather than set to null or false: an un-flagged
      -- unit carrying a leftover notDoneBy still reads as flagged
      -- everywhere that checks for the field's presence.
      if p_clear_keys is not null then
        foreach v_key in array p_clear_keys loop
          v_item := v_item - v_key;
        end loop;
      end if;
      v_hit := true;
    end if;
    v_new := v_new || jsonb_build_array(v_item);
  end loop;

  if not v_hit then return false; end if;

  update public.dispatch_tickets
     set data = data || jsonb_build_object('equipmentList', v_new)
   where id = p_ticket_id;

  return true;
end;
$$;

revoke all on function public.dispatch_set_equipment_state(text, text, jsonb, text[]) from public;
grant execute on function public.dispatch_set_equipment_state(text, text, jsonb, text[]) to authenticated;

comment on function public.dispatch_set_equipment_state is
  'Merges a patch into ONE equipment line of a dispatch ticket under a row lock, optionally removing keys. Used when a report is filed, a draft autosaves, or a unit is flagged Not Yet Done, so two technicians working different units on the same job order cannot overwrite each other.';

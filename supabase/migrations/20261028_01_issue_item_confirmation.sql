-- =====================================================================
-- AWES App — the worker confirms an issue ITEM BY ITEM
--
-- Until now a worker could only sign a whole issue slip. Now they tick what they received,
-- say how many (short?) and mark anything damaged. If anything differs, a remark is required and
-- the slip is saved as "received with differences" so the issuer can follow up; the issuer is told.
-- The signature is still required (same pad, same private bucket) — the item check comes first.
--
-- Stock is NOT changed by a difference: the warehouse already booked the full quantity out and
-- the worker's holding still shows it. The slip is flagged; the storekeeper resolves it (a return,
-- or a recount) like any other discrepancy. inv_ack_issue() (sign the whole slip) is kept for older screens.
-- Safe to re-run. Depends on 20260923_08_inventory_movements.sql.
-- =====================================================================
alter table public.issue_slip_items add column if not exists qty_received numeric(14,3) check (qty_received is null or qty_received >= 0);
alter table public.issue_slip_items add column if not exists damaged boolean not null default false;
alter table public.issue_slip_items add column if not exists item_note text not null default '';
alter table public.issue_slips add column if not exists ack_diff boolean not null default false;
alter table public.issue_slips add column if not exists ack_note text not null default '';

create or replace function public.inv_ack_issue_items(p jsonb)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  s public.issue_slips%rowtype; it record; ln jsonb; v_found boolean; v_q numeric; v_dm boolean;
  v_diff boolean := false; v_any boolean := false; v_short numeric := 0; v_dmg int := 0; v_sig text; v_remark text;
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  select * into s from public.issue_slips where id = nullif(p->>'slip_id', '')::uuid for update;
  if s.id is null or s.worker_id <> auth.uid() then raise exception 'That slip isn''t yours.' using errcode = '42501'; end if;
  if s.status = 'acknowledged' then raise exception 'You already confirmed this slip.' using errcode = 'P0001'; end if;
  v_sig := coalesce(p->>'signature_path', '');
  if v_sig = '' or split_part(v_sig, '/', 1) <> auth.uid()::text then raise exception 'Sign to confirm.' using errcode = 'P0001'; end if;
  v_remark := btrim(coalesce(p->>'remark', ''));

  for it in select * from public.issue_slip_items where slip_id = s.id order by line_no loop
    v_found := false;
    for ln in select * from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) loop
      if nullif(ln->>'item_id', '')::uuid = it.id then
        v_found := true;
        v_q := coalesce(nullif(ln->>'qty_received', '')::numeric, 0);
        v_dm := coalesce((ln->>'damaged')::boolean, false);
        if v_q < 0 then raise exception 'The quantity can''t be negative.' using errcode = 'P0001'; end if;
        if v_q > it.qty then raise exception 'You can''t confirm more than was issued (% issued).', trim_scale(it.qty) using errcode = 'P0001'; end if;
        if v_dm and v_q = 0 then raise exception 'A damaged item has to be one you received.' using errcode = 'P0001'; end if;
        if v_q > 0 then v_any := true; end if;
        if v_q < it.qty or v_dm then v_diff := true; end if;
        v_short := v_short + (it.qty - v_q); if v_dm then v_dmg := v_dmg + 1; end if;
        update public.issue_slip_items set qty_received = v_q, damaged = v_dm, item_note = btrim(coalesce(ln->>'note', '')) where id = it.id;
      end if;
    end loop;
    if not v_found then raise exception 'Every item needs an answer (0 if you did not receive it).' using errcode = 'P0001'; end if;
  end loop;
  if not v_any then raise exception 'Received nothing? Tell the storekeeper instead of signing.' using errcode = 'P0001'; end if;
  if v_diff and v_remark = '' then raise exception 'Explain the difference in the remarks.' using errcode = 'P0001'; end if;

  update public.issue_slips set status = 'acknowledged', ack_at = now(), ack_signature_path = v_sig, ack_diff = v_diff, ack_note = v_remark where id = s.id;
  return jsonb_build_object('slip_no', s.slip_no, 'diff', v_diff, 'short_units', v_short, 'damaged_lines', v_dmg, 'issued_by', s.issued_by, 'worker_name', s.worker_name);
end;
$$;
revoke execute on function public.inv_ack_issue_items(jsonb) from public, anon;
grant execute on function public.inv_ack_issue_items(jsonb) to authenticated;

-- =====================================================================
-- AWES App — Materials Monitor (very simple)
--
-- One row per request, with ONE stage and ONE answer to "who has to act next?":
--
--   approval  To approve          waiting on: the approver
--   buying    Being bought        waiting on: the office (choose how) / purchasing (PO) /
--                                 the supplier (delivery) / the buyer (a worker buying it)
--   ready     Ready to hand over  waiting on: the warehouse (it has arrived, or is in stock)
--   sign      Waiting for signature  waiting on: the person it was issued to
--   done      Done                everything is with the workers and signed
--
-- A request with several items shows the EARLIEST stage any item is still in (what is holding
-- it up), plus a count of items per stage. "days" = days since that stage began (since the
-- request was sent / approved / issued). "late" = needed-by date passed and not done.
-- Same visibility as the trail: the requester, the collector, the office (Requisition View),
-- the Super Admin, and storekeepers for approved requests. Names and counts only — no prices.
--
-- Depends on 20261024_01 and 20261025_01 (mr_can_see, mr_item_facts). Safe to re-run.
-- =====================================================================
create or replace function public.mr_monitor(p_days int default 60)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  m record; i record; f jsonb;
  v_today date := (now() at time zone 'Asia/Manila')::date;
  v_rows jsonb := '[]'::jsonb;
  rank_ int; best int; v_stage text; v_who text; v_since timestamptz; v_item_stage text; v_item_who text; v_item_since timestamptz;
  cnt jsonb; total int; v_collector text; v_last timestamptz; v_issued_on timestamptz;
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;

  for m in
    select * from public.material_requisitions r
     where r.status in ('submitted', 'approved', 'fulfilled')
       and public.mr_can_see(r.id)
       and (r.status <> 'fulfilled' or coalesce(r.reviewed_at, r.submitted_at, r.created_at) >= now() - make_interval(days => greatest(coalesce(p_days, 60), 1)))
     order by coalesce(r.submitted_at, r.created_at) desc
  loop
    cnt := jsonb_build_object('approval', 0, 'buying', 0, 'ready', 0, 'sign', 0, 'done', 0);
    total := 0; best := 99; v_stage := 'done'; v_who := ''; v_since := null;

    if m.status = 'submitted' then
      select count(*) into total from public.material_requisition_items where mr_id = m.id;
      cnt := jsonb_set(cnt, '{approval}', to_jsonb(total));
      v_stage := 'approval'; v_who := 'The approver'; v_since := coalesce(m.submitted_at, m.created_at);
    else
      for i in select * from public.material_requisition_items where mr_id = m.id order by line_no loop
        f := public.mr_item_facts(i.id, false);
        total := total + 1;
        v_issued_on := (select min((x->>'on')::timestamptz) from jsonb_array_elements(coalesce(f->'issued', '[]'::jsonb)) x where x->>'status' = 'issued');
        if f->>'route' = 'none' then
          v_item_stage := 'done'; rank_ := 4; v_item_who := ''; v_item_since := null;
        elsif jsonb_path_exists(coalesce(f->'issued', '[]'::jsonb), '$[*] ? (@.status == "issued")') then
          v_item_stage := 'sign'; rank_ := 3; v_item_who := coalesce((select x->>'worker' from jsonb_array_elements(f->'issued') x where x->>'status' = 'issued' limit 1), 'The worker');
          v_item_since := v_issued_on;
        elsif (f->>'progress')::int >= 5 then
          v_item_stage := 'done'; rank_ := 4; v_item_who := ''; v_item_since := null;
        elsif (f->>'progress')::int = 4 then
          v_item_stage := 'ready'; rank_ := 2; v_item_who := 'The warehouse'; v_item_since := coalesce(m.reviewed_at, m.submitted_at);
        else
          v_item_stage := 'buying'; rank_ := 1; v_item_since := coalesce(m.reviewed_at, m.submitted_at);
          v_item_who := case
            when f->>'route' = 'tech_buy' then coalesce(f->'buyer'->>'name', m.requester_name, 'The buyer')
            when f->>'route' = 'po' and f->'po' is not null and f->'po'->>'status' = 'issued' then 'The supplier (delivery)'
            when f->>'route' = 'po' then 'Purchasing (the PO)'
            when f->>'route' = 'stock' then 'The warehouse'
            else 'The office (choose how to get it)' end;
        end if;
        cnt := jsonb_set(cnt, array[v_item_stage], to_jsonb((cnt->>v_item_stage)::int + 1));
        if rank_ < best then best := rank_; v_stage := v_item_stage; v_who := v_item_who; v_since := v_item_since; end if;
      end loop;
      if total = 0 then v_stage := 'done'; end if;
    end if;

    select name into v_collector from public.profiles where id = (select collector_id from public.material_requisition_collectors where mr_id = m.id);
    v_rows := v_rows || jsonb_build_object(
      'id', m.id, 'mrf_no', m.mrf_no, 'requester_name', m.requester_name, 'requested_by', m.requested_by,
      'collector', v_collector, 'job_order', m.job_order, 'urgency', m.urgency, 'needed_by', m.needed_by, 'status', m.status,
      'stage', v_stage, 'waiting_on', case when v_stage = 'done' then '' else v_who end,
      'since', v_since, 'days', case when v_stage = 'done' or v_since is null then null else greatest(0, v_today - (v_since at time zone 'Asia/Manila')::date) end,
      'late', (v_stage <> 'done' and m.needed_by is not null and m.needed_by < v_today),
      'counts', cnt, 'total', total);
  end loop;

  return jsonb_build_object('today', v_today, 'rows', v_rows);
end;
$$;
revoke execute on function public.mr_monitor(int) from public, anon;
grant execute on function public.mr_monitor(int) to authenticated;

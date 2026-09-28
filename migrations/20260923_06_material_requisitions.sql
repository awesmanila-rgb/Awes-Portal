-- ---------------------------------------------------------------------
-- Purchasing — Material Requisition (MRF)
--
-- A technician requests materials (usually for one of THEIR job orders);
-- an admin approves — adjusting quantities — rejects, or returns it for
-- changes; approved lines are then fulfilled either by a Purchase Order or
-- by the technician buying them (cash advance).
--
-- Tables:
--   material_requisitions        header
--   material_requisition_items   lines
--   mrf_counters                 per-year counter behind MRF-YYYY-NNNN
-- Storage:
--   requisition-photos           optional photo per request; techs write
--                                only into their own folder (<uid>/…)
--
-- status:  draft ─► submitted ─► approved ─► fulfilled
--            ▲          │  ├──► rejected
--            └ returned ◄┘  └──► (any open state) ─► cancelled
--
-- Rules the DATABASE enforces:
--   * Technicians see and edit ONLY their own requests, and can link only
--     a job order they are assigned to.
--   * Technicians edit only while draft/returned, and can only move it to
--     submitted (or cancel it). Approve / reject / return, approved
--     quantities and fulfilment are admin-only — even via the API.
--   * Once approved/rejected/cancelled/fulfilled the request is locked;
--     only fulfilment (admin) moves on.
--   * A line is covered when it's on a non-cancelled PO, marked "tech buys",
--     or approved at 0. The request becomes 'fulfilled' automatically when
--     every line is covered, and drops back to 'approved' if a linked PO is
--     cancelled or its draft deleted.
--
-- Depends on 20260923_01 and 20260923_03. Safe to re-run.
-- ---------------------------------------------------------------------

do $$
begin
  if to_regclass('public.materials') is null or to_regclass('public.purchase_orders') is null then
    raise exception 'Run 20260923_01 and 20260923_03 first.';
  end if;
end $$;

create table if not exists public.mrf_counters (
  year     int primary key,
  last_no  int not null default 0
);

create table if not exists public.material_requisitions (
  id              uuid primary key default gen_random_uuid(),
  mrf_no          text unique,                                  -- set by trigger
  status          text not null default 'draft'
                    check (status in ('draft','submitted','returned','approved','rejected','cancelled','fulfilled')),
  requested_by    uuid not null default auth.uid() references auth.users(id),
  requester_name  text not null default '',                     -- snapshot, set by trigger
  job_order_id    text,                                         -- dispatch_tickets.id (JO-…)
  job_order       jsonb,                                        -- snapshot: customer, site, category
  needed_by       date,
  urgency         text not null default 'normal' check (urgency in ('normal','urgent','emergency')),
  deliver_to      text not null default '',
  purpose         text not null default '',
  photo_path      text not null default '',
  review_note     text not null default '',                     -- reason for reject / return
  reviewed_by     uuid references auth.users(id),
  reviewer_name   text not null default '',
  submitted_at    timestamptz,
  reviewed_at     timestamptz,
  fulfilled_at    timestamptz,
  cancelled_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists material_requisitions_status_idx on public.material_requisitions (status, created_at desc);
create index if not exists material_requisitions_requester_idx on public.material_requisitions (requested_by, created_at desc);

create table if not exists public.material_requisition_items (
  id             uuid primary key default gen_random_uuid(),
  mr_id          uuid not null references public.material_requisitions(id) on delete cascade,
  line_no        int not null default 1,
  material_id    uuid references public.materials(id) on delete restrict,   -- null = free-text item
  code           text not null default '',
  description    text not null,
  unit           text not null default '',
  qty_requested  numeric(14,3) not null check (qty_requested > 0),
  qty_approved   numeric(14,3) check (qty_approved is null or qty_approved >= 0),   -- admin
  note           text not null default '',
  fulfilled_by   text check (fulfilled_by is null or fulfilled_by in ('po','tech_buy')),   -- admin
  po_id          uuid references public.purchase_orders(id) on delete set null,          -- admin
  created_at     timestamptz not null default now()
);
create index if not exists material_requisition_items_mr_idx on public.material_requisition_items (mr_id, line_no);
create index if not exists material_requisition_items_po_idx on public.material_requisition_items (po_id);

-- ---------- header: number + requester on insert ----------
create or replace function public.mr_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  y int := extract(year from (now() at time zone 'Asia/Manila'))::int;
  n int;
begin
  if not public.is_admin() then
    new.requested_by := auth.uid();                -- a tech can only request for themselves
    if new.status not in ('draft', 'submitted') then new.status := 'draft'; end if;
    new.review_note := ''; new.reviewed_by := null; new.reviewer_name := '';
    new.reviewed_at := null; new.fulfilled_at := null; new.cancelled_at := null;
  elsif new.status not in ('draft', 'submitted') then
    new.status := 'draft';
  end if;
  insert into public.mrf_counters as c (year, last_no) values (y, 1)
    on conflict (year) do update set last_no = c.last_no + 1
    returning last_no into n;
  new.mrf_no := 'MRF-' || y || '-' || lpad(n::text, 4, '0');
  new.requester_name := coalesce((select name from public.profiles where id = new.requested_by), '');
  if new.status = 'submitted' then new.submitted_at := now(); end if;
  return new;
end;
$$;
drop trigger if exists material_requisitions_before_insert on public.material_requisitions;
create trigger material_requisitions_before_insert
  before insert on public.material_requisitions
  for each row execute function public.mr_before_insert();

-- ---------- job order: must be one of the requester's ----------
create or replace function public.mr_check_job_order()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
  if not public.is_admin()
     and not coalesce((d -> 'assignedWorkerIds') @> to_jsonb(auth.uid()::text), false) then
    raise exception 'You can only request materials for a job order assigned to you.' using errcode = 'P0001';
  end if;
  new.job_order := jsonb_build_object(
    'id', new.job_order_id, 'custName', coalesce(d ->> 'custName', ''),
    'siteAddress', coalesce(d ->> 'siteAddress', ''), 'category', coalesce(d ->> 'category', ''));
  return new;
end;
$$;
drop trigger if exists material_requisitions_check_job on public.material_requisitions;
create trigger material_requisitions_check_job
  before insert or update of job_order_id on public.material_requisitions
  for each row execute function public.mr_check_job_order();

-- ---------- header: who may change what ----------
create or replace function public.mr_before_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  admin boolean := public.is_admin();
  locked text[] := array['approved', 'rejected', 'cancelled', 'fulfilled'];
  sys text[] := array['status', 'updated_at', 'fulfilled_at', 'cancelled_at'];
begin
  new.mrf_no := old.mrf_no;
  new.requested_by := old.requested_by;
  new.requester_name := old.requester_name;
  new.created_at := old.created_at;

  if not admin then
    if old.requested_by <> auth.uid() then
      raise exception 'Not your request.' using errcode = '42501';
    end if;
    -- review fields are never the technician's to set
    new.review_note := old.review_note; new.reviewed_by := old.reviewed_by;
    new.reviewer_name := old.reviewer_name; new.reviewed_at := old.reviewed_at;
    new.fulfilled_at := old.fulfilled_at;
    if new.status = 'cancelled' and old.status in ('draft', 'submitted', 'returned') then
      new.cancelled_at := now();
      return new;
    end if;
    if old.status not in ('draft', 'returned') then
      raise exception 'This request is % and can no longer be changed.', old.status using errcode = 'P0001';
    end if;
    if new.status not in ('draft', 'returned', 'submitted') then
      raise exception 'Only an admin can mark a request as %.', new.status using errcode = 'P0001';
    end if;
    if new.status = 'submitted' then
      if not exists (select 1 from public.material_requisition_items where mr_id = new.id) then
        raise exception 'Add at least one item before submitting.' using errcode = 'P0001';
      end if;
      new.submitted_at := now();
    elsif new.status = 'returned' and old.status = 'draft' then
      new.status := 'draft';
    end if;
    return new;
  end if;

  -- ---- admin ----
  if old.status = any(locked) then
    -- only fulfilment bookkeeping moves on after approval
    if old.status in ('approved', 'fulfilled') and new.status in ('approved', 'fulfilled', 'cancelled')
       and (to_jsonb(new) - sys) = (to_jsonb(old) - sys) then
      if new.status = 'cancelled' and old.status <> 'cancelled' then new.cancelled_at := now(); end if;
      if new.status = 'fulfilled' and old.status <> 'fulfilled' then new.fulfilled_at := now(); end if;
      if new.status = 'approved' then new.fulfilled_at := null; end if;
      return new;
    end if;
    raise exception 'Request % is % and locked.', old.mrf_no, old.status using errcode = 'P0001';
  end if;

  if new.status is distinct from old.status then
    if new.status in ('approved', 'rejected', 'returned') then
      if old.status <> 'submitted' then
        raise exception 'Only a submitted request can be %.', new.status using errcode = 'P0001';
      end if;
      if new.status in ('rejected', 'returned') and coalesce(trim(new.review_note), '') = '' then
        raise exception 'Give the technician a reason.' using errcode = 'P0001';
      end if;
      new.reviewed_by := auth.uid();
      new.reviewer_name := coalesce((select name from public.profiles where id = auth.uid()), 'Admin');
      new.reviewed_at := now();
      if new.status = 'approved' then
        -- anything the admin didn't adjust is approved as requested
        update public.material_requisition_items set qty_approved = qty_requested
         where mr_id = new.id and qty_approved is null;
      end if;
    elsif new.status = 'cancelled' then
      new.cancelled_at := now();
    elsif new.status = 'submitted' and old.status in ('draft', 'returned') then
      new.submitted_at := now();
    elsif new.status = 'fulfilled' then
      raise exception 'A request becomes fulfilled when all its lines are covered.' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists material_requisitions_a_guard on public.material_requisitions;
create trigger material_requisitions_a_guard
  before update on public.material_requisitions
  for each row execute function public.mr_before_update();

drop trigger if exists material_requisitions_set_updated_at on public.material_requisitions;
create trigger material_requisitions_set_updated_at
  before update on public.material_requisitions
  for each row execute function public.purch_touch_updated_at();

create or replace function public.mr_before_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.status <> 'draft' then
    raise exception 'Only drafts can be deleted — cancel it instead.' using errcode = 'P0001';
  end if;
  if not public.is_admin() and old.requested_by <> auth.uid() then
    raise exception 'Not your request.' using errcode = '42501';
  end if;
  return old;
end;
$$;
drop trigger if exists material_requisitions_guard_delete on public.material_requisitions;
create trigger material_requisitions_guard_delete
  before delete on public.material_requisitions
  for each row execute function public.mr_before_delete();

-- ---------- items: who may change what ----------
create or replace function public.mr_items_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  admin boolean := public.is_admin();
  h record;
begin
  select status, requested_by into h from public.material_requisitions where id = coalesce(new.mr_id, old.mr_id);
  if h is null then return coalesce(new, old); end if;        -- parent draft being deleted (cascade)
  if tg_op = 'UPDATE' and new.mr_id <> old.mr_id then
    raise exception 'Items can''t be moved to another request.' using errcode = 'P0001';
  end if;

  if not admin then
    if h.requested_by <> auth.uid() then raise exception 'Not your request.' using errcode = '42501'; end if;
    if h.status not in ('draft', 'returned') then
      raise exception 'Items can only be changed while the request is a draft or returned.' using errcode = 'P0001';
    end if;
    if tg_op <> 'DELETE' then
      new.qty_approved := case when tg_op = 'UPDATE' then old.qty_approved else null end;
      new.fulfilled_by := case when tg_op = 'UPDATE' then old.fulfilled_by else null end;
      new.po_id        := case when tg_op = 'UPDATE' then old.po_id else null end;
    end if;
    return coalesce(new, old);
  end if;

  -- admin: edit lines freely until approval; after approval only fulfilment
  if h.status in ('approved', 'fulfilled') then
    if tg_op <> 'UPDATE' or (to_jsonb(new) - array['fulfilled_by', 'po_id']) <> (to_jsonb(old) - array['fulfilled_by', 'po_id']) then
      raise exception 'An approved request''s items are locked — only fulfilment can change.' using errcode = 'P0001';
    end if;
  elsif h.status in ('rejected', 'cancelled') then
    raise exception 'This request is closed.' using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end;
$$;
drop trigger if exists material_requisition_items_guard on public.material_requisition_items;
create trigger material_requisition_items_guard
  before insert or update or delete on public.material_requisition_items
  for each row execute function public.mr_items_guard();

-- ---------- fulfilment: approved <-> fulfilled, automatically ----------
create or replace function public.mr_refresh_fulfilment(p_mr uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  st text;
  open_lines int;
begin
  select status into st from public.material_requisitions where id = p_mr;
  if st not in ('approved', 'fulfilled') then return; end if;
  select count(*) into open_lines
    from public.material_requisition_items i
    left join public.purchase_orders p on p.id = i.po_id
   where i.mr_id = p_mr
     and coalesce(i.qty_approved, i.qty_requested) > 0
     -- coalesce: a NULL here would make the line "unknown" and silently
     -- drop it from the count, closing the request too early
     and not (coalesce(i.fulfilled_by, '') = 'tech_buy'
              or (i.po_id is not null and coalesce(p.status, '') <> 'cancelled'));
  if open_lines = 0 and st = 'approved' then
    update public.material_requisitions set status = 'fulfilled' where id = p_mr;
  elsif open_lines > 0 and st = 'fulfilled' then
    update public.material_requisitions set status = 'approved' where id = p_mr;
  end if;
end;
$$;

create or replace function public.mr_items_after()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.mr_refresh_fulfilment(coalesce(new.mr_id, old.mr_id));
  return null;
end;
$$;
drop trigger if exists material_requisition_items_after on public.material_requisition_items;
create trigger material_requisition_items_after
  after insert or update or delete on public.material_requisition_items
  for each row execute function public.mr_items_after();

-- A linked PO being cancelled re-opens its lines (the PO id stays for history).
create or replace function public.mr_po_status_changed()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare r record;
begin
  if new.status is distinct from old.status then
    for r in select distinct mr_id from public.material_requisition_items where po_id = new.id loop
      perform public.mr_refresh_fulfilment(r.mr_id);
    end loop;
  end if;
  return null;
end;
$$;
drop trigger if exists purchase_orders_mr_refresh on public.purchase_orders;
create trigger purchase_orders_mr_refresh
  after update of status on public.purchase_orders
  for each row execute function public.mr_po_status_changed();

-- =====================================================================
-- Storage: optional photo (techs write only under their own folder)
-- =====================================================================
insert into storage.buckets (id, name, public)
values ('requisition-photos', 'requisition-photos', false)
on conflict (id) do nothing;

drop policy if exists mr_photos_select on storage.objects;
create policy mr_photos_select on storage.objects
  for select to authenticated
  using (bucket_id = 'requisition-photos' and (public.is_admin() or (storage.foldername(name))[1] = auth.uid()::text));
drop policy if exists mr_photos_insert on storage.objects;
create policy mr_photos_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'requisition-photos' and (storage.foldername(name))[1] = auth.uid()::text);

-- =====================================================================
-- RLS + grants
-- =====================================================================
alter table public.mrf_counters               enable row level security;
alter table public.material_requisitions      enable row level security;
alter table public.material_requisition_items enable row level security;

drop policy if exists mr_select on public.material_requisitions;
create policy mr_select on public.material_requisitions
  for select to authenticated using (public.is_admin() or requested_by = auth.uid());
drop policy if exists mr_insert on public.material_requisitions;
create policy mr_insert on public.material_requisitions
  for insert to authenticated with check (public.is_admin() or requested_by = auth.uid());
drop policy if exists mr_update on public.material_requisitions;
create policy mr_update on public.material_requisitions
  for update to authenticated using (public.is_admin() or requested_by = auth.uid())
  with check (public.is_admin() or requested_by = auth.uid());
drop policy if exists mr_delete on public.material_requisitions;
create policy mr_delete on public.material_requisitions
  for delete to authenticated using (public.is_admin() or requested_by = auth.uid());

drop policy if exists mr_items_all on public.material_requisition_items;
create policy mr_items_all on public.material_requisition_items
  for all to authenticated
  using (public.is_admin() or exists (select 1 from public.material_requisitions m where m.id = mr_id and m.requested_by = auth.uid()))
  with check (public.is_admin() or exists (select 1 from public.material_requisitions m where m.id = mr_id and m.requested_by = auth.uid()));

grant select, insert, update, delete on public.material_requisitions, public.material_requisition_items to authenticated;
revoke all on public.mrf_counters, public.material_requisitions, public.material_requisition_items from anon;
revoke all on public.mrf_counters from authenticated;

do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['material_requisitions', 'material_requisition_items'] loop
      if not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

NOTIFY pgrst, 'reload schema';

-- =====================================================================
-- Purchase Orders: Purchasing prepares, the Accounting head approves
--
--   Purchasing (Purchase Orders › Edit) prepares the draft and taps
--   "Submit for Approval". The draft is then locked for editing and goes
--   to everyone with Purchase Orders › Approve (give that to the
--   Accounting head): Inbox item "PO waiting for approval" (overdue 24h,
--   escalates 48h), push notification, and "Needs you now" for admin.
--   The approver opens it and either:
--     * Approve & Issue — the existing issue rules apply: within their
--       peso limit, not a PO they drafted, password re-entered, and
--       *their* signatory is printed as "Approved by"; or
--     * Return — with a note; the draft goes back to Purchasing to fix and
--       submit again ("PO returned" in their Inbox).
--   Purchasing can Withdraw a submitted draft to change it.
--   Staff can only issue a PO that was submitted for approval; the Super
--   Admin can still issue directly. Safe to re-run.
-- =====================================================================
begin;

alter table public.purchase_orders
  add column if not exists approval_requested_at   timestamptz,
  add column if not exists approval_requested_by   uuid references public.profiles(id) on delete set null,
  add column if not exists approval_requested_name text,
  add column if not exists returned_at             timestamptz,
  add column if not exists returned_by_name        text,
  add column if not exists returned_note           text not null default '';

-- ---- guard: submission locks the draft; staff issue only what was submitted
-- (not security definer: it needs current_user to tell app users from the
--  functions below)
create or replace function public.po_approval_guard()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare locked text[] := array['approval_requested_at','approval_requested_by','approval_requested_name',
                               'returned_at','returned_by_name','returned_note'];
begin
  if current_user not in ('anon', 'authenticated') then return new; end if;   -- the functions below
  if old.status <> 'draft' then return new; end if;                          -- issued / cancelled: po_before_update rules
  -- the approval columns are only set by the functions below
  new.approval_requested_at := old.approval_requested_at; new.approval_requested_by := old.approval_requested_by;
  new.approval_requested_name := old.approval_requested_name; new.returned_at := old.returned_at;
  new.returned_by_name := old.returned_by_name; new.returned_note := old.returned_note;
  if new.status = 'issued' then
    if old.approval_requested_at is null and not public.is_admin() then
      raise exception 'Submit this PO for approval first — it''s issued by the approver.' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if old.approval_requested_at is not null
     and (to_jsonb(new) - 'updated_at' - 'subtotal' - 'vat_amount' - 'total' - 'ewt_amount' - 'net_payable')
         is distinct from (to_jsonb(old) - 'updated_at' - 'subtotal' - 'vat_amount' - 'total' - 'ewt_amount' - 'net_payable') then
    raise exception 'PO % is waiting for approval and can''t be changed — withdraw it first, or ask the approver to return it.', coalesce(old.po_no, '')
      using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists purchase_orders_b_approval on public.purchase_orders;
create trigger purchase_orders_b_approval before update on public.purchase_orders
  for each row execute function public.po_approval_guard();

create or replace function public.po_items_approval_guard()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare pid uuid := case when tg_op = 'DELETE' then old.po_id else new.po_id end;
begin
  if current_user in ('anon', 'authenticated')
     and exists (select 1 from public.purchase_orders where id = pid and status = 'draft' and approval_requested_at is not null) then
    raise exception 'This PO is waiting for approval and can''t be changed — withdraw it first.' using errcode = 'P0001';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists purchase_order_items_b_approval on public.purchase_order_items;
create trigger purchase_order_items_b_approval before insert or update or delete on public.purchase_order_items
  for each row execute function public.po_items_approval_guard();

-- ---- actions ---------------------------------------------------------------
create or replace function public.po_submit_for_approval(p_po uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.purchase_orders;
begin
  if not public.has_perm('pur.purchase_orders', 'edit') then
    raise exception 'You need Purchase Orders › Edit to submit a PO.' using errcode = '42501';
  end if;
  select * into p from public.purchase_orders where id = p_po for update;
  if p.id is null then raise exception 'That PO no longer exists.'; end if;
  if p.status <> 'draft' then raise exception 'Only a draft can be submitted.'; end if;
  if p.approval_requested_at is not null then raise exception 'This PO is already waiting for approval.'; end if;
  if p.supplier_id is null then raise exception 'Choose a supplier before submitting.'; end if;
  if not exists (select 1 from public.purchase_order_items where po_id = p_po) then raise exception 'Add at least one item before submitting.'; end if;
  update public.purchase_orders
     set approval_requested_at = now(), approval_requested_by = auth.uid(),
         approval_requested_name = coalesce((select name from public.profiles where id = auth.uid()), 'Purchasing'),
         returned_at = null, returned_by_name = null, returned_note = ''
   where id = p_po;
  perform public.log_activity_as(auth.uid(), 'submit', 'purchase_orders', p_po::text, coalesce(p.po_no, ''), jsonb_build_object('total', p.total));
end $$;

create or replace function public.po_withdraw_approval(p_po uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.purchase_orders;
begin
  select * into p from public.purchase_orders where id = p_po for update;
  if p.id is null or p.status <> 'draft' or p.approval_requested_at is null then raise exception 'This PO isn''t waiting for approval.'; end if;
  if not (public.is_admin() or (public.has_perm('pur.purchase_orders', 'edit') and p.approval_requested_by = auth.uid())) then
    raise exception 'Only the person who submitted it can withdraw it.' using errcode = '42501';
  end if;
  update public.purchase_orders set approval_requested_at = null, approval_requested_by = null, approval_requested_name = null where id = p_po;
end $$;

create or replace function public.po_return_for_changes(p_po uuid, p_note text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.purchase_orders;
begin
  if not public.has_perm('pur.purchase_orders', 'approve') then
    raise exception 'You need Purchase Orders › Approve to return a PO.' using errcode = '42501';
  end if;
  if coalesce(btrim(p_note), '') = '' then raise exception 'Say what needs to change.'; end if;
  select * into p from public.purchase_orders where id = p_po for update;
  if p.id is null or p.status <> 'draft' or p.approval_requested_at is null then raise exception 'This PO isn''t waiting for approval.'; end if;
  update public.purchase_orders
     set approval_requested_at = null, returned_at = now(), returned_note = left(btrim(p_note), 1000),
         returned_by_name = coalesce((select name from public.profiles where id = auth.uid()), 'Approver')
   where id = p_po;
  perform public.log_activity_as(auth.uid(), 'return', 'purchase_orders', p_po::text, coalesce(p.po_no, ''), jsonb_build_object('note', p_note));
  return p.approval_requested_by;   -- who to notify
end $$;

-- who gets the "waiting for approval" push
create or replace function public.po_approver_ids()
returns setof uuid language sql stable security definer set search_path = public, pg_temp as $$
  select distinct a.user_id from public.staff_access a
   where a.module_key = 'pur.purchase_orders' and a.level >= public.perm_rank('approve')
     and (a.expires_at is null or a.expires_at > now()) and public.staff_is_active(a.user_id)
     and public.has_perm('pur.purchase_orders', 'edit');
$$;

revoke execute on function public.po_submit_for_approval(uuid), public.po_withdraw_approval(uuid),
  public.po_return_for_changes(uuid, text), public.po_approver_ids() from public, anon;
grant execute on function public.po_submit_for_approval(uuid), public.po_withdraw_approval(uuid),
  public.po_return_for_changes(uuid, text), public.po_approver_ids() to authenticated;
revoke execute on function public.po_approval_guard(), public.po_items_approval_guard() from public, anon, authenticated;

-- ---- Inbox: "PO waiting for approval" (was every draft) + "PO returned" ----
-- Patched in place so anything else in the live inbox function is kept.
do $$
declare def text; old_part text; new_part text;
begin
  def := pg_get_functiondef('public.inbox_all_items'::regproc);
  if position('po_returned' in def) > 0 then return; end if;   -- already patched
  old_part := $x$select 'po_draft', p.id::text, coalesce(p.po_no, ''), coalesce(p.supplier_snapshot->>'name', 'Draft purchase order'), p.created_at, p.created_by
    from public.purchase_orders p where p.status = 'draft'$x$;
  new_part := $x$select 'po_draft', p.id::text, coalesce(p.po_no, ''),
         coalesce((select name from public.suppliers where id = p.supplier_id), 'Purchase order') || ' — from ' || coalesce(p.approval_requested_name, 'Purchasing'),
         p.approval_requested_at, p.created_by
    from public.purchase_orders p where p.status = 'draft' and p.approval_requested_at is not null
  union all
  select 'po_returned', p.id::text, coalesce(p.po_no, ''),
         'Returned by ' || coalesce(p.returned_by_name, 'the approver') || ' — ' || left(coalesce(p.returned_note, ''), 80),
         p.returned_at, null::uuid
    from public.purchase_orders p where p.status = 'draft' and p.approval_requested_at is null and p.returned_at is not null$x$;
  if position(old_part in def) = 0 then
    raise exception 'inbox_all_items has changed since this migration was written — send the AWES developer its current definition.';
  end if;
  execute replace(def, old_part, new_part);
end $$;

insert into public.inbox_sla (kind, label, department, module, level, warn_hours, escalate_hours, active, sort) values
  ('po_draft',    'PO waiting for approval',   'purchasing', 'pur.purchase_orders', 'approve', 24, 48, true, 12),
  ('po_returned', 'PO returned for changes',   'purchasing', 'pur.purchase_orders', 'edit',    24, 72, true, 13)
on conflict (kind) do update set label = excluded.label, level = excluded.level, warn_hours = excluded.warn_hours,
  escalate_hours = excluded.escalate_hours, module = excluded.module;

commit;

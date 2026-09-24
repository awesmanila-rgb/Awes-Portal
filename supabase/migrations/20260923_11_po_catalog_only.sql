-- ---------------------------------------------------------------------
-- Purchase Orders: catalog items only
--
-- Every PO line must be an item from the Materials Database, so prices,
-- supplier price lists, receiving into stock and the inventory reports all
-- refer to the same item. Enforced here, not just in the app:
--   * a PO line can't be saved without an active catalog item;
--   * a draft can't be issued while any line is still free text (older
--     drafts made before this rule keep their lines until you fix them);
--   * issued / cancelled POs are untouched (they're locked anyway).
-- Material Requisitions: technicians may still describe an item in their
-- own words; the admin links it to a catalog item before it goes on a PO —
-- allowed even after approval, only while the line isn't linked yet.
--
-- Depends on 20260923_03, _06 and _08. Safe to re-run.
-- ---------------------------------------------------------------------

create or replace function public.po_items_require_catalog()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare active boolean;
begin
  if new.material_id is null then
    raise exception 'Line "%": every PO item must be picked from the Materials Database (add it there first if it''s new).', new.description
      using errcode = 'P0001';
  end if;
  if tg_op = 'INSERT' or new.material_id is distinct from old.material_id then
    select is_active into active from public.materials where id = new.material_id;
    if not coalesce(active, false) then
      raise exception 'Line "%": that catalog item is inactive — reactivate it or pick another.', new.description using errcode = 'P0001';
    end if;
  end if;
  return new;
end; $$;
drop trigger if exists purchase_order_items_require_catalog on public.purchase_order_items;
create trigger purchase_order_items_require_catalog
  before insert or update of material_id, description on public.purchase_order_items
  for each row execute function public.po_items_require_catalog();

create or replace function public.po_issue_require_catalog()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare n int;
begin
  if old.status = 'draft' and new.status = 'issued' then
    select count(*) into n from public.purchase_order_items where po_id = new.id and material_id is null;
    if n > 0 then
      raise exception '% has % line(s) not linked to the Materials Database — pick each item from the catalog before issuing.', old.po_no, n
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end; $$;
drop trigger if exists purchase_orders_issue_require_catalog on public.purchase_orders;
create trigger purchase_orders_issue_require_catalog
  before update of status on public.purchase_orders
  for each row execute function public.po_issue_require_catalog();

-- requisition lines: allow linking a typed line to the catalog after approval
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
  -- Inventory posting functions (validated, security definer) may record
  -- stock fulfilment on approved lines — and nothing else.
  if current_setting('awes.inv_posting', true) = 'on' then
    if tg_op = 'UPDATE' and h.status in ('approved', 'fulfilled')
       and (to_jsonb(new) - array['fulfilled_by', 'qty_issued']) = (to_jsonb(old) - array['fulfilled_by', 'qty_issued']) then
      return new;
    end if;
    raise exception 'Inventory posting may only record fulfilment on approved requests.' using errcode = 'P0001';
  end if;
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
    -- also allowed: linking a technician's typed line to a catalog item
    -- (only while it isn't linked yet), so it can go on a Purchase Order
    if tg_op <> 'UPDATE' or (to_jsonb(new) - array['fulfilled_by', 'po_id', 'qty_issued', 'material_id', 'code']) <> (to_jsonb(old) - array['fulfilled_by', 'po_id', 'qty_issued', 'material_id', 'code'])
       or (new.material_id is distinct from old.material_id and old.material_id is not null)
       or (new.code is distinct from old.code and old.material_id is not null) then
      raise exception 'An approved request''s items are locked — only fulfilment can change.' using errcode = 'P0001';
    end if;
  elsif h.status in ('rejected', 'cancelled') then
    raise exception 'This request is closed.' using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end;
$$;

NOTIFY pgrst, 'reload schema';

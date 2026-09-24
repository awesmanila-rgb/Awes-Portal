-- ---------------------------------------------------------------------
-- Purchase Orders: item specifications on every line
--
-- A PO line used to carry only the catalog item's name, so the supplier
-- couldn't tell which size / rating / brand to deliver. Each line now has
-- its own `specs` text, printed under the description on the PDF.
--
--   * Filled automatically from the Materials Database (Brand + every
--     spec, e.g. "Brand: Mueller; Size: 3/8""; Type: Soft-drawn") when a
--     line is inserted without specs — this covers POs made from Material
--     Requisitions and from the Reorder report as well as the PO editor.
--   * Editable per PO while it's a draft (add colour, length, model no…).
--     Sending '' keeps it blank on purpose; only NULL gets auto-filled.
--   * It's a snapshot: editing the catalog later never changes a PO, and
--     issued / cancelled POs are left exactly as they were issued.
--
-- Depends on 20260923_01, _03 and _11. Safe to re-run.
-- ---------------------------------------------------------------------

alter table public.purchase_order_items add column if not exists specs text;

create or replace function public.material_spec_text(p_material uuid)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select nullif(concat_ws('; ',
           nullif('Brand: ' || nullif(trim(m.brand), ''), 'Brand: '),
           (select string_agg(e.key || ': ' || e.value, '; ')
              from jsonb_each_text(coalesce(m.specs, '{}'::jsonb)) e
             where trim(e.value) <> '')
         ), '')
    from public.materials m
   where m.id = p_material;
$$;

create or replace function public.po_items_fill_specs()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.specs is null then
    new.specs := case when new.material_id is null then ''
                      else coalesce(public.material_spec_text(new.material_id), '') end;
  end if;
  return new;
end;
$$;
drop trigger if exists purchase_order_items_fill_specs on public.purchase_order_items;
create trigger purchase_order_items_fill_specs
  before insert or update on public.purchase_order_items
  for each row execute function public.po_items_fill_specs();

-- Backfill: open DRAFTS only. Issued / cancelled POs keep what was issued.
update public.purchase_order_items i
   set specs = coalesce(public.material_spec_text(i.material_id), '')
  from public.purchase_orders p
 where p.id = i.po_id
   and p.status = 'draft'
   and i.specs is null;

NOTIFY pgrst, 'reload schema';

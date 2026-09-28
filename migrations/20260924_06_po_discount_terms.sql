-- ---------------------------------------------------------------------
-- Purchase Orders: discounts typed as percentages (and more than one)
--
-- Suppliers often quote chained trade discounts ("less 22%, less 3%").
-- The PO's Discount field now accepts percentages, peso amounts or a mix
-- ("22% + 3%", "500", "10% + 250"), kept as `discount_terms`:
--     [{"pct": 22}, {"pct": 3}]      or      [{"amt": 500}]
--
--   * Percentages are SUCCESSIVE: 22% off the subtotal, then 3% off what
--     is left (22% + 3% = 24.34% overall), each step rounded to centavos.
--     A peso amount comes off whatever is left at that point.
--   * `discount` (pesos) is still the column po_compute_totals uses. For a
--     draft that has terms, it's recomputed from the terms on every header
--     update — which also runs whenever items change (items touch their
--     parent) — so the peso discount always matches the current subtotal.
--   * Issued / cancelled POs are never touched. Older POs (terms null)
--     keep their plain peso discount exactly as before.
--
-- Depends on 20260923_03. Safe to re-run.
-- ---------------------------------------------------------------------

alter table public.purchase_orders add column if not exists discount_terms jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'purchase_orders_discount_terms_array') then
    alter table public.purchase_orders add constraint purchase_orders_discount_terms_array
      check (discount_terms is null or jsonb_typeof(discount_terms) = 'array');
  end if;
end $$;

create or replace function public.po_discount_from_terms(p_subtotal numeric, p_terms jsonb)
returns numeric
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  rem numeric := greatest(coalesce(p_subtotal, 0), 0);
  tot numeric := 0;
  e   jsonb;
  a   numeric;
begin
  if p_terms is null or jsonb_typeof(p_terms) <> 'array' then
    return 0;
  end if;
  for e in select value from jsonb_array_elements(p_terms) loop
    if jsonb_typeof(e) <> 'object' then
      a := 0;
    elsif e ? 'pct' then
      a := round(rem * least(greatest((e->>'pct')::numeric, 0), 100) / 100, 2);
    elsif e ? 'amt' then
      a := least(greatest(round((e->>'amt')::numeric, 2), 0), rem);
    else
      a := 0;
    end if;
    rem := rem - a;
    tot := tot + a;
  end loop;
  return tot;
end;
$$;

create or replace function public.po_apply_discount_terms()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.status = 'draft'
     and new.discount_terms is not null
     and jsonb_typeof(new.discount_terms) = 'array'
     and jsonb_array_length(new.discount_terms) > 0 then
    new.discount := public.po_discount_from_terms(
      (select coalesce(sum(amount), 0) from public.purchase_order_items where po_id = new.id),
      new.discount_terms);
  end if;
  return new;
end;
$$;

-- Named to fire BEFORE purchase_orders_a_guard (triggers of the same kind
-- fire in name order), so the guard computes totals with the fresh discount.
drop trigger if exists purchase_orders_a0_discount on public.purchase_orders;
create trigger purchase_orders_a0_discount
  before update on public.purchase_orders
  for each row execute function public.po_apply_discount_terms();

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- Purchase Orders: delivery vs pick-up, and flexible delivery dates
--
--   fulfilment     'delivery' — supplier delivers to deliver_to
--                  'pickup'   — we collect from the supplier (deliver_to blank)
--   delivery_when  'date' — on delivery_date (required)
--                  'asap' — As soon as possible
--                  'tba'  — To be advised
--
-- Both are NULL on POs saved before this migration (and on drafts made
-- from requisitions / the Reorder report until they're opened and saved).
-- The app reads NULL as before: delivery, and "on delivery_date" when it
-- has one, else "As soon as possible". No backfill, so issued POs — which
-- are locked — are never touched. (An older PO whose address was typed
-- as "For Pickup" now prints as Method: For pick-up.)
--
-- Depends on 20260923_03. Safe to re-run.
-- ---------------------------------------------------------------------

alter table public.purchase_orders add column if not exists fulfilment text;
alter table public.purchase_orders add column if not exists delivery_when text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'purchase_orders_fulfilment_chk') then
    alter table public.purchase_orders add constraint purchase_orders_fulfilment_chk
      check (fulfilment is null or fulfilment in ('delivery', 'pickup'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'purchase_orders_delivery_when_chk') then
    alter table public.purchase_orders add constraint purchase_orders_delivery_when_chk
      check (delivery_when is null or delivery_when in ('date', 'asap', 'tba'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'purchase_orders_delivery_date_needed_chk') then
    alter table public.purchase_orders add constraint purchase_orders_delivery_date_needed_chk
      check (delivery_when is distinct from 'date' or delivery_date is not null);
  end if;
end $$;

notify pgrst, 'reload schema';

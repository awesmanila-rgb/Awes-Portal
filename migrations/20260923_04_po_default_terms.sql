-- Sets the new default Terms & Conditions for Purchase Orders.
-- Affects NEW POs only; existing drafts keep the terms already on them,
-- and issued POs never change. Safe to re-run.
update public.po_settings
   set data = jsonb_set(data, '{terms}', to_jsonb(E'1. Please indicate the PO number on all delivery receipts and invoices.\n2. Deliver only the items and quantities listed in this Purchase Order, on or before the delivery date indicated.\n3. Failure to deliver the specified items on the date indicated shall automatically cancel this order.\n4. Acceptance of the items is subject to their delivery in good condition. AW Engineering Services reserves the right to inspect all deliveries and to reject any item that is damaged or not according to specifications; rejected items shall be returned at the supplier''s expense.\n5. Only the amount stated in this Purchase Order shall be honored. AW Engineering Services must be notified of, and must approve, any change in price before the order is accepted.\n6. Freight and delivery charges are for the supplier''s account unless otherwise stated in this Purchase Order.'::text))
 where id = 1;

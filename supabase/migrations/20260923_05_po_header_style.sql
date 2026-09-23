-- Purchase Order PDF header style: green band with the white AWES logo.
-- Affects drafts and new POs; issued POs keep the look they were issued
-- with. Can be switched in PO Settings › Header Style. Safe to re-run.
update public.po_settings
   set data = jsonb_set(data, '{header_style}', '"green"')
 where id = 1;

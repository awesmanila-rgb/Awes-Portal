-- ---------------------------------------------------------------------
-- Liquidation receipt images move OUT of the cash_advances JSONB row and
-- into Storage.
--
-- Previously every receipt was embedded in the record as a base64 data
-- URL. That made rows megabytes each, forced hard size caps (~1.5MB per
-- receipt, ~6MB per liquidation), required stripping attachments out of
-- every list query to keep it usable, and meant the whole row had to be
-- re-sent to change one line item. Receipts now live in a private bucket
-- and the row keeps only a path.
--
-- Path convention, enforced by the policies below:
--   {technician_id}/{record_id}/{timestamp}-{filename}
-- The first path segment IS the owner's uid, which is what makes
-- own-folder-only RLS expressible on storage.objects.
--
-- Depends on public.is_admin() from 20260822_01_fixes_and_hardening.sql.
-- ---------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('liquidation-receipts', 'liquidation-receipts', false)
on conflict (id) do nothing;

-- A technician may upload only into their own {uid}/ folder.
drop policy if exists liqrcpt_insert_own on storage.objects;
create policy liqrcpt_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'liquidation-receipts'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Read: own receipts, or anything if admin (admins review liquidations).
drop policy if exists liqrcpt_select_own_or_admin on storage.objects;
create policy liqrcpt_select_own_or_admin on storage.objects
  for select to authenticated
  using (
    bucket_id = 'liquidation-receipts'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );

-- Delete: own receipts (removing a line item before submitting), or admin.
drop policy if exists liqrcpt_delete_own_or_admin on storage.objects;
create policy liqrcpt_delete_own_or_admin on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'liquidation-receipts'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );

-- No update policy at all: a receipt is replaced by uploading a new object
-- and deleting the old one, never edited in place.

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- Admin can INSERT service requests.
--
-- This is the reason a dispatch ticket created directly by admin never
-- showed up in the customer's portal, and why no notification fired.
--
-- 20260910_02 gave service_requests three policies:
--   - "customers insert own service requests"  (INSERT, customer-scoped)
--   - "admin read all service requests"        (SELECT)
--   - "admin update service requests"          (UPDATE)
--
-- There is NO admin INSERT policy. The only INSERT policy requires the new
-- row's customer_id to belong to the CALLER through customer_login_links —
-- true for a customer booking their own service, never true for an admin.
-- So srCreateForAdminDispatch()'s insert (dispatch.js -> service-requests.js)
-- was refused by RLS with 42501 every single time. The customer-facing row
-- was never created, so the portal had nothing to show: no active-service
-- card, no progress tracker, no notification.
--
-- The app swallowed that error (it was best-effort and console-only), which
-- is why it looked like the dispatch-to-portal link simply didn't work.
-- v89 surfaces the error; this migration removes the cause.
--
-- Scoped to is_admin() exactly like the existing admin UPDATE policy, so
-- this grants admin nothing it cannot already do by updating a row.
-- ---------------------------------------------------------------------

drop policy if exists "admin insert service requests" on public.service_requests;
create policy "admin insert service requests"
  on public.service_requests for insert to authenticated
  with check (public.is_admin());

comment on policy "admin insert service requests" on public.service_requests is
  'Lets admin create a customer-facing service request when dispatching directly (preventive maintenance, phone-in jobs) so the customer can see and track the visit. Without it those inserts fail with 42501 and the job is invisible in the portal.';

NOTIFY pgrst, 'reload schema';

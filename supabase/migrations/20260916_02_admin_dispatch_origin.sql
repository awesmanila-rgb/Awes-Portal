-- ---------------------------------------------------------------------
-- Admin-initiated dispatch shows up on the customer's portal.
--
-- The customer home screen (renderCustomerHero in customer-portal.js) is
-- driven ENTIRELY by service_requests rows. A dispatch ticket created
-- straight from the Dispatch screen — preventive maintenance, a phone-in
-- job, anything admin schedules proactively — has no service_requests row
-- behind it, so the customer saw nothing at all: no "Active service" card,
-- no progress tracker, no technician name, and no way to message about it.
-- Only tickets converted from an existing customer request appeared.
--
-- Rather than teach the customer portal to read dispatch_tickets directly
-- (which would mean duplicating the hero, tracker, messaging and
-- completion sync against a second source), dispatch.js now creates a
-- matching service_requests row when it saves a ticket that isn't already
-- linked to one — so the whole existing customer-facing pipeline works
-- unchanged. This migration makes room for it in the origin check.
--
-- Self-sufficient on purpose: it creates the origin / flagged_issue_summary
-- columns if they are missing, because the migration that originally added
-- them (20260912_01_service_requests_origin.sql) may never have been
-- applied on a given project. Safe whether or not that one ran, and safe
-- to re-run.
-- ---------------------------------------------------------------------

-- 1. Make sure the columns exist at all (no-ops if they already do).
alter table public.service_requests
  add column if not exists origin text not null default 'customer';

alter table public.service_requests
  add column if not exists flagged_issue_summary text;

-- 2. Set the check to the full set of origins, replacing whichever
--    narrower version may already be in place.
alter table public.service_requests drop constraint if exists service_requests_origin_check;
alter table public.service_requests add constraint service_requests_origin_check
  check (origin in ('customer','technician_flag','admin_dispatch'));

comment on column public.service_requests.origin is
  'Who started this request: ''customer'' (booked it themselves via the portal request form), ''technician_flag'' (an issue noted on a completed visit — see flagged_issue_summary), or ''admin_dispatch'' (admin created a dispatch ticket directly, and this row exists so the customer can see and track it).';

NOTIFY pgrst, 'reload schema';

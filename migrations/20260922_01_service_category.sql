-- Service category for Service Reports: Aircon / Ventilation / General Scope.
--
-- Dispatch tickets need no schema change — their category lives in the
-- existing data jsonb (data->>'category'). Service reports are column-mapped
-- (see REPORT_STRING_FIELDS in core.js), so they get a real column.
--
-- Nullable on purpose: every report filed before this change has no
-- category, and admin-entered reports aren't forced through the picker.
-- Run this BEFORE deploying the new app bundle — the client now writes
-- service_category on every save, and an unknown column would make those
-- saves fail.

alter table public.service_reports
  add column if not exists service_category text;

alter table public.service_reports
  drop constraint if exists service_reports_service_category_check;

alter table public.service_reports
  add constraint service_reports_service_category_check
  check (service_category is null or service_category in ('aircon','ventilation','general'));

create index if not exists service_reports_service_category_idx
  on public.service_reports (service_category);

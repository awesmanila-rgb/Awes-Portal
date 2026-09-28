-- ---------------------------------------------------------------------
-- Web Push subscriptions — one row per DEVICE per user.
--
-- Until now every "notify" in the app was in-app only: a Supabase Realtime
-- push that updated a badge or fired a toast while the app happened to be
-- open and focused. Nothing reached anyone with the app backgrounded or
-- closed, which is exactly when a dispatched job order or a fee proposal
-- needs to reach someone.
--
-- endpoint is the natural key: the browser issues a unique endpoint URL per
-- device+origin, and re-subscribing on the same device returns the same one,
-- so upserting on it keeps a device from accumulating duplicate rows.
--
-- user_id is the AUTH user (auth.uid()) for admin and technician accounts.
-- Customers sign in through the same Supabase Auth (customer_login_links
-- maps them to a customer_id), so customer_id is stored alongside for
-- addressing "notify this customer" without a second lookup.
-- ---------------------------------------------------------------------

create table if not exists public.push_subscriptions (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  customer_id   bigint,                      -- set only for customer-portal logins
  role          text not null check (role in ('admin','tech','customer')),
  endpoint      text not null unique,
  p256dh        text not null,
  auth          text not null,
  user_agent    text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

create index if not exists push_subs_user_idx on public.push_subscriptions (user_id);
create index if not exists push_subs_role_idx on public.push_subscriptions (role);
create index if not exists push_subs_customer_idx on public.push_subscriptions (customer_id);

alter table public.push_subscriptions enable row level security;

-- A signed-in user manages only their own device rows. The Edge Function
-- that actually sends notifications runs with the service role, which
-- bypasses RLS entirely — it needs to read every recipient's rows.
drop policy if exists push_subs_insert_own on public.push_subscriptions;
create policy push_subs_insert_own on public.push_subscriptions
  for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists push_subs_update_own on public.push_subscriptions;
create policy push_subs_update_own on public.push_subscriptions
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists push_subs_select_own_or_admin on public.push_subscriptions;
create policy push_subs_select_own_or_admin on public.push_subscriptions
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- Own rows (signing out on this device), or admin cleanup.
drop policy if exists push_subs_delete_own_or_admin on public.push_subscriptions;
create policy push_subs_delete_own_or_admin on public.push_subscriptions
  for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());

comment on table public.push_subscriptions is
  'Web Push endpoints, one row per device per user. Written by the client on permission grant (pushSubscribe in push.js); read by the send-push Edge Function under the service role. A 404/410 from the push service means the endpoint is dead and the function deletes that row.';

NOTIFY pgrst, 'reload schema';

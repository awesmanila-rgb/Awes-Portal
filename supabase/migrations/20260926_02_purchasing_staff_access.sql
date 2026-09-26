-- =====================================================================
-- AWES App — Open PURCHASING to department staff (Round 1, Phase 3a)
--
-- Pages opened: Materials Database (pur.materials), Supplier Database
-- (pur.suppliers), Material Requisition (pur.requisitions), Purchase
-- Orders (pur.purchase_orders). Inventory pages are a separate step.
--
-- Every rule that said is_admin() now says has_perm(<page>, <level>).
-- has_perm() is true for the Super Admin, so nothing changes for the
-- admin account, technicians or customers.
--
--   View     read the page's data
--   Edit     create / change / delete (drafts), link lines, fulfil
--   Approve  decide a requisition (approve / return / reject),
--            issue a PO, cancel an issued PO
--
-- Approvals by staff (Super Admin exempt) go through
-- staff_approval_assert(): Approve level, not their own record, within
-- their peso limit (POs: the PO total), password re-entered within 5 min.
--
-- Issuing a PO as staff always prints THEIR OWN signatory (linked in PO
-- Settings → Signatories → Staff login), so the approver on paper is the
-- person who actually approved it. Staff not linked to a signatory can't
-- issue — the error tells them why.
--
-- Deliberately still Super Admin only: PO Settings (company details,
-- logo, terms) and the Signatories list.
--
-- Requires 20260926_01_departments_access.sql. Idempotent.
-- =====================================================================

begin;

do $$ begin
  if to_regprocedure('public.has_perm(text,text)') is null then
    raise exception 'Run 20260926_01_departments_access.sql first.';
  end if;
  if to_regclass('public.purchase_orders') is null or to_regclass('public.material_requisitions') is null then
    raise exception 'Run the purchasing migrations (20260923_01 … 20260925_02) first.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. Approval gate with readable messages
-- ---------------------------------------------------------------------
-- The 'reauth_required' HINT is what the app looks for to ask for the
-- password and retry.
-- Round 2 (20260927_01) installs a newer staff_approval_assert() (delegation-aware); re-running
-- this migration after it must not put this older version back.
do $guard$ begin
  if to_regclass('public.staff_delegations') is null then
    execute $ddl$
create or replace function public.staff_approval_assert(p_module text, p_amount numeric, p_creator uuid)
returns void
language plpgsql stable security definer
set search_path = public, pg_temp
as $body$
declare
  r text := public.staff_approval_check(p_module, p_amount, p_creator, true);
  lab text := coalesce((select label from public.app_modules where key = p_module), p_module);
  lim numeric;
begin
  if r = 'ok' then return; end if;
  if r = 'own_record' then
    raise exception 'You can''t approve your own % — another approver has to.', regexp_replace(lower(lab), 's$', '') using errcode = '42501';
  elsif r = 'over_limit' then
    select approve_limit into lim from public.staff_access where user_id = auth.uid() and module_key = p_module;
    raise exception 'This is above your approval limit of ₱% — someone with a higher limit has to approve it.',
      to_char(lim, 'FM999,999,999,990.00') using errcode = '42501';
  elsif r = 'reauth_required' then
    raise exception 'Enter your password to confirm this approval.' using errcode = '42501', hint = 'reauth_required';
  else
    raise exception 'You don''t have Approve access for %.', lab using errcode = '42501';
  end if;
end;
$body$;
    $ddl$;
  end if;
end $guard$;
revoke execute on function public.staff_approval_assert(text, numeric, uuid) from public, anon;
grant execute on function public.staff_approval_assert(text, numeric, uuid) to authenticated, service_role;


-- ---------------------------------------------------------------------
-- 2. Guard functions: is_admin() → page permissions
--    (bodies are the current live versions with only those lines changed)
-- ---------------------------------------------------------------------
create or replace function public.mr_before_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  y int := extract(year from (now() at time zone 'Asia/Manila'))::int;
  n int;
begin
  if not public.has_perm('pur.requisitions', 'edit') then
    new.requested_by := auth.uid();                -- a tech can only request for themselves
    if new.status not in ('draft', 'submitted') then new.status := 'draft'; end if;
    new.review_note := ''; new.reviewed_by := null; new.reviewer_name := '';
    new.reviewed_at := null; new.fulfilled_at := null; new.cancelled_at := null;
  elsif new.status not in ('draft', 'submitted') then
    new.status := 'draft';
  end if;
  insert into public.mrf_counters as c (year, last_no) values (y, 1)
    on conflict (year) do update set last_no = c.last_no + 1
    returning last_no into n;
  new.mrf_no := 'MRF-' || y || '-' || lpad(n::text, 4, '0');
  new.requester_name := coalesce((select name from public.profiles where id = new.requested_by), '');
  if new.status = 'submitted' then new.submitted_at := now(); end if;
  return new;
end;
$function$;

create or replace function public.mr_before_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  admin boolean := public.has_perm('pur.requisitions', 'edit');
  locked text[] := array['approved', 'rejected', 'cancelled', 'fulfilled'];
  sys text[] := array['status', 'updated_at', 'fulfilled_at', 'cancelled_at'];
begin
  if current_setting('awes.inv_posting', true) = 'on' then
    if old.status in ('approved', 'fulfilled') and new.status in ('approved', 'fulfilled')
       and (to_jsonb(new) - sys) = (to_jsonb(old) - sys) then
      if new.status = 'fulfilled' and old.status <> 'fulfilled' then new.fulfilled_at := now(); end if;
      if new.status = 'approved' then new.fulfilled_at := null; end if;
      return new;
    end if;
    raise exception 'Inventory posting may only update fulfilment status.' using errcode = 'P0001';
  end if;
  new.mrf_no := old.mrf_no;
  new.requested_by := old.requested_by;
  new.requester_name := old.requester_name;
  new.created_at := old.created_at;

  if not admin then
    if old.requested_by <> auth.uid() then
      raise exception 'Not your request.' using errcode = '42501';
    end if;
    -- review fields are never the technician's to set
    new.review_note := old.review_note; new.reviewed_by := old.reviewed_by;
    new.reviewer_name := old.reviewer_name; new.reviewed_at := old.reviewed_at;
    new.fulfilled_at := old.fulfilled_at;
    if new.status = 'cancelled' and old.status in ('draft', 'submitted', 'returned') then
      new.cancelled_at := now();
      return new;
    end if;
    if old.status not in ('draft', 'returned') then
      raise exception 'This request is % and can no longer be changed.', old.status using errcode = 'P0001';
    end if;
    if new.status not in ('draft', 'returned', 'submitted') then
      raise exception 'Only an admin can mark a request as %.', new.status using errcode = 'P0001';
    end if;
    if new.status = 'submitted' then
      if not exists (select 1 from public.material_requisition_items where mr_id = new.id) then
        raise exception 'Add at least one item before submitting.' using errcode = 'P0001';
      end if;
      new.submitted_at := now();
    elsif new.status = 'returned' and old.status = 'draft' then
      new.status := 'draft';
    end if;
    return new;
  end if;

  -- ---- admin ----
  if old.status = any(locked) then
    -- only fulfilment bookkeeping moves on after approval
    if old.status in ('approved', 'fulfilled') and new.status in ('approved', 'fulfilled', 'cancelled')
       and (to_jsonb(new) - sys) = (to_jsonb(old) - sys) then
      if new.status = 'cancelled' and old.status <> 'cancelled' then new.cancelled_at := now(); end if;
      if new.status = 'fulfilled' and old.status <> 'fulfilled' then new.fulfilled_at := now(); end if;
      if new.status = 'approved' then new.fulfilled_at := null; end if;
      return new;
    end if;
    raise exception 'Request % is % and locked.', old.mrf_no, old.status using errcode = 'P0001';
  end if;

  if new.status is distinct from old.status then
    if new.status in ('approved', 'rejected', 'returned') then
      if old.status <> 'submitted' then
        raise exception 'Only a submitted request can be %.', new.status using errcode = 'P0001';
      end if;
      -- Deciding a request is an approval: Approve level, not your own
      -- request, password re-entered (Super Admin exempt).
      perform public.staff_approval_assert('pur.requisitions', null, old.requested_by);
      if new.status in ('rejected', 'returned') and coalesce(trim(new.review_note), '') = '' then
        raise exception 'Give the technician a reason.' using errcode = 'P0001';
      end if;
      new.reviewed_by := auth.uid();
      new.reviewer_name := coalesce((select nullif(name, '') from public.profiles where id = auth.uid() and role <> 'admin'), 'Admin');
      new.reviewed_at := now();
      if new.status = 'approved' then
        -- anything the admin didn't adjust is approved as requested
        update public.material_requisition_items set qty_approved = qty_requested
         where mr_id = new.id and qty_approved is null;
      end if;
    elsif new.status = 'cancelled' then
      new.cancelled_at := now();
    elsif new.status = 'submitted' and old.status in ('draft', 'returned') then
      new.submitted_at := now();
    elsif new.status = 'fulfilled' then
      raise exception 'A request becomes fulfilled when all its lines are covered.' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$function$;

create or replace function public.mr_before_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if old.status <> 'draft' then
    raise exception 'Only drafts can be deleted — cancel it instead.' using errcode = 'P0001';
  end if;
  if not public.has_perm('pur.requisitions', 'edit') and old.requested_by <> auth.uid() then
    raise exception 'Not your request.' using errcode = '42501';
  end if;
  return old;
end;
$function$;

create or replace function public.mr_items_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  admin boolean := public.has_perm('pur.requisitions', 'edit');
  h record;
begin
  select status, requested_by into h from public.material_requisitions where id = coalesce(new.mr_id, old.mr_id);
  if h is null then return coalesce(new, old); end if;        -- parent draft being deleted (cascade)
  -- Inventory posting functions (validated, security definer) may record
  -- stock fulfilment on approved lines — and nothing else.
  if current_setting('awes.inv_posting', true) = 'on' then
    if tg_op = 'UPDATE' and h.status in ('approved', 'fulfilled')
       and (to_jsonb(new) - array['fulfilled_by', 'qty_issued']) = (to_jsonb(old) - array['fulfilled_by', 'qty_issued']) then
      return new;
    end if;
    raise exception 'Inventory posting may only record fulfilment on approved requests.' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and new.mr_id <> old.mr_id then
    raise exception 'Items can''t be moved to another request.' using errcode = 'P0001';
  end if;

  if not admin then
    if h.requested_by <> auth.uid() then raise exception 'Not your request.' using errcode = '42501'; end if;
    if h.status not in ('draft', 'returned') then
      raise exception 'Items can only be changed while the request is a draft or returned.' using errcode = 'P0001';
    end if;
    if tg_op <> 'DELETE' then
      new.qty_approved := case when tg_op = 'UPDATE' then old.qty_approved else null end;
      new.fulfilled_by := case when tg_op = 'UPDATE' then old.fulfilled_by else null end;
      new.po_id        := case when tg_op = 'UPDATE' then old.po_id else null end;
    end if;
    return coalesce(new, old);
  end if;

  -- admin: edit lines freely until approval; after approval only fulfilment
  if h.status in ('approved', 'fulfilled') then
    -- also allowed: linking a technician's typed line to a catalog item
    -- (only while it isn't linked yet), so it can go on a Purchase Order
    if tg_op <> 'UPDATE' or (to_jsonb(new) - array['fulfilled_by', 'po_id', 'qty_issued', 'material_id', 'code']) <> (to_jsonb(old) - array['fulfilled_by', 'po_id', 'qty_issued', 'material_id', 'code'])
       or (new.material_id is distinct from old.material_id and old.material_id is not null)
       or (new.code is distinct from old.code and old.material_id is not null) then
      raise exception 'An approved request''s items are locked — only fulfilment can change.' using errcode = 'P0001';
    end if;
  elsif h.status in ('rejected', 'cancelled') then
    raise exception 'This request is closed.' using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end;
$function$;

create or replace function public.mr_check_job_order()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  d jsonb;
begin
  if new.job_order_id is null or new.job_order_id = '' then
    new.job_order_id := null; new.job_order := null;
    return new;
  end if;
  if tg_op = 'UPDATE' and new.job_order_id is not distinct from old.job_order_id and new.job_order is not null then
    return new;
  end if;
  select data into d from public.dispatch_tickets where id = new.job_order_id;
  if d is null then
    raise exception 'Job order % was not found.', new.job_order_id using errcode = 'P0001';
  end if;
  if not public.has_perm('pur.requisitions', 'edit')
     and not coalesce((d -> 'assignedWorkerIds') @> to_jsonb(auth.uid()::text), false) then
    raise exception 'You can only request materials for a job order assigned to you.' using errcode = 'P0001';
  end if;
  new.job_order := jsonb_build_object(
    'id', new.job_order_id, 'custName', coalesce(d ->> 'custName', ''),
    'siteAddress', coalesce(d ->> 'siteAddress', ''), 'category', coalesce(d ->> 'category', ''));
  return new;
end;
$function$;

create or replace function public.rename_material_category(p_id uuid, p_name text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  old_name text;
  new_name text := trim(coalesce(p_name, ''));
begin
  if not public.has_perm('pur.materials', 'edit') then
    raise exception 'Only admins can rename categories.' using errcode = '42501';
  end if;
  if new_name = '' then
    raise exception 'Enter a category name.' using errcode = 'P0001';
  end if;
  select name into old_name from public.material_categories where id = p_id for update;
  if old_name is null then
    raise exception 'That category no longer exists.' using errcode = 'P0001';
  end if;
  if old_name = new_name then return; end if;
  if exists (select 1 from public.material_categories where lower(name) = lower(new_name) and id <> p_id) then
    raise exception 'There is already a category called "%".', new_name using errcode = 'P0001';
  end if;

  perform set_config('awes.cat_rename', 'on', true);
  update public.material_categories set name = new_name where id = p_id;
  perform set_config('awes.cat_rename', 'off', true);

  update public.materials set category = new_name where category = old_name;
  update public.suppliers set supplies = array_replace(supplies, old_name, new_name)
   where old_name = any(supplies);
end;
$function$;

create or replace function public.po_assign_number()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  y int;
  n int;
begin
  if new.po_no is null or new.po_no = '' then
    y := extract(year from coalesce(new.po_date, (now() at time zone 'Asia/Manila')::date))::int;
    insert into public.purchase_order_counters as c (year, last_no) values (y, 1)
      on conflict (year) do update set last_no = c.last_no + 1
      returning last_no into n;
    new.po_no := 'PO-' || y || '-' || lpad(n::text, 4, '0');
  end if;
  new.status := 'draft';               -- every PO starts as a draft
  -- who drafted it — the approval check uses this (no approving your own PO)
  if auth.uid() is not null then new.created_by := auth.uid(); end if;
  -- a staff member linked to a signatory is the preparer unless one was chosen
  if new.prepared_by_id is null and not public.is_admin() then
    new.prepared_by_id := (select id from public.po_signatories where user_id = auth.uid() and is_active limit 1);
  end if;
  return new;
end;
$function$;

create or replace function public.po_before_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  t record;
  pc record;
  allowed text[] := array['status', 'cancelled_at', 'cancel_reason', 'updated_at'];
begin
  if old.status = 'cancelled' then
    raise exception 'PO % is cancelled and can no longer be changed.', old.po_no using errcode = 'P0001';
  end if;

  if old.status = 'issued' then
    if new.status = 'cancelled'
       and (to_jsonb(new) - allowed) = (to_jsonb(old) - allowed) then
      -- cancelling an issued PO needs the Approve level (Super Admin exempt)
      perform public.staff_approval_assert('pur.purchase_orders', null, null);
      if coalesce(trim(new.cancel_reason), '') = '' then
        raise exception 'A reason is required to cancel an issued PO.' using errcode = 'P0001';
      end if;
      new.cancelled_at := now();
      return new;
    end if;
    raise exception 'PO % is already issued and locked. It can only be cancelled.', old.po_no using errcode = 'P0001';
  end if;

  -- old.status = 'draft'
  new.po_no := old.po_no;              -- the number never changes
  if new.status = 'cancelled' then
    raise exception 'Drafts are deleted, not cancelled.' using errcode = 'P0001';
  end if;

  select * into t from public.po_compute_totals(new.id, new.vat_mode, new.discount, new.ewt_rate);
  new.subtotal := t.o_subtotal; new.vat_amount := t.o_vat; new.total := t.o_total;
  new.ewt_amount := t.o_ewt; new.net_payable := t.o_net;

  if new.status = 'issued' then
    if new.supplier_id is null then
      raise exception 'Choose a supplier before issuing.' using errcode = 'P0001';
    end if;
    if not exists (select 1 from public.purchase_order_items where po_id = new.id) then
      raise exception 'Add at least one item before issuing.' using errcode = 'P0001';
    end if;
    -- Issuing is the approval. Staff: Approve level, within their peso
    -- limit, not a PO they drafted, password re-entered — and the approver
    -- printed on the PO is always the person who actually issued it.
    if not public.is_admin() then
      perform public.staff_approval_assert('pur.purchase_orders', new.total, old.created_by);
      new.approved_by_id := (select id from public.po_signatories where user_id = auth.uid() and is_active limit 1);
      if new.approved_by_id is null then
        raise exception 'Your account isn''t linked to a PO signatory, so your signature can''t be printed. Ask the admin to link you in PO Settings → Signatories.' using errcode = 'P0001';
      end if;
    end if;
    if new.approved_by_id is null then
      raise exception 'Choose who approves this PO before issuing.' using errcode = 'P0001';
    end if;

    select s.*, c.name as c_name, c.position as c_position, c.mobile as c_mobile, c.email as c_email
      into pc
      from public.suppliers s
      left join lateral (
        select * from public.supplier_contacts sc
        where sc.supplier_id = s.id order by sc.is_primary desc, sc.created_at limit 1
      ) c on true
      where s.id = new.supplier_id;
    new.supplier_snapshot := jsonb_build_object(
      'code', pc.code, 'name', pc.name, 'trade_name', pc.trade_name,
      'address', pc.address, 'city', pc.city, 'tin', pc.tin,
      'vat_registered', pc.vat_registered, 'payment_terms', pc.payment_terms,
      'contact_name', coalesce(pc.c_name, ''), 'contact_position', coalesce(pc.c_position, ''),
      'contact_mobile', coalesce(pc.c_mobile, ''), 'contact_email', coalesce(pc.c_email, ''));
    new.prepared_snapshot := (select jsonb_build_object('name', name, 'position', position, 'signature_path', signature_path)
                              from public.po_signatories where id = new.prepared_by_id);
    new.approved_snapshot := (select jsonb_build_object('name', name, 'position', position, 'signature_path', signature_path)
                              from public.po_signatories where id = new.approved_by_id);
    new.company_snapshot  := (select data from public.po_settings where id = 1);
    new.issued_at := now();
  end if;
  return new;
end;
$function$;


-- ---------------------------------------------------------------------
-- 3. Row-level security
-- ---------------------------------------------------------------------
-- Suppliers (+ contacts, documents, price lists). PO staff also read
-- them: the PO editor picks a supplier and its prices.
drop policy if exists suppliers_admin_all on public.suppliers;
drop policy if exists suppliers_staff_read on public.suppliers;
drop policy if exists suppliers_staff_insert on public.suppliers;
drop policy if exists suppliers_staff_update on public.suppliers;
drop policy if exists suppliers_staff_delete on public.suppliers;
create policy suppliers_staff_read   on public.suppliers for select to authenticated using ((select public.has_perm('pur.suppliers', 'view')) or (select public.has_perm('pur.purchase_orders', 'view')));
create policy suppliers_staff_insert on public.suppliers for insert to authenticated with check ((select public.has_perm('pur.suppliers', 'edit')));
create policy suppliers_staff_update on public.suppliers for update to authenticated using ((select public.has_perm('pur.suppliers', 'edit'))) with check ((select public.has_perm('pur.suppliers', 'edit')));
create policy suppliers_staff_delete on public.suppliers for delete to authenticated using ((select public.has_perm('pur.suppliers', 'edit')));

do $$
declare t text;
begin
  foreach t in array array['supplier_contacts', 'supplier_documents'] loop
    execute format('drop policy if exists %1$s_admin_all on public.%1$I', t);
    execute format('drop policy if exists %1$s_staff_read on public.%1$I', t);
    execute format('drop policy if exists %1$s_staff_write on public.%1$I', t);
    execute format('create policy %1$s_staff_read on public.%1$I for select to authenticated using (%2$s)', t,
                   $x$(select public.has_perm('pur.suppliers', 'view')) or (select public.has_perm('pur.purchase_orders', 'view'))$x$);
    execute format('create policy %1$s_staff_write on public.%1$I for all to authenticated using (%2$s) with check (%2$s)', t,
                   $x$(select public.has_perm('pur.suppliers', 'edit'))$x$);
  end loop;
end $$;

-- Price lists are edited from both the Supplier and the Materials screens.
drop policy if exists supplier_materials_admin_all on public.supplier_materials;
drop policy if exists supplier_materials_staff_read on public.supplier_materials;
drop policy if exists supplier_materials_staff_write on public.supplier_materials;
create policy supplier_materials_staff_read on public.supplier_materials for select to authenticated
  using ((select public.has_perm('pur.suppliers', 'view')) or (select public.has_perm('pur.materials', 'view')) or (select public.has_perm('pur.purchase_orders', 'view')));
create policy supplier_materials_staff_write on public.supplier_materials for all to authenticated
  using ((select public.has_perm('pur.suppliers', 'edit')) or (select public.has_perm('pur.materials', 'edit'))) with check ((select public.has_perm('pur.suppliers', 'edit')) or (select public.has_perm('pur.materials', 'edit')));

drop policy if exists supplier_price_history_admin_read on public.supplier_price_history;
drop policy if exists supplier_price_history_staff_read on public.supplier_price_history;
create policy supplier_price_history_staff_read on public.supplier_price_history for select to authenticated
  using ((select public.has_perm('pur.suppliers', 'view')) or (select public.has_perm('pur.materials', 'view')) or (select public.has_perm('pur.purchase_orders', 'view')));

-- Materials: everyone still reads ACTIVE items (technicians pick from them);
-- purchasing staff also see inactive ones.
drop policy if exists materials_read on public.materials;
drop policy if exists materials_admin_write on public.materials;
drop policy if exists materials_staff_write on public.materials;
create policy materials_read on public.materials for select to authenticated
  using (is_active or (select public.has_perm('pur.materials', 'view')) or (select public.has_perm('pur.purchase_orders', 'view')) or (select public.has_perm('pur.requisitions', 'view')));
create policy materials_staff_write on public.materials for all to authenticated using ((select public.has_perm('pur.materials', 'edit'))) with check ((select public.has_perm('pur.materials', 'edit')));

drop policy if exists material_categories_admin_all on public.material_categories;
drop policy if exists material_categories_staff_write on public.material_categories;
create policy material_categories_staff_write on public.material_categories for all to authenticated
  using ((select public.has_perm('pur.materials', 'edit'))) with check ((select public.has_perm('pur.materials', 'edit')));

-- Purchase orders
do $$
declare t text;
begin
  foreach t in array array['purchase_orders', 'purchase_order_items'] loop
    execute format('drop policy if exists %1$s_admin_all on public.%1$I', t);
    execute format('drop policy if exists %1$s_staff_read on public.%1$I', t);
    execute format('drop policy if exists %1$s_staff_write on public.%1$I', t);
    execute format('create policy %1$s_staff_read on public.%1$I for select to authenticated using (%2$s)', t, $x$(select public.has_perm('pur.purchase_orders', 'view'))$x$);
    execute format('create policy %1$s_staff_write on public.%1$I for all to authenticated using (%2$s) with check (%2$s)', t, $x$(select public.has_perm('pur.purchase_orders', 'edit'))$x$);
  end loop;
end $$;

-- PO settings & signatories: PO staff read them (the PDF needs them);
-- only the Super Admin changes them.
do $$
declare t text;
begin
  foreach t in array array['po_settings', 'po_signatories'] loop
    execute format('drop policy if exists %1$s_admin_all on public.%1$I', t);
    execute format('drop policy if exists %1$s_staff_read on public.%1$I', t);
    execute format('drop policy if exists %1$s_admin_write on public.%1$I', t);
    execute format('create policy %1$s_staff_read on public.%1$I for select to authenticated using (%2$s)', t, $x$(select public.has_perm('pur.purchase_orders', 'view'))$x$);
    execute format('create policy %1$s_admin_write on public.%1$I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;

-- Material requisitions: technicians keep their own-request access.
drop policy if exists mr_select on public.material_requisitions;
drop policy if exists mr_insert on public.material_requisitions;
drop policy if exists mr_update on public.material_requisitions;
drop policy if exists mr_delete on public.material_requisitions;
create policy mr_select on public.material_requisitions for select to authenticated using ((select public.has_perm('pur.requisitions', 'view')) or requested_by = auth.uid());
create policy mr_insert on public.material_requisitions for insert to authenticated with check ((select public.has_perm('pur.requisitions', 'edit')) or requested_by = auth.uid());
create policy mr_update on public.material_requisitions for update to authenticated
  using ((select public.has_perm('pur.requisitions', 'edit')) or requested_by = auth.uid()) with check ((select public.has_perm('pur.requisitions', 'edit')) or requested_by = auth.uid());
create policy mr_delete on public.material_requisitions for delete to authenticated using ((select public.has_perm('pur.requisitions', 'edit')) or requested_by = auth.uid());

drop policy if exists mr_items_all on public.material_requisition_items;
drop policy if exists mr_items_read on public.material_requisition_items;
drop policy if exists mr_items_write on public.material_requisition_items;
create policy mr_items_read on public.material_requisition_items for select to authenticated
  using ((select public.has_perm('pur.requisitions', 'view')) or exists (select 1 from public.material_requisitions m where m.id = mr_id and m.requested_by = auth.uid()));
create policy mr_items_write on public.material_requisition_items for all to authenticated
  using ((select public.has_perm('pur.requisitions', 'edit')) or exists (select 1 from public.material_requisitions m where m.id = mr_id and m.requested_by = auth.uid()))
  with check ((select public.has_perm('pur.requisitions', 'edit')) or exists (select 1 from public.material_requisitions m where m.id = mr_id and m.requested_by = auth.uid()));


-- ---------------------------------------------------------------------
-- 4. Storage
-- ---------------------------------------------------------------------
do $$ begin
  if to_regclass('storage.objects') is not null then
    drop policy if exists purch_assets_admin_select on storage.objects;
    drop policy if exists purch_assets_staff_select on storage.objects;
    create policy purch_assets_staff_select on storage.objects for select to authenticated
      using (bucket_id = 'purchasing-assets' and (select public.has_perm('pur.purchase_orders', 'view')));
    -- (upload stays Super Admin only: logo + signatures, purch_assets_admin_insert)

    drop policy if exists supdoc_admin_select on storage.objects;
    drop policy if exists supdoc_admin_insert on storage.objects;
    drop policy if exists supdoc_admin_delete on storage.objects;
    drop policy if exists supdoc_staff_select on storage.objects;
    drop policy if exists supdoc_staff_insert on storage.objects;
    drop policy if exists supdoc_staff_delete on storage.objects;
    create policy supdoc_staff_select on storage.objects for select to authenticated
      using (bucket_id = 'supplier-documents' and ((select public.has_perm('pur.suppliers', 'view')) or (select public.has_perm('pur.purchase_orders', 'view'))));
    create policy supdoc_staff_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'supplier-documents' and (select public.has_perm('pur.suppliers', 'edit')));
    create policy supdoc_staff_delete on storage.objects for delete to authenticated
      using (bucket_id = 'supplier-documents' and (select public.has_perm('pur.suppliers', 'edit')));
  end if;
end $$;

commit;

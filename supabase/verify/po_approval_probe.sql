-- Probe for 20261010_01_po_approval.sql — Purchasing prepares and submits,
-- the Accounting head approves & issues or returns it; alerts via Inbox.
-- One transaction, rolled back.   psql -d awes_backup -f po_approval_probe.sql
\set ON_ERROR_STOP 1
begin;
create function pg_temp.ok(c boolean, n text) returns void language plpgsql as $$ begin if c then raise notice 'PASS  %', n; else raise exception 'FAIL  %', n; end if; end $$;
create function pg_temp.as_user(p uuid) returns void language plpgsql as $$ begin
  perform set_config('request.jwt.claim.sub', coalesce(p::text, ''), true);
  perform set_config('request.jwt.claim.role', case when p is null then 'service_role' else 'authenticated' end, true); end $$;
create function pg_temp.run(p uuid, q text) returns text language plpgsql as $$ begin
  perform pg_temp.as_user(p); set local role authenticated;
  begin execute q; exception when others then reset role; return 'ERR: ' || sqlerrm; end; reset role; return 'ok'; end $$;
create function pg_temp.inbox(p uuid, k text) returns bigint language plpgsql as $$ declare n bigint; begin
  perform pg_temp.as_user(p); select count(*) into n from jsonb_array_elements(public.inbox_items()) x
   where x->>'kind' = k and x->>'ref_id' = '40000000-0000-0000-0000-0000000000d1'; return n; end $$;

\set A  '''00000000-0000-0000-0000-0000000000a1'''
\set PO '''40000000-0000-0000-0000-00000000000a'''
\set AH '''40000000-0000-0000-0000-00000000000b'''
\set P  '''40000000-0000-0000-0000-0000000000d1'''
insert into auth.users (id, email) values (:PO, 'po@x'), (:AH, 'ah@x');
insert into public.profiles (id, name, role, username) values (:PO, 'Francesca Purchasing', 'staff', 'pa_po'), (:AH, 'Arnel Accounting Head', 'staff', 'pa_ah');
select pg_temp.as_user(null);
select public.staff_apply_access(:PO::uuid, '[{"id":"purchasing"}]',
  '[{"module":"pur.suppliers","level":"view"},{"module":"pur.materials","level":"view"},{"module":"pur.purchase_orders","level":"edit"}]', :A::uuid);
select public.staff_apply_access(:AH::uuid, '[{"id":"finance","is_head":true}]',
  '[{"module":"pur.purchase_orders","level":"approve","approve_limit":200000}]', :A::uuid);
insert into public.suppliers (id, name) values ('40000000-0000-0000-0000-000000000001', 'Probe Aircon Supply');
insert into public.materials (id, code, name, category, unit, is_active) values ('40000000-0000-0000-0000-0000000000a1', 'PA-0001', 'Probe capacitor', 'Electrical', 'pc', true);
insert into public.po_signatories (id, name, position, user_id) values
  ('40000000-0000-0000-0000-0000000000c1', 'Francesca Purchasing', 'Purchasing Officer', :PO),
  ('40000000-0000-0000-0000-0000000000c2', 'Arnel Accounting Head', 'Accounting Head', :AH);

-- Purchasing prepares
select pg_temp.ok(pg_temp.run(:PO, $q$insert into public.purchase_orders (id, supplier_id) values ('40000000-0000-0000-0000-0000000000d1', '40000000-0000-0000-0000-000000000001')$q$) = 'ok'
  and pg_temp.run(:PO, $q$insert into public.purchase_order_items (po_id, description, qty, unit_price, material_id, code)
      values ('40000000-0000-0000-0000-0000000000d1', 'Probe capacitor', 4, 850, '40000000-0000-0000-0000-0000000000a1', 'PA-0001')$q$) = 'ok', 'Purchasing prepares a draft');
select public.staff_record_reauth(:AH::uuid);
select pg_temp.ok(pg_temp.run(:AH, $q$update public.purchase_orders set status = 'issued' where id = '40000000-0000-0000-0000-0000000000d1'$q$) like 'ERR: Submit this PO%', 'nobody issues a draft that wasn''t submitted');
select pg_temp.run(:PO, $q$update public.purchase_orders set approval_requested_at = now() where id = '40000000-0000-0000-0000-0000000000d1'$q$);
select pg_temp.ok((select approval_requested_at is null from public.purchase_orders where id = :P), 'the approval columns can''t be set directly');
select pg_temp.ok(pg_temp.inbox(:AH, 'po_draft') = 0, 'an unsubmitted draft isn''t in the approver''s Inbox');

-- submit
select pg_temp.ok(pg_temp.run(:PO, $q$select public.po_submit_for_approval('40000000-0000-0000-0000-0000000000d1')$q$) = 'ok', 'Purchasing submits it for approval');
select pg_temp.ok((select approval_requested_name = 'Francesca Purchasing' from public.purchase_orders where id = :P), 'it records who submitted it');
select pg_temp.ok(pg_temp.inbox(:AH, 'po_draft') = 1, 'it''s in the Accounting head''s Inbox');
select pg_temp.ok(pg_temp.inbox(:PO, 'po_draft') = 0, '… not the preparer''s');
select pg_temp.as_user(:AH);
select pg_temp.ok(exists (select 1 from public.po_approver_ids() i where i = :AH::uuid), 'the Accounting head is on the push list');
select pg_temp.ok(pg_temp.run(:PO, $q$update public.purchase_orders set notes = 'changed' where id = '40000000-0000-0000-0000-0000000000d1'$q$) like 'ERR:%waiting for approval%', 'a submitted PO is locked');
select pg_temp.ok(pg_temp.run(:PO, $q$update public.purchase_order_items set qty = 40 where po_id = '40000000-0000-0000-0000-0000000000d1'$q$) like 'ERR:%waiting for approval%', '… items too');

-- return
select pg_temp.ok(pg_temp.run(:PO, $q$select public.po_return_for_changes('40000000-0000-0000-0000-0000000000d1', 'x')$q$) like 'ERR: You need%', 'Purchasing can''t return it themselves');
select pg_temp.ok(pg_temp.run(:AH, $q$select public.po_return_for_changes('40000000-0000-0000-0000-0000000000d1', '  ')$q$) like 'ERR: Say what%', 'returning needs a note');
select pg_temp.ok(pg_temp.run(:AH, $q$select public.po_return_for_changes('40000000-0000-0000-0000-0000000000d1', 'Quote from a second supplier')$q$) = 'ok', 'the Accounting head returns it');
select pg_temp.ok((select approval_requested_at is null and returned_note = 'Quote from a second supplier' and returned_by_name = 'Arnel Accounting Head' from public.purchase_orders where id = :P), 'returned, with the note');
select pg_temp.ok(pg_temp.inbox(:PO, 'po_returned') = 1 and pg_temp.inbox(:AH, 'po_draft') = 0, 'Purchasing is alerted; it leaves the approver''s Inbox');
select pg_temp.ok(pg_temp.run(:PO, $q$update public.purchase_order_items set qty = 3 where po_id = '40000000-0000-0000-0000-0000000000d1'$q$) = 'ok', 'Purchasing can edit it again');

-- resubmit, withdraw, resubmit
select pg_temp.run(:PO, $q$select public.po_submit_for_approval('40000000-0000-0000-0000-0000000000d1')$q$);
select pg_temp.ok((select approval_requested_at is not null and returned_at is null from public.purchase_orders where id = :P), 'resubmitting clears the return note');
select pg_temp.ok(pg_temp.run(:AH, $q$select public.po_withdraw_approval('40000000-0000-0000-0000-0000000000d1')$q$) like 'ERR: Only the person%', 'only the submitter withdraws');
select pg_temp.ok(pg_temp.run(:PO, $q$select public.po_withdraw_approval('40000000-0000-0000-0000-0000000000d1')$q$) = 'ok', 'Purchasing withdraws it');
select pg_temp.ok((select approval_requested_at is null from public.purchase_orders where id = :P), '… and it''s a normal draft again');
select pg_temp.run(:PO, $q$select public.po_submit_for_approval('40000000-0000-0000-0000-0000000000d1')$q$);

-- approve & issue
select pg_temp.ok(pg_temp.run(:PO, $q$update public.purchase_orders set status = 'issued' where id = '40000000-0000-0000-0000-0000000000d1'$q$) like 'ERR:%Approve%', 'Purchasing can''t issue it');
select pg_temp.ok(pg_temp.run(:AH, $q$update public.purchase_orders set status = 'issued' where id = '40000000-0000-0000-0000-0000000000d1'$q$) = 'ok', 'the Accounting head approves & issues it');
select pg_temp.ok((select status = 'issued' and approved_snapshot->>'name' = 'Arnel Accounting Head' and po_no is not null from public.purchase_orders where id = :P),
  'issued, with the Accounting head printed as approver');
select pg_temp.ok(pg_temp.inbox(:AH, 'po_draft') = 0, 'it leaves the Inbox');
rollback;

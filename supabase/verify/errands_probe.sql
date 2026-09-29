-- Probe for 20261012_01/02 — Errands (Messenger / Liaison Officer): requests,
-- approval, the messenger's checklist with photo / signature proof, the
-- transmittal slip, failure / reschedule, replace / cancel / edit, overdue
-- alerts to the Head and Super Admin, recurring errands, and who sees what.
-- One transaction, rolled back.   psql -d awes_backup -f errands_probe.sql
\set ON_ERROR_STOP 1
begin;
create function pg_temp.ok(c boolean, n text) returns void language plpgsql as $$ begin if c then raise notice 'PASS  %', n; else raise exception 'FAIL  %', n; end if; end $$;
create function pg_temp.as_user(p uuid) returns void language plpgsql as $$ begin
  perform set_config('request.jwt.claim.sub', coalesce(p::text, ''), true);
  perform set_config('request.jwt.claim.role', case when p is null then 'service_role' else 'authenticated' end, true); end $$;
create function pg_temp.run(p uuid, q text) returns text language plpgsql as $$ begin
  perform pg_temp.as_user(p); set local role authenticated;
  begin execute q; exception when others then reset role; return 'ERR: ' || sqlerrm; end; reset role; return 'ok'; end $$;
create function pg_temp.val(p uuid, q text) returns text language plpgsql as $$ declare r text; begin
  perform pg_temp.as_user(p); set local role authenticated;
  begin execute q into r; exception when others then reset role; return 'ERR: ' || sqlerrm; end; reset role; return r; end $$;
create function pg_temp.seen(p uuid, q text) returns bigint language plpgsql as $$ declare n bigint; begin
  perform pg_temp.as_user(p); set local role authenticated; execute 'select count(*) from (' || q || ') x' into n; reset role; return n; end $$;
create function pg_temp.inbox(p uuid, k text, ref text) returns bigint language plpgsql as $$ declare n bigint; begin
  perform pg_temp.as_user(p); select count(*) into n from jsonb_array_elements(public.inbox_items()) x where x->>'kind' = k and x->>'ref_id' like ref || '%'; return n; end $$;
create function pg_temp.pushed(k text, ref text, u uuid, lvl int) returns boolean language sql as $$
  select exists (select 1 from public.inbox_escalations_due() d where d.kind = k and d.ref_id like ref || '%' and d.level = lvl and u = any(d.recipients)) $$;

\set A  '''00000000-0000-0000-0000-0000000000a1'''
\set TE '''00000000-0000-0000-0000-0000000000b1'''
\set AH '''60000000-0000-0000-0000-00000000000a'''
\set AC '''60000000-0000-0000-0000-00000000000b'''
\set M1 '''60000000-0000-0000-0000-00000000000c'''
\set M2 '''60000000-0000-0000-0000-00000000000d'''
\set RQ '''60000000-0000-0000-0000-00000000000e'''
\set OT '''60000000-0000-0000-0000-00000000000f'''
insert into auth.users (id, email) values (:AH, 'ah@x'), (:AC, 'ac@x'), (:M1, 'm1@x'), (:M2, 'm2@x'), (:RQ, 'rq@x'), (:OT, 'ot@x');
insert into public.profiles (id, name, role, username) values
  (:AH, 'Hana Admin Head', 'staff', 'er_ah'), (:AC, 'Carlo Admin Clerk', 'staff', 'er_ac'), (:M1, 'Migo Messenger', 'staff', 'er_m1'),
  (:M2, 'Mara Messenger', 'staff', 'er_m2'), (:RQ, 'Rey Requester', 'staff', 'er_rq'), (:OT, 'Otis Other', 'staff', 'er_ot');
select pg_temp.as_user(null);
select public.staff_apply_access(:AH::uuid, '[{"id":"administration","is_head":true}]', '[{"module":"adm.errands","level":"approve"}]', :A::uuid);
select public.staff_apply_access(:AC::uuid, '[{"id":"administration"}]', '[{"module":"adm.errands","level":"edit"}]', :A::uuid);
select public.staff_apply_access(:M1::uuid, '[{"id":"administration"}]', '[{"module":"adm.my_errands","level":"edit"}]', :A::uuid);
select public.staff_apply_access(:M2::uuid, '[{"id":"administration"}]', '[{"module":"adm.my_errands","level":"edit"}]', :A::uuid);
select public.staff_apply_access(:RQ::uuid, '[{"id":"purchasing"}]', '[{"module":"pur.suppliers","level":"view"}]', :A::uuid);
select public.staff_apply_access(:OT::uuid, '[{"id":"purchasing"}]', '[{"module":"pur.suppliers","level":"view"}]', :A::uuid);

-- ---- requests ------------------------------------------------------------------
select pg_temp.ok(pg_temp.val(:TE, $q$select public.errand_request('{"title":"x"}')::text$q$) like 'ERR:%Only staff%', 'a technician can''t request an errand');
select pg_temp.ok(pg_temp.val(:RQ, $q$select public.errand_request('{"title":" "}')::text$q$) like 'ERR:%Say what%', 'a request needs a title');
create temp table t_ids (k text primary key, v uuid);
grant all on t_ids to authenticated;
insert into t_ids select 'req', pg_temp.val(:RQ, $q$select public.errand_request('{"title":"Submit BIR 2307 to Acme","type":"government","destination":"BIR RDO 44","due_at":"2026-12-01T09:00:00+08",
  "checklist":[{"text":"Get queue number"},{"text":"Photo of the stamped copy","needs_photo":true},{"text":"Receiver signs","needs_signature":true}],
  "items":[{"qty":"2","description":"BIR Form 2307","remarks":"original"}],"transmittal_required":true,"copy_expected":true}')::text$q$)::uuid;
\set REQ '(select v from t_ids where k = ''req'')'
select pg_temp.ok((select status = 'requested' and requested_by_name = 'Rey Requester' and errand_no like 'ER-%' from public.errands where id = :REQ), 'the request is recorded as pending, with who asked');
select pg_temp.ok(pg_temp.seen(:RQ, 'select * from public.errands') = 1 and pg_temp.seen(:OT, 'select * from public.errands') = 0, 'the requester sees their own request; another staff member sees nothing');
select pg_temp.ok(pg_temp.inbox(:AH, 'errand_request', (select v::text from t_ids where k = 'req')) = 1, 'the request is in the Administration Head''s Inbox');
select pg_temp.ok(pg_temp.inbox(:RQ, 'errand_request', (select v::text from t_ids where k = 'req')) = 0, '… not the requester''s');
select pg_temp.as_user(null);
select pg_temp.ok(pg_temp.pushed('errand_request', (select v::text from t_ids where k = 'req'), :AH::uuid, 0), 'a new request is pushed to the Head');

-- ---- approval ------------------------------------------------------------------
select pg_temp.ok(pg_temp.run(:AC, 'select public.errand_approve(' || quote_literal((select v from t_ids where k='req')) || ')') like 'ERR: You need Errands › Approve%', 'Edit access can''t approve a request');
select pg_temp.ok(pg_temp.run(:AH, 'select public.errand_approve(' || quote_literal((select v from t_ids where k='req')) || ', ' || quote_literal(:OT) || ')') like 'ERR:%isn''t set up as a messenger%', 'it can only be assigned to a messenger');
select pg_temp.ok(pg_temp.run(:AH, 'select public.errand_approve(' || quote_literal((select v from t_ids where k='req')) || ', ' || quote_literal(:M1) || ')') = 'ok', 'the Head approves and assigns Migo');
select pg_temp.ok((select status = 'assigned' and assigned_name = 'Migo Messenger' from public.errands where id = :REQ), 'approved → assigned');
select pg_temp.ok(pg_temp.inbox(:M1, 'errand_todo', (select v::text from t_ids where k = 'req')) = 1, 'Migo has it in their Inbox');
select pg_temp.ok(pg_temp.inbox(:M2, 'errand_todo', (select v::text from t_ids where k = 'req')) = 0 and pg_temp.inbox(:AH, 'errand_todo', (select v::text from t_ids where k = 'req')) = 0
  and pg_temp.inbox(:A, 'errand_todo', (select v::text from t_ids where k = 'req')) = 0, '… and nobody else does — not Mara, not the Head, not the Super Admin');
select pg_temp.as_user(null);
select pg_temp.ok(pg_temp.pushed('errand_todo', (select v::text from t_ids where k = 'req'), :M1::uuid, 0) and not pg_temp.pushed('errand_todo', (select v::text from t_ids where k = 'req'), :AH::uuid, 0),
  'the assignment is pushed to Migo only');
select pg_temp.ok(pg_temp.seen(:M2, 'select * from public.errands') = 0, 'Mara can''t read Migo''s errand');

-- ---- the messenger's work ----------------------------------------------------------
\set LOC '''{"lat":14.5547,"lng":121.0244,"accuracy":12,"address":"BGC, Taguig"}'''
select pg_temp.ok(pg_temp.run(:M2, 'select public.errand_start(' || quote_literal((select v from t_ids where k='req')) || ')') like 'ERR:%isn''t assigned to you%', 'someone else can''t start it');
select pg_temp.ok(pg_temp.run(:M1, 'select public.errand_step(' || quote_literal((select v from t_ids where k='req')) || ', ''x'', true)') like 'ERR:%can''t be done from here%', 'steps can''t be ticked before starting');
select pg_temp.ok(pg_temp.run(:M1, 'select public.errand_start(' || quote_literal((select v from t_ids where k='req')) || ', ' || quote_literal(:LOC) || '::jsonb)') = 'ok', 'Migo starts it');
select pg_temp.ok((select status = 'in_progress' and started_at is not null and (start_loc->>'lat')::numeric = 14.5547 and start_loc->>'address' = 'BGC, Taguig' from public.errands where id = :REQ),
  'start is stamped with the server time and the phone''s location');
create temp table t_steps as select s->>'id' as id, s->>'text' as txt from public.errands e, jsonb_array_elements(e.checklist) s where e.id = :REQ;
grant all on t_steps to authenticated;
\set S1 '(select id from t_steps where txt = ''Get queue number'')'
\set S2 '(select id from t_steps where txt = ''Photo of the stamped copy'')'
\set S3 '(select id from t_steps where txt = ''Receiver signs'')'
select pg_temp.ok(pg_temp.run(:M1, 'select public.errand_step(' || quote_literal((select v from t_ids where k='req')) || ', ' || quote_literal((select id from t_steps where txt = 'Get queue number')) || ', true, ' || quote_literal(:LOC) || '::jsonb)') = 'ok', 'a plain step is ticked');
select pg_temp.ok((select (s->>'done')::boolean and s->>'done_by' = 'Migo Messenger' and s->'done_loc'->>'address' = 'BGC, Taguig' and s->>'done_at' is not null
                     from public.errands e, jsonb_array_elements(e.checklist) s where e.id = :REQ and s->>'text' = 'Get queue number'), 'the tick carries who, when (server time) and where');
select pg_temp.ok(pg_temp.run(:M1, 'select public.errand_step(' || quote_literal((select v from t_ids where k='req')) || ', ' || quote_literal((select id from t_steps where txt = 'Photo of the stamped copy')) || ', true)') like 'ERR: Take a photo%', 'a photo step can''t be ticked without a photo');
select pg_temp.ok(pg_temp.run(:M1, 'select public.errand_add_file(' || quote_literal((select v from t_ids where k='req')) || ', ''wrong/path.jpg'', ''proof'', ' || quote_literal((select id from t_steps where txt = 'Photo of the stamped copy')) || ')') like 'ERR: Bad file path%', 'a file must be stored under the errand''s own folder');
select pg_temp.ok(pg_temp.run(:M1, 'select public.errand_add_file(' || quote_literal((select v from t_ids where k='req')) || ', ' || quote_literal((select v::text from t_ids where k='req') || '/p1.jpg') || ', ''proof'', ' || quote_literal((select id from t_steps where txt = 'Photo of the stamped copy')) || ', ' || quote_literal(:LOC) || '::jsonb)') = 'ok', 'the photo is attached, with its location');
select pg_temp.ok(pg_temp.run(:M1, 'select public.errand_step(' || quote_literal((select v from t_ids where k='req')) || ', ' || quote_literal((select id from t_steps where txt = 'Photo of the stamped copy')) || ', true)') = 'ok', 'now the photo step ticks');
select pg_temp.ok(pg_temp.run(:M1, 'select public.errand_complete(' || quote_literal((select v from t_ids where k='req')) || ')') like 'ERR: 1 checklist step%', 'it can''t be finished with a step undone');
select pg_temp.ok(pg_temp.run(:M1, 'select public.errand_step(' || quote_literal((select v from t_ids where k='req')) || ', ' || quote_literal((select id from t_steps where txt = 'Receiver signs')) || ', true)') like 'ERR: Get the signature%', 'a signature step needs the signature first');
select pg_temp.run(:M1, 'select public.errand_add_file(' || quote_literal((select v from t_ids where k='req')) || ', ' || quote_literal((select v::text from t_ids where k='req') || '/sig1.png') || ', ''signature'', ' || quote_literal((select id from t_steps where txt = 'Receiver signs')) || ')');
select pg_temp.ok(pg_temp.run(:M1, 'select public.errand_step(' || quote_literal((select v from t_ids where k='req')) || ', ' || quote_literal((select id from t_steps where txt = 'Receiver signs')) || ', true)') = 'ok', '… then ticks');
select pg_temp.ok(pg_temp.run(:M1, 'select public.errand_complete(' || quote_literal((select v from t_ids where k='req')) || ')') like 'ERR: Hand over the items%', 'it can''t be finished before the transmittal slip');

-- transmittal
select pg_temp.ok(pg_temp.run(:M1, 'select public.errand_deliver(' || quote_literal((select v from t_ids where k='req')) || ', ''{"receiver_name":"Ana"}'')') like 'ERR: Get the receiver%', 'the slip needs a signature or the stamped copy');
select pg_temp.ok(pg_temp.run(:M1, 'select public.errand_deliver(' || quote_literal((select v from t_ids where k='req')) || ', ''{"receiver_signature_path":"' || (select v::text from t_ids where k='req') || '/rsig.png"}'')') like 'ERR: Enter the receiver%', 'a signature needs the receiver''s name');
select pg_temp.ok(pg_temp.val(:M1, 'select public.errand_deliver(' || quote_literal((select v from t_ids where k='req')) || ', ''{"receiver_name":"Ana Reyes","receiver_position":"Clerk","receiver_signature_path":"' || (select v::text from t_ids where k='req') || '/rsig.png","messenger_signature_path":"' || (select v::text from t_ids where k='req') || '/msig.png","loc":{"lat":14.5,"lng":121.0}}'')') like 'TS-%', 'the slip is numbered TS-…');
select pg_temp.ok((select receiver_name = 'Ana Reyes' and items->0->>'description' = 'BIR Form 2307' and delivered_by_name = 'Migo Messenger' and (delivered_loc->>'lat')::numeric = 14.5 from public.errand_transmittals where errand_id = :REQ),
  'it holds the items, the receiver and who / where / when');
select pg_temp.ok(pg_temp.run(:M1, 'select public.errand_complete(' || quote_literal((select v from t_ids where k='req')) || ', ''All submitted'', ' || quote_literal(:LOC) || '::jsonb)') = 'ok', 'Migo finishes the errand');
select pg_temp.ok((select status = 'done' and completed_at is not null and completed_loc->>'address' = 'BGC, Taguig' from public.errands where id = :REQ), 'completion is stamped with time and place');

-- review, close, stamped copy
select pg_temp.ok(pg_temp.inbox(:AH, 'errand_review', (select v::text from t_ids where k = 'req')) = 1 and pg_temp.inbox(:AC, 'errand_review', (select v::text from t_ids where k = 'req')) = 0, 'it''s in the Head''s Inbox for review (approve level)');
select pg_temp.ok(pg_temp.run(:AC, 'select public.errand_close(' || quote_literal((select v from t_ids where k='req')) || ')') like 'ERR: You need Errands › Approve%', 'only Approve access closes an errand');
select pg_temp.ok(pg_temp.run(:AH, 'select public.errand_close(' || quote_literal((select v from t_ids where k='req')) || ')') = 'ok', 'the Head closes it');
select pg_temp.ok(pg_temp.inbox(:AC, 'errand_copy', (select v::text from t_ids where k = 'req')) = 1, 'the stamped copy not yet back is in the office''s Inbox');
select pg_temp.ok(pg_temp.run(:AC, 'select public.errand_confirm_copy(' || quote_literal((select v from t_ids where k='req')) || ')') = 'ok', 'confirming the filed copy clears it (action)');
select pg_temp.ok(pg_temp.inbox(:AC, 'errand_copy', (select v::text from t_ids where k = 'req')) = 0, 'confirming the filed copy clears it');
select pg_temp.ok(pg_temp.seen(:RQ, 'select * from public.errand_transmittals') = 1, 'the requester can see the slip');
select pg_temp.ok(pg_temp.run(:AC, 'select public.errand_save(' || quote_literal((select v from t_ids where k='req')) || ', ''{"title":"x"}'')') like 'ERR:%closed errand can''t be edited%', 'a closed errand can''t be edited');

-- ---- direct create, edit, fail, reschedule, replace, cancel ---------------------------
insert into t_ids select 'e2', pg_temp.val(:AC, 'select public.errand_save(null, ''{"title":"Deposit collections","type":"bank","due_at":"2020-01-01T10:00:00+08","assigned_to":"' || :M1 || '",
  "checklist":[{"text":"Deposit"},{"text":"Get slip","needs_photo":true}]}'')::text')::uuid;
select pg_temp.ok((select status = 'assigned' and assigned_name = 'Migo Messenger' from public.errands where id = (select v from t_ids where k = 'e2')), 'Administration creates an errand directly, assigned');
select pg_temp.ok(pg_temp.run(:AC, 'select public.errand_save(null, ''{"title":"x","assigned_to":"' || :OT || '"}'')') like 'ERR:%isn''t set up as a messenger%', 'a non-messenger can''t be assigned');
-- overdue (3 hours ago — within the push window)
update public.errands set due_at = now() - interval '3 hours' where id = (select v from t_ids where k = 'e2');
select pg_temp.ok(pg_temp.inbox(:AH, 'errand_overdue', (select v::text from t_ids where k = 'e2')) = 1, 'an overdue errand is in the Head''s Inbox');
select pg_temp.as_user(null);
select pg_temp.ok(pg_temp.pushed('errand_overdue', (select v::text from t_ids where k = 'e2'), :AH::uuid, 0) and pg_temp.pushed('errand_overdue', (select v::text from t_ids where k = 'e2'), :A::uuid, 0),
  'overdue: the Administration Head AND the Super Admin are alerted immediately');
select pg_temp.ok(pg_temp.pushed('errand_overdue', (select v::text from t_ids where k = 'e2'), :AH::uuid, 1) and pg_temp.pushed('errand_overdue', (select v::text from t_ids where k = 'e2'), :A::uuid, 1),
  '… and again at the escalation step');
select pg_temp.ok(not pg_temp.pushed('errand_overdue', (select v::text from t_ids where k = 'e2'), :M1::uuid, 0), 'the messenger isn''t sent the admin alert');
-- fail + reschedule
select pg_temp.ok(pg_temp.run(:M1, 'select public.errand_fail(' || quote_literal((select v from t_ids where k='e2')) || ', '' '')') like 'ERR: Say why%', 'failing needs a reason');
select pg_temp.ok(pg_temp.run(:M1, 'select public.errand_fail(' || quote_literal((select v from t_ids where k='e2')) || ', ''Bank was closed'', ' || quote_literal(:LOC) || '::jsonb)') = 'ok', 'Migo reports it couldn''t be completed');
select pg_temp.ok(pg_temp.inbox(:AC, 'errand_failed', (select v::text from t_ids where k = 'e2')) = 1, 'Administration sees it in the Inbox to reschedule');
select pg_temp.ok(pg_temp.inbox(:M1, 'errand_todo', (select v::text from t_ids where k = 'e2')) = 0, 'it leaves the messenger''s list');
select pg_temp.run(:AC, 'select public.errand_save(' || quote_literal((select v from t_ids where k='e2')) || ', ''{"title":"Deposit collections","type":"bank","due_at":"2030-01-01T10:00:00+08","assigned_to":"' || :M1 || '",
  "checklist":[{"text":"Deposit"},{"text":"Get slip","needs_photo":true},{"text":"Bring slip to Finance"}]}'')');
select pg_temp.ok((select status = 'assigned' and failed_reason = '' and seq = 2 and jsonb_array_length(checklist) = 3 from public.errands where id = (select v from t_ids where k = 'e2')), 'editing a failed errand reschedules it (and a step can be added)');
select pg_temp.ok(pg_temp.inbox(:AH, 'errand_overdue', (select v::text from t_ids where k = 'e2')) = 0 and pg_temp.inbox(:M1, 'errand_todo', (select v::text from t_ids where k = 'e2')) = 1, 'no longer overdue; the messenger has it again');
select pg_temp.as_user(null);
select pg_temp.ok(pg_temp.pushed('errand_todo', (select v::text from t_ids where k = 'e2') || '-2', :M1::uuid, 0), 'the messenger is alerted again for the reschedule');
-- replace
select pg_temp.ok(pg_temp.run(:AC, 'select public.errand_assign(' || quote_literal((select v from t_ids where k='e2')) || ', ' || quote_literal(:M2) || ')') = 'ok', 'Administration replaces the messenger');
select pg_temp.ok(pg_temp.inbox(:M1, 'errand_todo', (select v::text from t_ids where k = 'e2')) = 0 and pg_temp.inbox(:M2, 'errand_todo', (select v::text from t_ids where k = 'e2')) = 1, 'it moves from Migo to Mara');
select pg_temp.ok(pg_temp.run(:M1, 'select public.errand_start(' || quote_literal((select v from t_ids where k='e2')) || ')') like 'ERR:%isn''t assigned to you%', 'Migo can no longer act on it');
-- edit while in progress keeps done steps
select pg_temp.run(:M2, 'select public.errand_start(' || quote_literal((select v from t_ids where k='e2')) || ')');
select pg_temp.run(:M2, 'select public.errand_step(' || quote_literal((select v from t_ids where k='e2')) || ', ' || quote_literal((select s->>'id' from public.errands e, jsonb_array_elements(e.checklist) s where e.id = (select v from t_ids where k='e2') and s->>'text' = 'Deposit')) || ', true)');
select pg_temp.ok(pg_temp.run(:AC, 'select public.errand_save(' || quote_literal((select v from t_ids where k='e2')) || ', ''{"title":"Deposit collections","assigned_to":"' || :M2 || '","checklist":[{"text":"Get slip"}]}'')') like 'ERR: A step that%already done%',
  'a step that''s already done can''t be removed by an edit');
select pg_temp.ok(pg_temp.run(:AC, 'select public.errand_save(' || quote_literal((select v from t_ids where k='e2')) || ', ''{"title":"Deposit collections — rush","assigned_to":"' || :M2 || '","checklist":' ||
  (select jsonb_agg(jsonb_build_object('id', s->>'id', 'text', s->>'text'))::text from public.errands e, jsonb_array_elements(e.checklist) s where e.id = (select v from t_ids where k='e2')) || '}'')') = 'ok', 'Administration edits it while in progress');
select pg_temp.ok((select status = 'in_progress' and title like '%rush' and (checklist->0->>'done')::boolean from public.errands where id = (select v from t_ids where k = 'e2')), 'editing while in progress keeps the work already done');
-- cancel
select pg_temp.ok(pg_temp.run(:AC, 'select public.errand_cancel(' || quote_literal((select v from t_ids where k='e2')) || ', '''')') like 'ERR: Say why%', 'cancelling needs a reason');
select pg_temp.ok(pg_temp.run(:AC, 'select public.errand_cancel(' || quote_literal((select v from t_ids where k='e2')) || ', ''No longer needed'')') = 'ok', 'Administration cancels it; it leaves the messenger''s list (action)');
select pg_temp.ok(pg_temp.inbox(:M2, 'errand_todo', (select v::text from t_ids where k = 'e2')) = 0, 'Administration cancels it; it leaves the messenger''s list');
-- requester cancels only their own pending request
insert into t_ids select 'r2', pg_temp.val(:RQ, $q$select public.errand_request('{"title":"Pick up cheque"}')::text$q$)::uuid;
select pg_temp.ok(pg_temp.run(:OT, 'select public.errand_cancel(' || quote_literal((select v from t_ids where k='r2')) || ', ''x'')') like 'ERR: You can''t cancel%', 'someone else can''t cancel a request');
select pg_temp.ok(pg_temp.run(:RQ, 'select public.errand_cancel(' || quote_literal((select v from t_ids where k='r2')) || ', ''Not needed'')') = 'ok', 'the requester withdraws their own pending request');
insert into t_ids select 'r3', pg_temp.val(:RQ, $q$select public.errand_request('{"title":"Buy stamps"}')::text$q$)::uuid;
select pg_temp.ok(pg_temp.run(:AC, 'select public.errand_decline(' || quote_literal((select v from t_ids where k='r3')) || ', ''x'')') like 'ERR: You need Errands › Approve%', 'Edit access can''t decline');
select pg_temp.ok(pg_temp.run(:AH, 'select public.errand_decline(' || quote_literal((select v from t_ids where k='r3')) || ', ''Use the courier account'')') = 'ok', 'the Head declines with a reason (action)');
select pg_temp.ok((select cancel_reason = 'Use the courier account' from public.errands where id = (select v from t_ids where k = 'r3')), 'the Head declines with a reason');

-- ---- unassigned ------------------------------------------------------------------------
insert into t_ids select 'e4', pg_temp.val(:AC, $q$select public.errand_save(null, '{"title":"Renew business permit","due_at":"2031-01-01T10:00:00+08"}')::text$q$)::uuid;
select pg_temp.ok((select status = 'open' from public.errands where id = (select v from t_ids where k='e4')) and pg_temp.inbox(:AC, 'errand_unassigned', (select v::text from t_ids where k = 'e4')) = 1, 'an errand with no messenger is "open" and in Administration''s Inbox');

-- ---- storage access -----------------------------------------------------------------------
select pg_temp.run(:AC, 'select public.errand_assign(' || quote_literal((select v from t_ids where k='e4')) || ', ' || quote_literal(:M1) || ')');
select pg_temp.run(:M1, 'select public.errand_start(' || quote_literal((select v from t_ids where k='e4')) || ')');
select pg_temp.ok(pg_temp.val(:M1, 'select public.errand_storage_ok(' || quote_literal((select v::text from t_ids where k='e4') || '/a.jpg') || ', true)') = 'true', 'the messenger can upload to an errand in progress');
select pg_temp.ok(pg_temp.val(:M2, 'select public.errand_storage_ok(' || quote_literal((select v::text from t_ids where k='e4') || '/a.jpg') || ', true)') = 'false'
  and pg_temp.val(:M2, 'select public.errand_storage_ok(' || quote_literal((select v::text from t_ids where k='e4') || '/a.jpg') || ', false)') = 'false', 'another messenger can neither upload nor read');
select pg_temp.ok(pg_temp.val(:AH, 'select public.errand_storage_ok(' || quote_literal((select v::text from t_ids where k='e4') || '/a.jpg') || ', false)') = 'true'
  and pg_temp.val(:M1, 'select public.errand_storage_ok(''not-a-uuid/x.jpg'', true)') = 'false', 'Administration can read; a malformed path is refused');

-- ---- recurring ---------------------------------------------------------------------------------
select pg_temp.ok(pg_temp.run(:AC, $q$select public.errand_recurrence_save(null, '{"title":"x","freq":"monthly"}')$q$) like 'ERR: You need Errands › Approve%', 'only Approve access manages recurring errands');
select pg_temp.ok(pg_temp.run(:AH, $q$select public.errand_recurrence_save(null, '{"title":"x","freq":"weekly","weekdays":[]}')$q$) like 'ERR: Pick at least one weekday%', 'weekly needs a weekday');
insert into t_ids select 'rec', pg_temp.val(:AH, $q$select public.errand_recurrence_save(null, jsonb_build_object('title','Remit SSS','type','payment','freq','monthly','day_of_month',10,
  'if_weekend','before','due_time','10:00','lead_days',3,'assign_to','60000000-0000-0000-0000-00000000000c','start_date','2026-01-01',
  'checklist', jsonb_build_array(jsonb_build_object('text','Pay at the bank','needs_photo',true))))::text$q$)::uuid;
select pg_temp.ok((select next_due = '2026-01-09' from public.errand_recurrences where id = (select v from t_ids where k='rec')), 'monthly on the 10th, falling on a Saturday → moved back to Friday the 9th');
update public.errand_recurrences set next_due = public.manila_today() + 2 where id = (select v from t_ids where k='rec');
select pg_temp.as_user(null);
select pg_temp.ok(public.errand_recur_run() >= 1, 'the hourly run creates the errands that are due (3 days ahead)');
select pg_temp.ok((select count(*) = 1 and bool_and(status = 'assigned') and bool_and(assigned_name = 'Migo Messenger') and bool_and(checklist->0->>'text' = 'Pay at the bank' and (checklist->0->>'needs_photo')::boolean)
                     from public.errands where recurrence_id = (select v from t_ids where k='rec')), 'it is assigned to Migo with the checklist copied');
select pg_temp.ok((select last_created_for = public.manila_today() + 2 and next_due > last_created_for from public.errand_recurrences where id = (select v from t_ids where k='rec')), 'and the next date moves on');
select pg_temp.ok(public.errand_recur_run() = 0, 'running again straight away creates nothing');
select pg_temp.ok(pg_temp.val(:AC, 'select public.errand_recur_run_now()::text') = '0' and pg_temp.val(:OT, 'select public.errand_recur_run_now()::text') = '0', 'the app''s backstop run is safe for anyone');
rollback;

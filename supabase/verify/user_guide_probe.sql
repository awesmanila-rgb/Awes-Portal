-- =====================================================================
-- Probe for 20260929_01_user_guide.sql — each person sees and changes
-- only their own guide progress. One transaction, rolled back.
--   psql -d awes_backup -f user_guide_probe.sql
-- =====================================================================
\set ON_ERROR_STOP 1
begin;
create function pg_temp.ok(p_cond boolean, p_name text) returns void language plpgsql as $$
begin if p_cond then raise notice 'PASS  %', p_name; else raise exception 'FAIL  %', p_name; end if; end $$;
create function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', p::text, true); perform set_config('request.jwt.claim.role', 'authenticated', true); end $$;
\set T  '''00000000-0000-0000-0000-0000000000b1'''
\set T2 '''00000000-0000-0000-0000-0000000000b2'''
\set A  '''00000000-0000-0000-0000-0000000000a1'''

select pg_temp.as_user(:T::uuid); set local role authenticated;
insert into public.user_guide_progress (user_id, data) values (:T::uuid, '{"lang":"tl","tours":{"tech":true}}');
select pg_temp.ok((select data->>'lang' from public.user_guide_progress where user_id = :T::uuid) = 'tl', 'a technician saves and reads their own progress');
update public.user_guide_progress set data = data || '{"lang":"en"}' where user_id = :T::uuid;
select pg_temp.ok((select data->>'lang' from public.user_guide_progress where user_id = :T::uuid) = 'en', '… and can change it');
reset role;

select pg_temp.as_user(:T2::uuid); set local role authenticated;
select pg_temp.ok((select count(*) from public.user_guide_progress) = 0, 'another technician can''t see it');
update public.user_guide_progress set data = '{}' where user_id = :T::uuid;
do $$ begin
  begin
    insert into public.user_guide_progress (user_id, data) values ('00000000-0000-0000-0000-0000000000b1', '{}')
    on conflict (user_id) do update set data = '{}';
    raise exception 'FAIL  wrote someone else''s row';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  can''t write someone else''s progress (%)', sqlerrm;
  end;
end $$;
reset role;
select pg_temp.ok((select data->>'lang' from public.user_guide_progress where user_id = :T::uuid) = 'en', 'their progress is untouched');

select pg_temp.as_user(:A::uuid); set local role authenticated;
select pg_temp.ok((select count(*) from public.user_guide_progress) = 0, 'not even the Super Admin reads other people''s progress');
reset role;
select pg_temp.ok(not exists (select 1 from information_schema.role_table_grants where grantee = 'anon' and table_name = 'user_guide_progress'),
                  'signed-out visitors have no access');
\echo
\echo 'All user guide probes passed — rolling back.'
rollback;

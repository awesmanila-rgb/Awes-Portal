-- ---------------------------------------------------------------------
-- Purchasing: manageable material categories
--
-- Categories used to be a fixed list in the app code. They now live in
-- public.material_categories, managed by admins from
-- Purchasing › Materials Database › Manage Categories:
--
--   * add       — name + item-code prefix (e.g. "Welding" → WLD-001, WLD-002…)
--   * rename    — via rename_material_category(), which also renames the
--                 category on every material and in every supplier's
--                 "Supplies" list, in one transaction. A direct UPDATE of
--                 the name is refused so items can never be orphaned.
--   * reorder   — sort_order (also the order of the materials list groups)
--   * hide      — is_active = false: kept on existing items, but no longer
--                 offered when adding / editing items or suppliers
--   * delete    — only when no material and no supplier uses it
--   * "Others" is the fallback category (imports, blank values) and can't
--     be renamed, hidden or deleted.
--
-- materials.category / suppliers.supplies stay plain text (no FK), so
-- older app versions keep working. Seeds the 12 original categories plus
-- any other category name already in use.
--
-- Depends on 20260923_01 and public.is_admin(). Safe to re-run.
-- ---------------------------------------------------------------------

create table if not exists public.material_categories (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (length(trim(name)) between 1 and 60),
  code_prefix  text not null check (code_prefix ~ '^[A-Z0-9]{2,6}$'),
  sort_order   int  not null default 0,
  is_active    boolean not null default true,
  is_system    boolean not null default false,   -- "Others": can't rename / hide / delete
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index if not exists material_categories_name_uq   on public.material_categories (lower(name));
create unique index if not exists material_categories_prefix_uq on public.material_categories (code_prefix);

drop trigger if exists material_categories_set_updated_at on public.material_categories;
create trigger material_categories_set_updated_at
  before update on public.material_categories
  for each row execute function public.purch_touch_updated_at();

-- ---------- seed ----------
insert into public.material_categories (name, code_prefix, sort_order, is_system)
select v.name, v.prefix, v.ord, v.name = 'Others'
  from (values
    ('Piping', 'PIP', 10), ('Refrigerant', 'REF', 20), ('Electrical', 'ELE', 30),
    ('Insulation', 'INS', 40), ('Consumables', 'CON', 50), ('Parts & Components', 'PRT', 60),
    ('Ducting & Ventilation', 'DUC', 70), ('Plumbing', 'PLB', 80), ('Fire Protection', 'FPR', 90),
    ('Hardware', 'HDW', 100), ('Tools & Equipment', 'TLS', 110), ('Others', 'OTH', 1000)
  ) as v(name, prefix, ord)
 where not exists (select 1 from public.material_categories c where lower(c.name) = lower(v.name));

update public.material_categories set is_system = true, is_active = true where name = 'Others';

-- Any other category name already on items or suppliers (e.g. typed by an
-- import) gets its own row, with a generated unique prefix.
do $$
declare
  n    text;
  base text;
  pfx  text;
  i    int;
  ord  int;
begin
  select coalesce(max(sort_order), 0) into ord from public.material_categories where not is_system;
  for n in
    select distinct trim(x) from (
      select category as x from public.materials
      union all
      select unnest(supplies) from public.suppliers
    ) s
    where trim(coalesce(x, '')) <> ''
      and not exists (select 1 from public.material_categories c where lower(c.name) = lower(trim(s.x)))
  loop
    base := upper(left(regexp_replace(n, '[^A-Za-z0-9]', '', 'g'), 3));
    if length(base) < 2 then base := 'CAT'; end if;
    pfx := base; i := 1;
    while exists (select 1 from public.material_categories where code_prefix = pfx) loop
      i := i + 1; pfx := left(base, 4) || i;
    end loop;
    ord := ord + 10;
    insert into public.material_categories (name, code_prefix, sort_order) values (n, pfx, ord);
  end loop;
end $$;

-- ---------- guards ----------
create or replace function public.material_categories_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if old.is_system then
      raise exception '"%" is the fallback category and can''t be deleted.', old.name using errcode = 'P0001';
    end if;
    if exists (select 1 from public.materials where category = old.name) then
      raise exception 'Category "%" is still used by materials — move them to another category or hide it instead.', old.name using errcode = 'P0001';
    end if;
    if exists (select 1 from public.suppliers where old.name = any(supplies)) then
      raise exception 'Category "%" is still listed under a supplier''s Supplies — hide it instead.', old.name using errcode = 'P0001';
    end if;
    return old;
  end if;

  new.name := trim(new.name);
  new.code_prefix := upper(trim(new.code_prefix));
  if new.name is distinct from old.name then
    if old.is_system then
      raise exception '"%" is the fallback category and can''t be renamed.', old.name using errcode = 'P0001';
    end if;
    if coalesce(current_setting('awes.cat_rename', true), '') <> 'on' then
      raise exception 'Rename categories with rename_material_category() so items and suppliers follow.' using errcode = 'P0001';
    end if;
  end if;
  if old.is_system and (not new.is_active or not new.is_system) then
    raise exception '"%" is the fallback category and can''t be hidden.', old.name using errcode = 'P0001';
  end if;
  return new;
end;
$$;
drop trigger if exists material_categories_guard on public.material_categories;
create trigger material_categories_guard
  before update or delete on public.material_categories
  for each row execute function public.material_categories_guard();

-- ---------- rename (items + suppliers follow) ----------
create or replace function public.rename_material_category(p_id uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  old_name text;
  new_name text := trim(coalesce(p_name, ''));
begin
  if not public.is_admin() then
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
$$;
revoke all on function public.rename_material_category(uuid, text) from public, anon;
grant execute on function public.rename_material_category(uuid, text) to authenticated;

-- ---------- RLS ----------
alter table public.material_categories enable row level security;

drop policy if exists material_categories_read on public.material_categories;
create policy material_categories_read on public.material_categories
  for select to authenticated using (true);     -- technicians / storekeepers see category names too

drop policy if exists material_categories_admin_all on public.material_categories;
create policy material_categories_admin_all on public.material_categories
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

grant select, insert, update, delete on public.material_categories to authenticated;

-- ---------- realtime ----------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'material_categories') then
    alter publication supabase_realtime add table public.material_categories;
  end if;
end $$;

notify pgrst, 'reload schema';

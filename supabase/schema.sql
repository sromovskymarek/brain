-- Brain – databáza v Supabase
-- Spusti celý súbor raz: Supabase → SQL Editor → New query → vlož → Run.
-- Všetky dáta sú v jednej tabuľke (kolekcia + id + JSON), presne ako v pôvodnej aplikácii.
-- Každý prihlásený používateľ vidí a mení iba svoje riadky (Row Level Security).

create table if not exists public.docs (
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  coll text not null check (char_length(coll) between 1 and 100),
  id text not null check (char_length(id) between 1 and 200),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (owner, coll, id)
);

alter table public.docs enable row level security;

drop policy if exists "docs_select_own" on public.docs;
drop policy if exists "docs_insert_own" on public.docs;
drop policy if exists "docs_update_own" on public.docs;
drop policy if exists "docs_delete_own" on public.docs;
create policy "docs_select_own" on public.docs for select to authenticated using (owner = (select auth.uid()));
create policy "docs_insert_own" on public.docs for insert to authenticated with check (owner = (select auth.uid()));
create policy "docs_update_own" on public.docs for update to authenticated using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
create policy "docs_delete_own" on public.docs for delete to authenticated using (owner = (select auth.uid()));

-- Zlúčenie polí (update) v jednom kroku
create or replace function public.doc_merge(p_coll text, p_id text, p_data jsonb)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  insert into public.docs as d (owner, coll, id, data)
  values (auth.uid(), p_coll, p_id, p_data)
  on conflict (owner, coll, id) do update
    set data = d.data || excluded.data, updated_at = now()
  returning d.data;
$$;
revoke all on function public.doc_merge(text, text, jsonb) from public, anon;
grant execute on function public.doc_merge(text, text, jsonb) to authenticated;

-- Čas poslednej zmeny
create or replace function public.docs_touch()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists docs_touch on public.docs;
create trigger docs_touch before update on public.docs for each row execute function public.docs_touch();

-- Živé zmeny medzi zariadeniami (telefón ↔ Mac)
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;

-- Fotky a prílohy: súkromný priečinok "assets", každý používateľ len vo svojom podpriečinku
insert into storage.buckets (id, name, public, file_size_limit)
values ('assets', 'assets', false, 15728640)
on conflict (id) do nothing;

drop policy if exists "assets_select_own" on storage.objects;
drop policy if exists "assets_insert_own" on storage.objects;
drop policy if exists "assets_delete_own" on storage.objects;
create policy "assets_select_own" on storage.objects for select to authenticated
  using (bucket_id = 'assets' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "assets_insert_own" on storage.objects for insert to authenticated
  with check (bucket_id = 'assets' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "assets_delete_own" on storage.objects for delete to authenticated
  using (bucket_id = 'assets' and (storage.foldername(name))[1] = (select auth.uid())::text);

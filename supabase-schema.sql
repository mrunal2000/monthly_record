-- Run this in the Supabase SQL editor.
-- Viewers can read everything. Only signed-in Supabase Auth users can add/edit/delete.

create extension if not exists "pgcrypto";

create table if not exists public.favorite_items (
  id uuid primary key default gen_random_uuid(),
  board_key text not null,
  month_id text not null,
  category_index integer not null,
  category_label text not null,
  item_kind text not null default 'image',
  image_url text,
  storage_path text,
  text_content text,
  x double precision not null default 12,
  y double precision not null default 28,
  width double precision not null default 30,
  rotation double precision not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Upgrade older databases that used only image uploads (safe to re-run).
alter table public.favorite_items
  add column if not exists item_kind text;

update public.favorite_items
  set item_kind = 'image'
  where item_kind is null;

alter table public.favorite_items
  alter column item_kind set default 'image';

alter table public.favorite_items
  alter column item_kind set not null;

alter table public.favorite_items
  add column if not exists text_content text;

alter table public.favorite_items
  alter column image_url drop not null;

alter table public.favorite_items
  alter column storage_path drop not null;

create index if not exists favorite_items_board_key_idx
  on public.favorite_items (board_key);

alter table public.favorite_items enable row level security;

drop policy if exists "public can read favorite items" on public.favorite_items;
create policy "public can read favorite items"
  on public.favorite_items for select
  using (true);

drop policy if exists "public can insert favorite items" on public.favorite_items;
drop policy if exists "authenticated users can insert favorite items" on public.favorite_items;
create policy "authenticated users can insert favorite items"
  on public.favorite_items for insert
  with check (auth.role() = 'authenticated');

drop policy if exists "public can update favorite items" on public.favorite_items;
drop policy if exists "authenticated users can update favorite items" on public.favorite_items;
create policy "authenticated users can update favorite items"
  on public.favorite_items for update
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

drop policy if exists "public can delete favorite items" on public.favorite_items;
drop policy if exists "authenticated users can delete favorite items" on public.favorite_items;
create policy "authenticated users can delete favorite items"
  on public.favorite_items for delete
  using (auth.role() = 'authenticated');

insert into storage.buckets (id, name, public)
values ('monthly-favorites', 'monthly-favorites', true)
on conflict (id) do update set public = true;

drop policy if exists "public can read favorite images" on storage.objects;
create policy "public can read favorite images"
  on storage.objects for select
  using (bucket_id = 'monthly-favorites');

drop policy if exists "public can upload favorite images" on storage.objects;
drop policy if exists "authenticated users can upload favorite images" on storage.objects;
create policy "authenticated users can upload favorite images"
  on storage.objects for insert
  with check (
    bucket_id = 'monthly-favorites'
    and auth.role() = 'authenticated'
  );

drop policy if exists "public can delete favorite images" on storage.objects;
drop policy if exists "authenticated users can delete favorite images" on storage.objects;
create policy "authenticated users can delete favorite images"
  on storage.objects for delete
  using (
    bucket_id = 'monthly-favorites'
    and auth.role() = 'authenticated'
  );

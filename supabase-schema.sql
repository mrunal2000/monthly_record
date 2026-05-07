-- Run this in the Supabase SQL editor.
-- This prototype uses public read/write policies. Add auth-specific policies before sharing widely.

create extension if not exists "pgcrypto";

create table if not exists public.favorite_items (
  id uuid primary key default gen_random_uuid(),
  board_key text not null,
  month_id text not null,
  category_index integer not null,
  category_label text not null,
  image_url text not null,
  storage_path text not null,
  x double precision not null default 12,
  y double precision not null default 28,
  width double precision not null default 30,
  rotation double precision not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists favorite_items_board_key_idx
  on public.favorite_items (board_key);

alter table public.favorite_items enable row level security;

drop policy if exists "public can read favorite items" on public.favorite_items;
create policy "public can read favorite items"
  on public.favorite_items for select
  using (true);

drop policy if exists "public can insert favorite items" on public.favorite_items;
create policy "public can insert favorite items"
  on public.favorite_items for insert
  with check (true);

drop policy if exists "public can update favorite items" on public.favorite_items;
create policy "public can update favorite items"
  on public.favorite_items for update
  using (true)
  with check (true);

drop policy if exists "public can delete favorite items" on public.favorite_items;
create policy "public can delete favorite items"
  on public.favorite_items for delete
  using (true);

insert into storage.buckets (id, name, public)
values ('monthly-favorites', 'monthly-favorites', true)
on conflict (id) do update set public = true;

drop policy if exists "public can read favorite images" on storage.objects;
create policy "public can read favorite images"
  on storage.objects for select
  using (bucket_id = 'monthly-favorites');

drop policy if exists "public can upload favorite images" on storage.objects;
create policy "public can upload favorite images"
  on storage.objects for insert
  with check (bucket_id = 'monthly-favorites');

drop policy if exists "public can delete favorite images" on storage.objects;
create policy "public can delete favorite images"
  on storage.objects for delete
  using (bucket_id = 'monthly-favorites');

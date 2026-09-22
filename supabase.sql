-- =============================================================
-- Viltrapport – databas och säkerhetsregler för Supabase
-- Klistra in allt i Supabase → SQL Editor → New query → Run
-- Går att köra flera gånger utan att något går sönder.
-- =============================================================

-- 1. Tabellen för rapporter
create table if not exists public.reports (
  id             bigint generated always as identity primary key,
  user_id        uuid not null default auth.uid()
                 references auth.users (id) on delete cascade,
  reporter_email text not null default (auth.jwt() ->> 'email'),
  species        text not null check (char_length(species) between 1 and 100),
  animal_count   integer not null default 1 check (animal_count between 1 and 10000),
  observed_at    timestamptz not null default now(),
  comment        text check (comment is null or char_length(comment) <= 1000),
  lat            double precision not null check (lat between -90 and 90),
  lng            double precision not null check (lng between -180 and 180),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists reports_observed_at_idx on public.reports (observed_at desc);

-- 2. Rapportören sätts alltid av databasen, aldrig av appen.
--    Det gör att ingen kan fuska och skriva in någon annans namn.
create or replace function public.reports_set_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.user_id        := auth.uid();
    new.reporter_email := coalesce(auth.jwt() ->> 'email', 'okänd');
    new.created_at     := now();
  else
    -- Vid ändring får ägare och skapad-tid inte ändras
    new.user_id        := old.user_id;
    new.reporter_email := old.reporter_email;
    new.created_at     := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists reports_set_owner on public.reports;
create trigger reports_set_owner
  before insert or update on public.reports
  for each row execute function public.reports_set_owner();

-- 3. Slå på Row Level Security (RLS)
alter table public.reports enable row level security;

-- 4. Säkerhetsregler (policies)
drop policy if exists "Inloggade kan läsa alla rapporter" on public.reports;
create policy "Inloggade kan läsa alla rapporter"
  on public.reports for select
  to authenticated
  using (true);

drop policy if exists "Inloggade kan skapa egna rapporter" on public.reports;
create policy "Inloggade kan skapa egna rapporter"
  on public.reports for insert
  to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "Man kan ändra sina egna rapporter" on public.reports;
create policy "Man kan ändra sina egna rapporter"
  on public.reports for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "Man kan ta bort sina egna rapporter" on public.reports;
create policy "Man kan ta bort sina egna rapporter"
  on public.reports for delete
  to authenticated
  using (user_id = (select auth.uid()));

-- 5. Den som inte är inloggad (anon) får ingen åtkomst alls
revoke all on public.reports from anon;
grant select, insert, update, delete on public.reports to authenticated;

-- =============================================================
-- DEL 2: Egna färger och egna arter
-- =============================================================

-- 6. Profiler – varje användares valda färg
create table if not exists public.profiles (
  user_id    uuid primary key default auth.uid()
             references auth.users (id) on delete cascade,
  color      text not null check (color ~ '^#[0-9a-fA-F]{6}$'),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "Inloggade kan se allas färger" on public.profiles;
create policy "Inloggade kan se allas färger"
  on public.profiles for select
  to authenticated
  using (true);

drop policy if exists "Man kan skapa sin egen profil" on public.profiles;
create policy "Man kan skapa sin egen profil"
  on public.profiles for insert
  to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "Man kan ändra sin egen profil" on public.profiles;
create policy "Man kan ändra sin egen profil"
  on public.profiles for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

revoke all on public.profiles from anon;
grant select, insert, update on public.profiles to authenticated;

-- 7. Egna arter – arter som användarna lagt till själva
create table if not exists public.custom_species (
  id         bigint generated always as identity primary key,
  name       text not null check (char_length(btrim(name)) between 1 and 100),
  category   text not null default 'ovrigt' check (category ~ '^[a-z]{1,30}$'),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

-- Samma art får bara finnas en gång (stora/små bokstäver räknas som samma)
create unique index if not exists custom_species_name_key
  on public.custom_species (lower(btrim(name)));

alter table public.custom_species enable row level security;

drop policy if exists "Inloggade kan se egna arter" on public.custom_species;
create policy "Inloggade kan se egna arter"
  on public.custom_species for select
  to authenticated
  using (true);

drop policy if exists "Inloggade kan lägga till arter" on public.custom_species;
create policy "Inloggade kan lägga till arter"
  on public.custom_species for insert
  to authenticated
  with check (created_by = (select auth.uid()));

revoke all on public.custom_species from anon;
grant select, insert on public.custom_species to authenticated;

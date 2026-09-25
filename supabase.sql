-- =============================================================
-- Charlies mega-ultra-viltrapport – databas och säkerhetsregler
-- Klistra in allt i Supabase → SQL Editor → New query → Run
-- Går att köra flera gånger utan att något går sönder.
-- =============================================================


-- =============================================================
-- 1. TABELLER
-- =============================================================

-- Rapporter
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

-- Typ av rapport: observation (sett djuret), olycka (fordon) eller birdstrike (flygplan)
alter table public.reports add column if not exists report_type text not null default 'observation';
alter table public.reports drop constraint if exists reports_report_type_check;
alter table public.reports add constraint reports_report_type_check
  check (report_type in ('observation', 'olycka', 'birdstrike'));

-- Väder när djuret sågs (ögonblicksbild + timmarna före), hämtas av appen
alter table public.reports add column if not exists weather jsonb;
alter table public.reports drop constraint if exists reports_weather_check;
alter table public.reports add constraint reports_weather_check
  check (weather is null or (jsonb_typeof(weather) = 'object' and octet_length(weather::text) < 20000));

-- Profiler: en rad per användare (färg, medlem, admin)
create table if not exists public.profiles (
  user_id    uuid primary key default auth.uid()
             references auth.users (id) on delete cascade,
  color      text check (color ~ '^#[0-9a-fA-F]{6}$'),
  updated_at timestamptz not null default now()
);
alter table public.profiles alter column color drop not null;
alter table public.profiles add column if not exists email text;
alter table public.profiles add column if not exists is_admin boolean not null default false;
alter table public.profiles add column if not exists code_attempts integer not null default 0;

-- För- och efternamn som visas i appen i stället för e-posten
alter table public.profiles add column if not exists full_name text;
alter table public.profiles drop constraint if exists profiles_full_name_check;
alter table public.profiles add constraint profiles_full_name_check
  check (full_name is null or char_length(btrim(full_name)) between 2 and 80);

-- "is_member" = har angett rätt inbjudningskod och får använda appen.
-- Första gången kolumnen skapas blir alla befintliga användare medlemmar.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'is_member'
  ) then
    alter table public.profiles add column is_member boolean not null default false;
    insert into public.profiles (user_id, email, is_member)
      select id, email, true from auth.users
      on conflict (user_id) do update set is_member = true, email = excluded.email;
  end if;
end $$;

-- Arter som användarna lagt till själva
create table if not exists public.custom_species (
  id         bigint generated always as identity primary key,
  name       text not null check (char_length(btrim(name)) between 1 and 100),
  category   text not null default 'ovrigt' check (category ~ '^[a-z]{1,30}$'),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists custom_species_name_key
  on public.custom_species (lower(btrim(name)));

-- Riskzoner som admin ritar i appen: bana (2 punkter), taxibana (linje), stängsel (yta)
create table if not exists public.risk_zones (
  id         bigint generated always as identity primary key,
  name       text not null check (char_length(btrim(name)) between 1 and 60),
  zone_type  text not null check (zone_type in ('runway', 'taxiway', 'airside')),
  points     jsonb not null check (jsonb_typeof(points) = 'array' and jsonb_array_length(points) between 2 and 500),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

-- Åtgärder på en rapport (skrämt bort, skrämselskott …). Vissa åtgärder "stänger" risken.
create table if not exists public.report_actions (
  id         bigint generated always as identity primary key,
  report_id  bigint not null references public.reports (id) on delete cascade,
  action     text not null check (action in (
               'bortskramt', 'skramselskott', 'avlivat', 'ej_bekraftat', 'borta',
               'bevakas', 'tornet', 'ovrigt')),
  comment    text check (comment is null or char_length(comment) <= 500),
  created_by uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists report_actions_report_idx on public.report_actions (report_id);

-- Riskinställningar som admin kan ändra i appen (en enda rad, id = 1).
-- Tom config = standardvärdena i risk.js gäller.
create table if not exists public.risk_config (
  id         integer primary key default 1 check (id = 1),
  config     jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);
insert into public.risk_config (id) values (1) on conflict (id) do nothing;

-- Inställningar (t.ex. inbjudningskoden). Bara admins kan läsa.
create table if not exists public.app_settings (
  key   text primary key,
  value text not null
);
-- Startkod (slumpad). Admin kan se och byta den i appen under ⚙️.
insert into public.app_settings (key, value)
  values ('signup_code', 'vilt-' || substr(md5(random()::text || clock_timestamp()::text), 1, 6))
  on conflict (key) do nothing;


-- =============================================================
-- 2. HJÄLPFUNKTIONER
-- =============================================================

-- E-postadresser som automatiskt blir admin
create or replace function public.is_auto_admin_email(address text)
returns boolean language sql immutable set search_path = '' as $$
  select lower(btrim(coalesce(address, ''))) in ('charlie.ledin@swedavia.se');
$$;

create or replace function public.is_member()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select is_member from public.profiles where user_id = auth.uid()), false);
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select is_member and is_admin from public.profiles where user_id = auth.uid()), false);
$$;


-- =============================================================
-- 3. AUTOMATIK (triggers)
-- =============================================================

-- Rapportören sätts alltid av databasen, aldrig av appen
create or replace function public.reports_set_owner()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.user_id        := auth.uid();
    new.reporter_email := coalesce(auth.jwt() ->> 'email', 'okänd');
    new.created_at     := now();
  else
    -- Vid ändring (även av admin) får ägare och skapad-tid inte ändras
    new.user_id        := old.user_id;
    new.reporter_email := old.reporter_email;
    new.created_at     := old.created_at;
  end if;
  -- Bara väder ifyllt i efterhand räknas inte som en ändring av rapporten
  if tg_op = 'UPDATE'
     and (to_jsonb(new) - 'weather' - 'updated_at') = (to_jsonb(old) - 'weather' - 'updated_at') then
    new.updated_at := old.updated_at;
  else
    new.updated_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists reports_set_owner on public.reports;
create trigger reports_set_owner
  before insert or update on public.reports
  for each row execute function public.reports_set_owner();

-- Nytt konto: skapa profil. Rätt kod vid registreringen = medlem direkt.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  code_ok boolean;
begin
  select exists (
    select 1 from public.app_settings
    where key = 'signup_code'
      and lower(value) = lower(btrim(coalesce(new.raw_user_meta_data ->> 'signup_code', '')))
  ) into code_ok;

  insert into public.profiles (user_id, email, full_name, is_member, is_admin)
    values (
      new.id,
      new.email,
      -- Namnet från registreringen (tomt eller för kort/långt = inget namn)
      case when char_length(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', ''))) between 2 and 80
           then btrim(new.raw_user_meta_data ->> 'full_name') end,
      code_ok,
      code_ok and public.is_auto_admin_email(new.email)
    )
    on conflict (user_id) do nothing;
  return new;
end;
$$;

-- Vem som senast ändrade riskinställningarna sätts av databasen
create or replace function public.risk_config_stamp()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists risk_config_stamp on public.risk_config;
create trigger risk_config_stamp
  before update on public.risk_config
  for each row execute function public.risk_config_stamp();

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- =============================================================
-- 4. FUNKTIONER SOM APPEN ANROPAR
-- =============================================================

-- Ange inbjudningskod i efterhand (max 10 felförsök)
create or replace function public.redeem_signup_code(code text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  p public.profiles;
begin
  if auth.uid() is null then return 'wrong'; end if;

  insert into public.profiles (user_id, email)
    select id, email from auth.users where id = auth.uid()
    on conflict (user_id) do nothing;

  select * into p from public.profiles where user_id = auth.uid();
  if p.is_member then return 'ok'; end if;
  if p.code_attempts >= 10 then return 'locked'; end if;

  if exists (
    select 1 from public.app_settings
    where key = 'signup_code' and lower(value) = lower(btrim(coalesce(code, '')))
  ) then
    update public.profiles
      set is_member = true,
          code_attempts = 0,
          is_admin = is_admin or public.is_auto_admin_email(email)
      where user_id = auth.uid();
    return 'ok';
  end if;

  update public.profiles set code_attempts = code_attempts + 1 where user_id = auth.uid();
  return 'wrong';
end;
$$;

-- Admin: byt inbjudningskod
create or replace function public.set_signup_code(new_code text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Bara admin får byta kod'; end if;
  if char_length(btrim(coalesce(new_code, ''))) < 6 then
    raise exception 'Koden måste vara minst 6 tecken';
  end if;
  update public.app_settings set value = btrim(new_code) where key = 'signup_code';
end;
$$;

-- Admin: gör någon till admin eller ta bort admin
-- Fyll i väder på en rapport som saknar det (vilken medlem som helst, bara om det är tomt)
create or replace function public.set_report_weather(p_report_id bigint, p_weather jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_member() then return false; end if;
  if p_weather is null or jsonb_typeof(p_weather) <> 'object' or octet_length(p_weather::text) >= 20000 then
    return false;
  end if;
  update public.reports set weather = p_weather where id = p_report_id and weather is null;
  return found;
end;
$$;

-- Admin: ändra någons namn (vanliga användare ändrar sitt eget direkt i profiles)
create or replace function public.set_full_name(target uuid, new_name text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Bara admin får ändra andras namn'; end if;
  if char_length(btrim(coalesce(new_name, ''))) not between 2 and 80 then
    raise exception 'Namnet måste vara 2–80 tecken';
  end if;
  update public.profiles set full_name = btrim(new_name) where user_id = target;
end;
$$;

create or replace function public.set_admin(target uuid, make_admin boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Bara admin får ändra admin'; end if;
  if target = auth.uid() and not make_admin then
    raise exception 'Du kan inte ta bort din egen admin';
  end if;
  update public.profiles set is_admin = make_admin where user_id = target and is_member;
end;
$$;


-- =============================================================
-- 5. SÄKERHETSREGLER (Row Level Security)
-- =============================================================

alter table public.reports        enable row level security;
alter table public.profiles       enable row level security;
alter table public.custom_species enable row level security;
alter table public.app_settings   enable row level security;
alter table public.risk_zones     enable row level security;
alter table public.report_actions enable row level security;
alter table public.risk_config    enable row level security;

-- Rapporter: medlemmar ser allt och skapar egna. Ägaren eller admin ändrar/tar bort.
drop policy if exists "Inloggade kan läsa alla rapporter" on public.reports;
drop policy if exists "Medlemmar kan läsa alla rapporter" on public.reports;
create policy "Medlemmar kan läsa alla rapporter"
  on public.reports for select to authenticated
  using ((select public.is_member()));

drop policy if exists "Inloggade kan skapa egna rapporter" on public.reports;
drop policy if exists "Medlemmar kan skapa egna rapporter" on public.reports;
create policy "Medlemmar kan skapa egna rapporter"
  on public.reports for insert to authenticated
  with check ((select public.is_member()) and user_id = (select auth.uid()));

drop policy if exists "Man kan ändra sina egna rapporter" on public.reports;
drop policy if exists "Ägare eller admin kan ändra rapporter" on public.reports;
create policy "Ägare eller admin kan ändra rapporter"
  on public.reports for update to authenticated
  using ((select public.is_admin()) or (user_id = (select auth.uid()) and (select public.is_member())))
  with check ((select public.is_admin()) or (user_id = (select auth.uid()) and (select public.is_member())));

drop policy if exists "Man kan ta bort sina egna rapporter" on public.reports;
drop policy if exists "Ägare eller admin kan ta bort rapporter" on public.reports;
create policy "Ägare eller admin kan ta bort rapporter"
  on public.reports for delete to authenticated
  using ((select public.is_admin()) or (user_id = (select auth.uid()) and (select public.is_member())));

-- Profiler: medlemmar ser alla, alla ser sin egen. Man får bara ändra sin färg.
drop policy if exists "Inloggade kan se allas färger" on public.profiles;
drop policy if exists "Medlemmar ser alla profiler" on public.profiles;
create policy "Medlemmar ser alla profiler"
  on public.profiles for select to authenticated
  using ((select public.is_member()) or user_id = (select auth.uid()));

drop policy if exists "Man kan skapa sin egen profil" on public.profiles;

drop policy if exists "Man kan ändra sin egen profil" on public.profiles;
create policy "Man kan ändra sin egen profil"
  on public.profiles for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Egna arter: medlemmar ser och lägger till, admin tar bort
drop policy if exists "Inloggade kan se egna arter" on public.custom_species;
drop policy if exists "Medlemmar ser egna arter" on public.custom_species;
create policy "Medlemmar ser egna arter"
  on public.custom_species for select to authenticated
  using ((select public.is_member()));

drop policy if exists "Inloggade kan lägga till arter" on public.custom_species;
drop policy if exists "Medlemmar kan lägga till arter" on public.custom_species;
create policy "Medlemmar kan lägga till arter"
  on public.custom_species for insert to authenticated
  with check ((select public.is_member()) and created_by = (select auth.uid()));

drop policy if exists "Admin kan ta bort arter" on public.custom_species;
create policy "Admin kan ta bort arter"
  on public.custom_species for delete to authenticated
  using ((select public.is_admin()));

-- Riskzoner: alla medlemmar ser dem, bara admin ritar/ändrar/tar bort
drop policy if exists "Medlemmar ser riskzoner" on public.risk_zones;
create policy "Medlemmar ser riskzoner"
  on public.risk_zones for select to authenticated
  using ((select public.is_member()));

drop policy if exists "Admin skapar riskzoner" on public.risk_zones;
create policy "Admin skapar riskzoner"
  on public.risk_zones for insert to authenticated
  with check ((select public.is_admin()));

drop policy if exists "Admin ändrar riskzoner" on public.risk_zones;
create policy "Admin ändrar riskzoner"
  on public.risk_zones for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists "Admin tar bort riskzoner" on public.risk_zones;
create policy "Admin tar bort riskzoner"
  on public.risk_zones for delete to authenticated
  using ((select public.is_admin()));

-- Riskinställningar: alla medlemmar läser (behövs för att räkna risk), bara admin ändrar
drop policy if exists "Medlemmar läser riskinställningar" on public.risk_config;
create policy "Medlemmar läser riskinställningar"
  on public.risk_config for select to authenticated
  using ((select public.is_member()));

drop policy if exists "Admin ändrar riskinställningar" on public.risk_config;
create policy "Admin ändrar riskinställningar"
  on public.risk_config for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- Åtgärder: medlemmar ser och registrerar. Man tar bort sina egna, admin allas.
drop policy if exists "Medlemmar ser åtgärder" on public.report_actions;
create policy "Medlemmar ser åtgärder"
  on public.report_actions for select to authenticated
  using ((select public.is_member()));

drop policy if exists "Medlemmar registrerar åtgärder" on public.report_actions;
create policy "Medlemmar registrerar åtgärder"
  on public.report_actions for insert to authenticated
  with check ((select public.is_member()) and created_by = (select auth.uid()));

drop policy if exists "Egna eller admin tar bort åtgärder" on public.report_actions;
create policy "Egna eller admin tar bort åtgärder"
  on public.report_actions for delete to authenticated
  using (created_by = (select auth.uid()) or (select public.is_admin()));

-- Inställningar: bara admin kan läsa (ändringar sker via set_signup_code)
drop policy if exists "Admin kan läsa inställningar" on public.app_settings;
create policy "Admin kan läsa inställningar"
  on public.app_settings for select to authenticated
  using ((select public.is_admin()));


-- =============================================================
-- 6. RÄTTIGHETER
-- =============================================================

-- Den som inte är inloggad (anon) får ingen åtkomst alls
revoke all on public.reports, public.profiles, public.custom_species, public.app_settings,
             public.risk_zones, public.report_actions, public.risk_config from anon;
revoke all on public.reports, public.profiles, public.custom_species, public.app_settings,
             public.risk_zones, public.report_actions, public.risk_config from authenticated;

grant select, insert, update, delete on public.reports to authenticated;
grant select on public.profiles to authenticated;
grant update (color, full_name, updated_at) on public.profiles to authenticated;  -- färg och eget namn, inte admin!
grant select, insert, delete on public.custom_species to authenticated;
grant select on public.app_settings to authenticated;
grant select, insert, update, delete on public.risk_zones to authenticated;
grant select on public.risk_config to authenticated;
grant update (config) on public.risk_config to authenticated;  -- bara inställningarna, vem/när sätts automatiskt
grant select, delete on public.report_actions to authenticated;
grant insert (report_id, action, comment) on public.report_actions to authenticated;  -- vem/när sätts automatiskt

revoke execute on function public.redeem_signup_code(text) from public, anon;
revoke execute on function public.set_signup_code(text) from public, anon;
revoke execute on function public.set_admin(uuid, boolean) from public, anon;
revoke execute on function public.set_full_name(uuid, text) from public, anon;
revoke execute on function public.is_member() from public, anon;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.redeem_signup_code(text) to authenticated;
grant execute on function public.set_signup_code(text) to authenticated;
grant execute on function public.set_admin(uuid, boolean) to authenticated;
grant execute on function public.set_full_name(uuid, text) to authenticated;
revoke execute on function public.set_report_weather(bigint, jsonb) from public, anon;
grant execute on function public.set_report_weather(bigint, jsonb) to authenticated;
grant execute on function public.is_member() to authenticated;
grant execute on function public.is_admin() to authenticated;

-- =====================================================================
-- HAIRSTYLES — Schema para Supabase (PostgreSQL 15+)
-- Como usar: SQL Editor do Supabase -> colar e executar em um projeto novo.
-- Substitui o schema SQLite local (users, bookings, booking_services...).
--
-- Principais mudanças em relação à versão SQLite:
--   * Login/senha/recuperação de senha => Supabase Auth (auth.users).
--     Não existe mais tabela de senha, hash bcrypt, JWT próprio nem
--     envio de senha temporária via nodemailer.
--   * Dados do cliente em public.profiles (1:1 com auth.users).
--   * Preços em centavos (integer), nunca float.
--   * Preço, nome e duração do serviço são "congelados" em booking_services.
--   * Total calculado no banco (create_booking), nunca vindo do front.
--   * Conflito de horário impedido por EXCLUDE constraint (sem race condition).
--   * RLS ativa em todas as tabelas.
-- ATENÇÃO: valores marcados com [ASSUMIDO] (durações, horário de
-- funcionamento, regras de antecedência) não vieram do salão — ajuste.
-- =====================================================================

create extension if not exists btree_gist;   -- necessário para o EXCLUDE de horários

-- ---------------------------------------------------------------------
-- 1. TIPOS
-- ---------------------------------------------------------------------
create type public.booking_status as enum
  ('pending', 'confirmed', 'completed', 'cancelled', 'no_show');
create type public.price_type as enum ('fixed', 'starting_at');   -- "a partir de"
create type public.app_role as enum ('staff', 'admin');

-- ---------------------------------------------------------------------
-- 2. FUNÇÕES AUXILIARES
-- ---------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- Validação de CPF (dígitos verificadores). A consulta ao GOV.br, se
-- necessária, continua sendo feita no back-end (Edge Function).
create or replace function public.is_valid_cpf(p text)
returns boolean language plpgsql immutable as $$
declare
  c text := regexp_replace(coalesce(p, ''), '\D', '', 'g');
  d int[]; s int; i int;
begin
  if length(c) <> 11 or c ~ '^(\d)\1{10}$' then return false; end if;
  for i in 1..11 loop d[i] := substr(c, i, 1)::int; end loop;
  s := 0;
  for i in 1..9 loop s := s + d[i] * (11 - i); end loop;
  s := (s * 10) % 11; if s = 10 then s := 0; end if;
  if s <> d[10] then return false; end if;
  s := 0;
  for i in 1..10 loop s := s + d[i] * (12 - i); end loop;
  s := (s * 10) % 11; if s = 10 then s := 0; end if;
  return s = d[11];
end $$;

-- ---------------------------------------------------------------------
-- 3. PAPÉIS (equipe do salão)  — clientes não precisam de linha aqui
-- ---------------------------------------------------------------------
create table public.user_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role    public.app_role not null,
  created_at timestamptz not null default now()
);

create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles where user_id = auth.uid());
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles
                 where user_id = auth.uid() and role = 'admin');
$$;

-- ---------------------------------------------------------------------
-- 4. CLIENTES
-- ---------------------------------------------------------------------
create table public.profiles (
  id                uuid primary key references auth.users(id) on delete cascade,
  full_name         text not null check (char_length(trim(full_name)) >= 3),
  phone             text not null check (phone ~ '^\d{10,11}$'),   -- só dígitos, com DDD
  birth_date        date not null check (birth_date <= current_date and birth_date > date '1900-01-01'),
  cpf               char(11) not null unique check (public.is_valid_cpf(cpf)),
  terms_accepted_at timestamptz not null,
  terms_version     text not null default '1.0',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
comment on column public.profiles.cpf is 'Somente dígitos. Dado pessoal (LGPD): nunca expor a outros clientes.';

create trigger trg_profiles_updated before update on public.profiles
  for each row execute function public.set_updated_at();

-- CPF não pode ser alterado depois do cadastro
create or replace function public.profiles_lock_cpf()
returns trigger language plpgsql as $$
begin
  if new.cpf is distinct from old.cpf then
    raise exception 'O CPF não pode ser alterado.';
  end if;
  return new;
end $$;
create trigger trg_profiles_lock_cpf before update on public.profiles
  for each row execute function public.profiles_lock_cpf();

-- Endereço opcional (1:1)
create table public.client_addresses (
  user_id      uuid primary key references public.profiles(id) on delete cascade,
  zip_code     char(8)  check (zip_code ~ '^\d{8}$'),
  street       text,
  number       text,
  complement   text,
  neighborhood text,
  city         text,
  state        char(2)  check (state ~ '^[A-Z]{2}$'),
  updated_at   timestamptz not null default now()
);
create trigger trg_addresses_updated before update on public.client_addresses
  for each row execute function public.set_updated_at();

-- Cria o profile automaticamente quando alguém se cadastra pelo Supabase Auth.
-- No front: supabase.auth.signUp({ email, password, options: { data: {
--   full_name, phone, birth_date, cpf, terms_accepted: true } } })
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
begin
  if coalesce(m->>'terms_accepted', 'false') <> 'true' then
    raise exception 'É necessário aceitar os termos de uso.';
  end if;
  insert into public.profiles (id, full_name, phone, birth_date, cpf, terms_accepted_at)
  values (
    new.id,
    trim(m->>'full_name'),
    regexp_replace(coalesce(m->>'phone', ''), '\D', '', 'g'),
    (m->>'birth_date')::date,
    regexp_replace(coalesce(m->>'cpf', ''), '\D', '', 'g'),
    now()
  );
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- 5. CATÁLOGO
-- ---------------------------------------------------------------------
create table public.services (
  id                  uuid primary key default gen_random_uuid(),
  slug                text not null unique,
  name                text not null,
  description         text,
  price_cents         integer not null check (price_cents >= 0),
  price_type          public.price_type not null default 'fixed',
  requires_evaluation boolean not null default false,  -- progressiva, mechas
  requires_patch_test boolean not null default false,  -- teste de mechas
  duration_minutes    integer not null check (duration_minutes between 15 and 600),
  image_path          text,                            -- caminho no bucket service-images (1:1)
  is_active           boolean not null default true,
  is_featured         boolean not null default false,  -- fallback p/ "mais populares"
  sort_order          integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create trigger trg_services_updated before update on public.services
  for each row execute function public.set_updated_at();

-- Pacotes (ex.: 4 sessões por R$200)
create table public.service_packages (
  id          uuid primary key default gen_random_uuid(),
  service_id  uuid not null references public.services(id) on delete cascade,
  sessions    integer not null check (sessions > 1),
  price_cents integer not null check (price_cents >= 0),
  is_active   boolean not null default true,
  unique (service_id, sessions)
);

-- ---------------------------------------------------------------------
-- 6. AGENDA
-- ---------------------------------------------------------------------
create table public.professionals (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

-- Configurações únicas do salão (linha id = 1)
create table public.salon_settings (
  id                  smallint primary key default 1 check (id = 1),
  timezone            text    not null default 'America/Recife',
  slot_step_minutes   integer not null default 30  check (slot_step_minutes between 5 and 120), -- [ASSUMIDO]
  min_notice_minutes  integer not null default 120 check (min_notice_minutes >= 0),             -- [ASSUMIDO]
  max_days_ahead      integer not null default 60  check (max_days_ahead > 0),                 -- [ASSUMIDO]
  cancel_limit_hours  integer not null default 12  check (cancel_limit_hours >= 0)              -- [ASSUMIDO]
);

-- Horário de funcionamento por dia da semana (0 = domingo ... 6 = sábado)
create table public.business_hours (
  id        uuid primary key default gen_random_uuid(),
  weekday   smallint not null check (weekday between 0 and 6),
  opens_at  time not null,
  closes_at time not null,
  check (closes_at > opens_at),
  unique (weekday, opens_at)
);

-- Folgas, feriados, ausências (professional_id nulo = salão inteiro fechado)
create table public.time_off (
  id              uuid primary key default gen_random_uuid(),
  professional_id uuid references public.professionals(id) on delete cascade,
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  reason          text,
  check (ends_at > starts_at)
);

create table public.bookings (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references public.profiles(id) on delete cascade,
  professional_id  uuid not null references public.professionals(id),
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  duration_minutes integer not null check (duration_minutes > 0),
  status           public.booking_status not null default 'pending',
  total_cents      integer not null check (total_cents >= 0),
  total_is_estimate boolean not null default false,  -- há "a partir de" ou item sob avaliação
  notes            text check (char_length(notes) <= 500),
  disclaimers_accepted_at timestamptz not null,       -- teste de mechas / valores sujeitos a alteração
  cancelled_at     timestamptz,
  cancel_reason    text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (ends_at > starts_at),
  -- Mesmo profissional não pode ter dois agendamentos ativos sobrepostos
  constraint bookings_no_overlap exclude using gist (
    professional_id with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (status in ('pending', 'confirmed'))
);
create index bookings_client_idx on public.bookings (client_id, starts_at desc);
create index bookings_starts_idx on public.bookings (starts_at);
create trigger trg_bookings_updated before update on public.bookings
  for each row execute function public.set_updated_at();

-- Serviços de cada agendamento (com preço/nome/duração congelados)
create table public.booking_services (
  booking_id       uuid not null references public.bookings(id) on delete cascade,
  service_id       uuid not null references public.services(id),
  service_name     text not null,
  unit_price_cents integer not null check (unit_price_cents >= 0),
  price_type       public.price_type not null,
  duration_minutes integer not null check (duration_minutes > 0),
  primary key (booking_id, service_id)
);
create index booking_services_service_idx on public.booking_services (service_id);

-- ---------------------------------------------------------------------
-- 7. REGRAS DE NEGÓCIO (RPC) — chamadas pelo front via supabase.rpc()
-- ---------------------------------------------------------------------

-- Horários livres de um dia para uma duração total (soma dos serviços).
-- Público: não expõe dados de outros clientes.
create or replace function public.get_available_slots(p_date date, p_duration_minutes integer)
returns table (slot_start timestamptz, slot_end timestamptz)
language sql stable security definer set search_path = public as $$
  with s as (select * from public.salon_settings where id = 1)
  select c.st, c.st + make_interval(mins => p_duration_minutes)
  from s
  join public.business_hours bh on bh.weekday = extract(dow from p_date)::int
  cross join lateral generate_series(
      p_date::timestamp + bh.opens_at,
      (p_date::timestamp + bh.closes_at) - make_interval(mins => p_duration_minutes),
      make_interval(mins => s.slot_step_minutes)
  ) as g(local_start)
  cross join lateral (select g.local_start at time zone s.timezone as st) c
  where p_duration_minutes between 15 and 600
    and c.st >= now() + make_interval(mins => s.min_notice_minutes)
    and c.st <= now() + make_interval(days => s.max_days_ahead)
    and exists (
      select 1 from public.professionals p
      where p.is_active
        and not exists (
          select 1 from public.time_off t
          where (t.professional_id is null or t.professional_id = p.id)
            and t.starts_at < c.st + make_interval(mins => p_duration_minutes)
            and t.ends_at > c.st)
        and not exists (
          select 1 from public.bookings b
          where b.professional_id = p.id
            and b.status in ('pending', 'confirmed')
            and b.starts_at < c.st + make_interval(mins => p_duration_minutes)
            and b.ends_at > c.st)
    )
  order by c.st;
$$;

-- Cria o agendamento: valida tudo e calcula total/duração NO SERVIDOR.
create or replace function public.create_booking(
  p_service_ids uuid[],
  p_starts_at timestamptz,
  p_notes text default null,
  p_disclaimers_accepted boolean default false
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  s public.salon_settings%rowtype;
  v_ids uuid[]; v_count int; v_duration int; v_total int; v_estimate boolean;
  v_end timestamptz; v_local_start timestamp; v_local_end timestamp;
  v_prof uuid; v_id uuid;
begin
  if v_uid is null then raise exception 'Faça login para agendar.' using errcode = '28000'; end if;
  if not coalesce(p_disclaimers_accepted, false) then
    raise exception 'É necessário aceitar os avisos do agendamento.';
  end if;

  select * into s from public.salon_settings where id = 1;
  select array_agg(distinct x) into v_ids from unnest(p_service_ids) x;
  if v_ids is null then raise exception 'Selecione ao menos um serviço.'; end if;

  select count(*), sum(duration_minutes), sum(price_cents),
         bool_or(price_type = 'starting_at' or requires_evaluation)
    into v_count, v_duration, v_total, v_estimate
  from public.services where id = any (v_ids) and is_active;

  if v_count <> cardinality(v_ids) then
    raise exception 'Algum serviço selecionado não está disponível.';
  end if;

  v_end := p_starts_at + make_interval(mins => v_duration);
  v_local_start := p_starts_at at time zone s.timezone;
  v_local_end   := v_end at time zone s.timezone;

  if p_starts_at < now() + make_interval(mins => s.min_notice_minutes)
     or p_starts_at > now() + make_interval(days => s.max_days_ahead) then
    raise exception 'Horário fora da janela permitida para agendamento.';
  end if;

  if (extract(epoch from v_local_start::time)::int / 60) % s.slot_step_minutes <> 0 then
    raise exception 'Horário inválido.';
  end if;

  if not exists (
    select 1 from public.business_hours bh
    where bh.weekday = extract(dow from v_local_start)::int
      and v_local_start::date = v_local_end::date
      and v_local_start::time >= bh.opens_at
      and v_local_end::time <= bh.closes_at
  ) then
    raise exception 'O salão não atende nesse horário.';
  end if;

  select p.id into v_prof
  from public.professionals p
  where p.is_active
    and not exists (select 1 from public.time_off t
        where (t.professional_id is null or t.professional_id = p.id)
          and t.starts_at < v_end and t.ends_at > p_starts_at)
    and not exists (select 1 from public.bookings b
        where b.professional_id = p.id and b.status in ('pending', 'confirmed')
          and b.starts_at < v_end and b.ends_at > p_starts_at)
  order by p.created_at
  limit 1;

  if v_prof is null then raise exception 'Esse horário não está mais disponível.'; end if;

  begin
    insert into public.bookings (client_id, professional_id, starts_at, ends_at,
        duration_minutes, total_cents, total_is_estimate, notes, disclaimers_accepted_at)
    values (v_uid, v_prof, p_starts_at, v_end, v_duration, v_total, v_estimate,
        nullif(trim(p_notes), ''), now())
    returning id into v_id;
  exception when exclusion_violation then
    raise exception 'Esse horário acabou de ser reservado. Escolha outro.';
  end;

  insert into public.booking_services
    (booking_id, service_id, service_name, unit_price_cents, price_type, duration_minutes)
  select v_id, id, name, price_cents, price_type, duration_minutes
  from public.services where id = any (v_ids);

  return v_id;
end $$;

-- Cancelamento pelo cliente (respeita antecedência mínima)
create or replace function public.cancel_booking(p_booking_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare s public.salon_settings%rowtype; n int;
begin
  select * into s from public.salon_settings where id = 1;
  update public.bookings
     set status = 'cancelled', cancelled_at = now(), cancel_reason = nullif(trim(p_reason), '')
   where id = p_booking_id
     and client_id = auth.uid()
     and status in ('pending', 'confirmed')
     and starts_at > now() + make_interval(hours => s.cancel_limit_hours);
  get diagnostics n = row_count;
  if n = 0 then
    raise exception 'Não foi possível cancelar. Verifique o prazo de cancelamento.';
  end if;
end $$;

-- 3 serviços mais agendados (empate/sem histórico => is_featured, sort_order)
create or replace function public.get_popular_services(p_limit integer default 3)
returns setof public.services
language sql stable security definer set search_path = public as $$
  select sv.*
  from public.services sv
  left join (
    select bs.service_id, count(*) as n
    from public.booking_services bs
    join public.bookings b on b.id = bs.booking_id
    where b.status <> 'cancelled'
    group by bs.service_id
  ) c on c.service_id = sv.id
  where sv.is_active
  order by coalesce(c.n, 0) desc, sv.is_featured desc, sv.sort_order
  limit greatest(p_limit, 1);
$$;

-- Permissões das funções
revoke execute on function public.create_booking(uuid[], timestamptz, text, boolean) from public, anon;
revoke execute on function public.cancel_booking(uuid, text) from public, anon;
grant  execute on function public.create_booking(uuid[], timestamptz, text, boolean) to authenticated;
grant  execute on function public.cancel_booking(uuid, text) to authenticated;
grant  execute on function public.get_available_slots(date, integer) to anon, authenticated;
grant  execute on function public.get_popular_services(integer) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 8. ROW LEVEL SECURITY
-- ---------------------------------------------------------------------
alter table public.user_roles       enable row level security;
alter table public.profiles         enable row level security;
alter table public.client_addresses enable row level security;
alter table public.services         enable row level security;
alter table public.service_packages enable row level security;
alter table public.professionals    enable row level security;
alter table public.salon_settings   enable row level security;
alter table public.business_hours   enable row level security;
alter table public.time_off         enable row level security;
alter table public.bookings         enable row level security;
alter table public.booking_services enable row level security;

-- user_roles: cada um vê o seu; só admin gerencia
create policy roles_select on public.user_roles for select
  using (user_id = auth.uid() or public.is_admin());
create policy roles_admin_write on public.user_roles for all
  using (public.is_admin()) with check (public.is_admin());

-- profiles: dono lê/edita; equipe lê (para atender)
create policy profiles_select on public.profiles for select
  using (id = auth.uid() or public.is_staff());
create policy profiles_update on public.profiles for update
  using (id = auth.uid()) with check (id = auth.uid());
-- (INSERT só pelo trigger handle_new_user; DELETE via exclusão da conta no Auth)

create policy addresses_owner on public.client_addresses for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy addresses_staff_read on public.client_addresses for select
  using (public.is_staff());

-- Catálogo e configurações: leitura pública, escrita só admin
create policy services_read on public.services for select
  using (is_active or public.is_staff());
create policy services_admin on public.services for all
  using (public.is_admin()) with check (public.is_admin());

create policy packages_read on public.service_packages for select
  using (is_active or public.is_staff());
create policy packages_admin on public.service_packages for all
  using (public.is_admin()) with check (public.is_admin());

create policy professionals_read on public.professionals for select
  using (is_active or public.is_staff());
create policy professionals_admin on public.professionals for all
  using (public.is_admin()) with check (public.is_admin());

create policy settings_read on public.salon_settings for select using (true);
create policy settings_admin on public.salon_settings for all
  using (public.is_admin()) with check (public.is_admin());

create policy hours_read on public.business_hours for select using (true);
create policy hours_admin on public.business_hours for all
  using (public.is_admin()) with check (public.is_admin());

create policy time_off_staff on public.time_off for all
  using (public.is_staff()) with check (public.is_staff());

-- Agendamentos: cliente vê os seus; equipe vê/atualiza todos.
-- Cliente NÃO insere/atualiza direto: usa create_booking / cancel_booking.
create policy bookings_select on public.bookings for select
  using (client_id = auth.uid() or public.is_staff());
create policy bookings_staff_update on public.bookings for update
  using (public.is_staff()) with check (public.is_staff());

create policy booking_services_select on public.booking_services for select
  using (exists (select 1 from public.bookings b
                 where b.id = booking_id
                   and (b.client_id = auth.uid() or public.is_staff())));

-- ---------------------------------------------------------------------
-- 9. STORAGE (imagens 1:1 dos serviços; leitura pública, escrita admin)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('service-images', 'service-images', true)
on conflict (id) do nothing;

create policy "service images admin write" on storage.objects for all
  using (bucket_id = 'service-images' and public.is_admin())
  with check (bucket_id = 'service-images' and public.is_admin());

-- ---------------------------------------------------------------------
-- 10. DADOS INICIAIS
-- ---------------------------------------------------------------------
insert into public.salon_settings (id) values (1) on conflict do nothing;

insert into public.professionals (name) values ('Equipe Hairstyles');

-- [ASSUMIDO] segunda a sábado, 09:00–19:00; domingo fechado
insert into public.business_hours (weekday, opens_at, closes_at)
select d, time '09:00', time '19:00' from generate_series(1, 6) d;

-- Durações [ASSUMIDAS]; preços conforme tabela do salão
insert into public.services
  (slug, name, price_cents, price_type, requires_evaluation, requires_patch_test,
   duration_minutes, is_featured, sort_order, description) values
  ('corte-feminino',  'Corte feminino',               6000,  'fixed',       false, false,  60, true,  1,  null),
  ('escova',          'Escova',                       4500,  'fixed',       false, false,  45, true,  2,  null),
  ('combo-corte-escova-hidratacao', 'Combo corte + escova + hidratação', 15000, 'fixed', false, false, 150, true, 3, null),
  ('nutricao',        'Nutrição',                     6000,  'fixed',       false, false,  60, false, 4,  null),
  ('hidratacao',      'Hidratação',                   6000,  'fixed',       false, false,  60, false, 5,  null),
  ('reconstrucao',    'Reconstrução',                 8000,  'fixed',       false, false,  60, false, 6,  null),
  ('reconstrucao-escova', 'Reconstrução com escova', 10000,  'fixed',       false, false,  90, false, 7,  null),
  ('reparacao',       'Reparação',                    6000,  'fixed',       false, false,  60, false, 8,  null),
  ('cauterizacao',    'Cauterização',                 8000,  'fixed',       false, false,  90, false, 9,  null),
  ('progressiva',     'Progressiva',                 15000,  'starting_at', true,  false, 180, false, 10, 'Valor a partir de, mediante avaliação.'),
  ('selagem',         'Selagem',                     15000,  'fixed',       false, false, 150, false, 11, null),
  ('botox',           'Botox',                       10000,  'fixed',       false, false, 120, false, 12, null),
  ('mechas',          'Mechas',                      35000,  'starting_at', true,  true,  300, false, 13, 'Valor a partir de, mediante avaliação e teste de mechas.'),
  ('coloracao',       'Coloração (retoque de raiz)',  8000,  'fixed',       false, false,  90, false, 14, null);

insert into public.service_packages (service_id, sessions, price_cents)
select id, 4, v.price from public.services s
join (values ('nutricao', 20000), ('hidratacao', 20000), ('cauterizacao', 28000)) v(slug, price)
  on v.slug = s.slug;

-- ---------------------------------------------------------------------
-- 11. PRIMEIRO ADMIN (executar manualmente após criar a conta do dono)
-- ---------------------------------------------------------------------
-- insert into public.user_roles (user_id, role)
-- select id, 'admin' from auth.users where email = 'DONO@EXEMPLO.COM';

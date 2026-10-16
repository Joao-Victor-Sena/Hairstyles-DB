-- =====================================================================
-- HAIRSTYLES — Migração 2: validações (CHECK) e views de ocultação
-- Executar DEPOIS de 20261012000000_schema_inicial.sql
--
-- Estratégia de "ocultação estrutural":
--   * anon/authenticated NÃO acessam mais as tabelas diretamente.
--   * O front lê apenas VIEWS que expõem só as colunas necessárias
--     (CPF mascarado, sem ids internos, sem flags administrativas).
--   * Escritas do cliente passam por funções (create_booking,
--     cancel_booking, update_my_profile, upsert_my_address).
--   * Painel administrativo/equipe usa a service_role no back-end.
--
-- Observação: as views NÃO usam security_invoker de propósito. Elas rodam
-- com os privilégios do dono (postgres), por isso filtram por auth.uid()
-- / is_staff() dentro da própria definição e usam security_barrier.
-- O linter do Supabase pode avisar "security definer view": é esperado.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. CHECK CONSTRAINTS
-- ---------------------------------------------------------------------

-- profiles ------------------------------------------------------------
alter table public.profiles
  add constraint profiles_full_name_len   check (char_length(full_name) <= 120),
  add constraint profiles_full_name_chars check (full_name !~ '[0-9<>{}\\/@;"=]'),
  add constraint profiles_full_name_two_words check (full_name ~ '\S+\s+\S+'),   -- nome completo
  -- DDD (11–99) + celular (9 dígitos iniciando em 9) ou fixo (8 dígitos iniciando em 2–5)
  add constraint profiles_phone_br check (phone ~ '^[1-9][1-9](9[0-9]{8}|[2-5][0-9]{7})$'),
  add constraint profiles_birth_max_age check (birth_date >= current_date - interval '120 years'),
  add constraint profiles_terms_version_fmt check (terms_version ~ '^[0-9]+(\.[0-9]+)*$'),
  add constraint profiles_cpf_digits check (cpf ~ '^[0-9]{11}$');

-- client_addresses: endereço é opcional, mas se informado deve estar completo
-- (complemento continua opcional)
alter table public.client_addresses
  add constraint addr_street_len  check (char_length(street) <= 120),
  add constraint addr_city_len    check (char_length(city) <= 80),
  add constraint addr_neigh_len   check (char_length(neighborhood) <= 80),
  add constraint addr_compl_len   check (char_length(complement) <= 60),
  add constraint addr_number_fmt  check (number ~* '^([0-9A-Za-z/-]{1,10}|s/n)$'),
  add constraint addr_complete check (
    (zip_code is null and street is null and number is null
       and neighborhood is null and city is null and state is null)
    or
    (zip_code is not null and street is not null and number is not null
       and neighborhood is not null and city is not null and state is not null)
  );

-- services ------------------------------------------------------------
alter table public.services
  add constraint services_slug_fmt   check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  add constraint services_name_len   check (char_length(trim(name)) between 2 and 100),
  add constraint services_desc_len   check (char_length(description) <= 500),
  add constraint services_price_range check (price_cents between 1 and 1000000),   -- até R$ 10.000,00
  add constraint services_image_safe check (image_path is null or image_path !~ '(\.\.|^/|\\)'),
  add constraint services_patch_needs_eval check (not requires_patch_test or requires_evaluation);

alter table public.service_packages
  add constraint packages_price_range check (price_cents between 1 and 1000000),
  add constraint packages_sessions_max check (sessions <= 24);

-- O pacote nunca pode custar mais que as sessões avulsas
create or replace function public.service_packages_validate()
returns trigger language plpgsql as $$
declare v_unit int;
begin
  select price_cents into v_unit from public.services where id = new.service_id;
  if new.price_cents > v_unit * new.sessions then
    raise exception 'O preço do pacote não pode ser maior que % sessões avulsas.', new.sessions;
  end if;
  return new;
end $$;
create trigger trg_packages_validate before insert or update on public.service_packages
  for each row execute function public.service_packages_validate();

-- professionals / settings / agenda -------------------------------------
alter table public.professionals
  add constraint professionals_name_len check (char_length(trim(name)) between 2 and 80);

alter table public.salon_settings
  add constraint settings_tz_fmt   check (timezone ~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+)+$'),
  add constraint settings_step_div check (1440 % slot_step_minutes = 0),
  add constraint settings_notice_max check (min_notice_minutes <= 10080),
  add constraint settings_ahead_max  check (max_days_ahead <= 365),
  add constraint settings_cancel_max check (cancel_limit_hours <= 168);

-- faixas de funcionamento do mesmo dia não podem se sobrepor
alter table public.business_hours
  add constraint business_hours_no_overlap exclude using gist (
    weekday with =,
    tsrange(date '2000-01-01' + opens_at, date '2000-01-01' + closes_at) with &&
  );

alter table public.time_off
  add constraint time_off_reason_len check (char_length(reason) <= 200);

-- bookings --------------------------------------------------------------
alter table public.bookings
  add constraint bookings_end_matches_duration
    check (ends_at = starts_at + make_interval(mins => duration_minutes)),
  add constraint bookings_total_max check (total_cents <= 10000000),
  add constraint bookings_cancel_consistency
    check ((status = 'cancelled') = (cancelled_at is not null)),
  add constraint bookings_cancel_reason_only_cancelled
    check (cancel_reason is null or status = 'cancelled'),
  add constraint bookings_cancel_reason_len check (char_length(cancel_reason) <= 200);

alter table public.booking_services
  add constraint booking_services_name_len check (char_length(service_name) between 2 and 100);

-- ---------------------------------------------------------------------
-- 2. FUNÇÕES DE ESCRITA DO CLIENTE (substituem UPDATE direto)
-- ---------------------------------------------------------------------
create or replace function public.update_my_profile(
  p_full_name text, p_phone text, p_birth_date date
) returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Faça login.' using errcode = '28000'; end if;
  update public.profiles
     set full_name  = trim(p_full_name),
         phone      = regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'),
         birth_date = p_birth_date
   where id = auth.uid();
end $$;

create or replace function public.upsert_my_address(
  p_zip_code text, p_street text, p_number text, p_complement text,
  p_neighborhood text, p_city text, p_state text
) returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Faça login.' using errcode = '28000'; end if;
  insert into public.client_addresses
    (user_id, zip_code, street, number, complement, neighborhood, city, state)
  values (
    auth.uid(),
    nullif(regexp_replace(coalesce(p_zip_code, ''), '\D', '', 'g'), ''),
    nullif(trim(p_street), ''), nullif(trim(p_number), ''), nullif(trim(p_complement), ''),
    nullif(trim(p_neighborhood), ''), nullif(trim(p_city), ''), nullif(upper(trim(p_state)), '')
  )
  on conflict (user_id) do update set
    zip_code = excluded.zip_code, street = excluded.street, number = excluded.number,
    complement = excluded.complement, neighborhood = excluded.neighborhood,
    city = excluded.city, state = excluded.state;
end $$;

-- ---------------------------------------------------------------------
-- 3. VIEWS (única superfície de leitura exposta ao front)
-- ---------------------------------------------------------------------

-- CPF mascarado: ***.456.789-** -> mostra só o miolo
create or replace function public.mask_cpf(p char)
returns text language sql immutable as $$
  select '***.' || substr(p, 4, 3) || '.' || substr(p, 7, 3) || '-**';
$$;

-- Catálogo público (oculta is_active, timestamps)
create view public.v_services with (security_barrier = true) as
  select id, slug, name, description, price_cents, price_type,
         requires_evaluation, requires_patch_test, duration_minutes,
         image_path, is_featured, sort_order
  from public.services
  where is_active;

create view public.v_service_packages with (security_barrier = true) as
  select p.id, p.service_id, p.sessions, p.price_cents
  from public.service_packages p
  join public.services s on s.id = p.service_id
  where p.is_active and s.is_active;

create view public.v_business_hours with (security_barrier = true) as
  select weekday, opens_at, closes_at from public.business_hours;

create view public.v_salon_info with (security_barrier = true) as
  select timezone, slot_step_minutes, min_notice_minutes, max_days_ahead, cancel_limit_hours
  from public.salon_settings where id = 1;

-- Perfil do próprio usuário (CPF mascarado + endereço; sem terms_version etc.)
create view public.v_my_profile with (security_barrier = true) as
  select p.id, p.full_name, p.phone, p.birth_date,
         public.mask_cpf(p.cpf) as cpf_masked,
         a.zip_code, a.street, a.number, a.complement,
         a.neighborhood, a.city, a.state,
         p.terms_accepted_at
  from public.profiles p
  left join public.client_addresses a on a.user_id = p.id
  where p.id = auth.uid();

-- Agendamentos do próprio usuário (sem client_id, professional_id, flags internas)
create view public.v_my_bookings with (security_barrier = true) as
  select b.id, b.starts_at, b.ends_at, b.duration_minutes, b.status,
         b.total_cents, b.total_is_estimate, b.notes, b.cancelled_at,
         (select coalesce(jsonb_agg(jsonb_build_object(
                    'service_id', bs.service_id,
                    'name', bs.service_name,
                    'price_cents', bs.unit_price_cents,
                    'price_type', bs.price_type) order by bs.service_name), '[]'::jsonb)
            from public.booking_services bs where bs.booking_id = b.id) as services
  from public.bookings b
  where b.client_id = auth.uid();

-- Agenda da equipe (staff/admin): cliente com CPF mascarado
create view public.v_staff_agenda with (security_barrier = true) as
  select b.id, b.starts_at, b.ends_at, b.status, b.total_cents, b.total_is_estimate, b.notes,
         pr.name as professional_name,
         c.full_name as client_name, c.phone as client_phone,
         public.mask_cpf(c.cpf) as client_cpf_masked,
         (select string_agg(bs.service_name, ', ' order by bs.service_name)
            from public.booking_services bs where bs.booking_id = b.id) as services
  from public.bookings b
  join public.profiles c on c.id = b.client_id
  join public.professionals pr on pr.id = b.professional_id
  where public.is_staff();

-- "Populares": passa a devolver só colunas públicas (antes devolvia a linha inteira)
drop function if exists public.get_popular_services(integer);
create function public.get_popular_services(p_limit integer default 3)
returns table (id uuid, slug text, name text, description text, price_cents integer,
               price_type public.price_type, image_path text)
language sql stable security definer set search_path = public as $$
  select sv.id, sv.slug, sv.name, sv.description, sv.price_cents, sv.price_type, sv.image_path
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
  limit least(greatest(p_limit, 1), 20);
$$;

-- ---------------------------------------------------------------------
-- 4. FECHAMENTO DO ACESSO DIRETO ÀS TABELAS
-- ---------------------------------------------------------------------
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- Tabelas criadas no futuro também nascem fechadas
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

-- Leitura apenas pelas views
grant select on public.v_services, public.v_service_packages, public.v_business_hours,
                public.v_salon_info to anon, authenticated;
grant select on public.v_my_profile, public.v_my_bookings, public.v_staff_agenda to authenticated;

-- Funções: nada executável por padrão; liberar só o necessário
revoke execute on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

grant execute on function public.get_available_slots(date, integer)             to anon, authenticated;
grant execute on function public.get_popular_services(integer)                  to anon, authenticated;
grant execute on function public.create_booking(uuid[], timestamptz, text, boolean) to authenticated;
grant execute on function public.cancel_booking(uuid, text)                     to authenticated;
grant execute on function public.update_my_profile(text, text, date)            to authenticated;
grant execute on function public.upsert_my_address(text, text, text, text, text, text, text) to authenticated;
-- usadas pelas views/policies enquanto o usuário consulta
grant execute on function public.is_staff(), public.is_admin(), public.mask_cpf(char) to authenticated;

-- Storage: leitura pública das imagens do catálogo continua via bucket público.

-- =====================================================================
-- HAIRSTYLES — Migração 3: modelo de horários fixos do projeto
-- Executar DEPOIS das migrações 1 e 2.
--
-- O projeto original trabalha com horários fixos por dia (09:00, 10:30,
-- 13:30, 15:00 e 16:30), um atendimento por horário, e uma reserva pode
-- ter vários serviços. Esta migração adapta o agendamento a esse modelo:
--   * slot_times: lista de horários do dia (editável pela equipe).
--   * salon_settings.slot_length_minutes: duração de cada horário (90 min).
--   * get_available_slots(data) e create_booking(...) passam a usar esses horários.
--   * v_services ganha price_note (texto de preço, como na vitrine).
--   * v_my_bookings ganha local_date / local_time (data e hora no fuso do salão).
--   * business_hours e v_business_hours saem (o horário vem de slot_times).
-- =====================================================================

-- 1. Configuração -------------------------------------------------------
alter table public.salon_settings
  add column slot_length_minutes integer not null default 90
    check (slot_length_minutes between 15 and 480);
update public.salon_settings set max_days_ahead = 21 where id = 1;   -- mesma janela do projeto original

-- 2. Horários do dia ----------------------------------------------------
create table public.slot_times (
  id         smallint generated always as identity primary key,
  slot_time  time not null unique,
  weekdays   smallint[] not null default '{0,1,2,3,4,5,6}',   -- 0 = domingo ... 6 = sábado
  is_active  boolean not null default true,
  check (cardinality(weekdays) between 1 and 7
         and weekdays <@ array[0,1,2,3,4,5,6]::smallint[])
);
alter table public.slot_times enable row level security;
revoke all on public.slot_times from anon, authenticated;
create policy slot_times_admin on public.slot_times for all
  using (public.is_admin()) with check (public.is_admin());

insert into public.slot_times (slot_time) values
  ('09:00'), ('10:30'), ('13:30'), ('15:00'), ('16:30');

-- 3. Remove o modelo anterior (expediente contínuo) ------------------------
drop view  if exists public.v_business_hours;
drop table if exists public.business_hours;
drop function if exists public.get_available_slots(date, integer);

-- 4. Funções auxiliares de preço -------------------------------------------
create or replace function public.format_brl(c integer)
returns text language sql immutable as $$
  select 'R$ ' || case when c % 100 = 0 then (c / 100)::text
                       else replace(to_char(c / 100.0, 'FM999990.00'), '.', ',') end;
$$;

-- Texto de preço exibido na vitrine: "R$ 60 | Pacote com 4: R$ 200", "A partir de R$ 150"
create or replace function public.service_price_note(p_price integer, p_type public.price_type, p_service uuid)
returns text language sql stable security definer set search_path = public as $$
  select case when p_type = 'starting_at' then 'A partir de ' else '' end
         || public.format_brl(p_price)
         || coalesce((select ' | Pacote com ' || pk.sessions || ': ' || public.format_brl(pk.price_cents)
                        from public.service_packages pk
                       where pk.service_id = p_service and pk.is_active
                       order by pk.sessions limit 1), '');
$$;

-- 5. Views ----------------------------------------------------------------
create or replace view public.v_services with (security_barrier = true) as
  select id, slug, name, description, price_cents, price_type,
         requires_evaluation, requires_patch_test, duration_minutes,
         image_path, is_featured, sort_order,
         public.service_price_note(price_cents, price_type, id) as price_note
  from public.services
  where is_active;

create or replace view public.v_my_bookings with (security_barrier = true) as
  select b.id, b.starts_at, b.ends_at, b.duration_minutes, b.status,
         b.total_cents, b.total_is_estimate, b.notes, b.cancelled_at,
         (select coalesce(jsonb_agg(jsonb_build_object(
                    'service_id', bs.service_id,
                    'name', bs.service_name,
                    'price_cents', bs.unit_price_cents,
                    'price_type', bs.price_type) order by bs.service_name), '[]'::jsonb)
            from public.booking_services bs where bs.booking_id = b.id) as services,
         to_char(b.starts_at at time zone (select timezone from public.salon_settings where id = 1), 'YYYY-MM-DD') as local_date,
         to_char(b.starts_at at time zone (select timezone from public.salon_settings where id = 1), 'HH24:MI')    as local_time
  from public.bookings b
  where b.client_id = auth.uid();

-- 6. Horários livres de um dia ---------------------------------------------
create function public.get_available_slots(p_date date)
returns table (slot_start timestamptz, slot_time text)
language sql stable security definer set search_path = public as $$
  with s as (select * from public.salon_settings where id = 1)
  select c.start_at, to_char(t.slot_time, 'HH24:MI')
  from s
  join public.slot_times t
    on t.is_active and extract(dow from p_date)::int = any (t.weekdays)
  cross join lateral (select (p_date + t.slot_time) at time zone s.timezone as start_at) c
  where c.start_at >= now() + make_interval(mins => s.min_notice_minutes)
    and c.start_at <= now() + make_interval(days => s.max_days_ahead)
    and exists (
      select 1 from public.professionals p
      where p.is_active
        and not exists (
          select 1 from public.time_off o
          where (o.professional_id is null or o.professional_id = p.id)
            and o.starts_at < c.start_at + make_interval(mins => s.slot_length_minutes)
            and o.ends_at   > c.start_at)
        and not exists (
          select 1 from public.bookings b
          where b.professional_id = p.id
            and b.status in ('pending', 'confirmed')
            and b.starts_at < c.start_at + make_interval(mins => s.slot_length_minutes)
            and b.ends_at   > c.start_at)
    )
  order by c.start_at;
$$;

-- 7. Criação do agendamento (valida horário fixo; total sempre no servidor) --
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
  v_ids uuid[]; v_count int; v_total int; v_estimate boolean;
  v_end timestamptz; v_local timestamp;
  v_prof uuid; v_id uuid;
begin
  if v_uid is null then raise exception 'Faça login para agendar.' using errcode = '28000'; end if;
  if not coalesce(p_disclaimers_accepted, false) then
    raise exception 'É necessário aceitar os avisos do agendamento.';
  end if;

  select * into s from public.salon_settings where id = 1;
  select array_agg(distinct x) into v_ids from unnest(p_service_ids) x;
  if v_ids is null then raise exception 'Selecione ao menos um serviço.'; end if;

  select count(*), sum(price_cents), bool_or(price_type = 'starting_at' or requires_evaluation)
    into v_count, v_total, v_estimate
  from public.services where id = any (v_ids) and is_active;

  if v_count <> cardinality(v_ids) then
    raise exception 'Algum serviço selecionado não está disponível.';
  end if;

  v_end   := p_starts_at + make_interval(mins => s.slot_length_minutes);
  v_local := p_starts_at at time zone s.timezone;

  if p_starts_at < now() + make_interval(mins => s.min_notice_minutes)
     or p_starts_at > now() + make_interval(days => s.max_days_ahead) then
    raise exception 'Horário fora da janela permitida para agendamento.';
  end if;

  if not exists (
    select 1 from public.slot_times t
    where t.is_active and t.slot_time = v_local::time
      and extract(dow from v_local)::int = any (t.weekdays)
  ) then
    raise exception 'Horário indisponível.';
  end if;

  select p.id into v_prof
  from public.professionals p
  where p.is_active
    and not exists (select 1 from public.time_off o
        where (o.professional_id is null or o.professional_id = p.id)
          and o.starts_at < v_end and o.ends_at > p_starts_at)
    and not exists (select 1 from public.bookings b
        where b.professional_id = p.id and b.status in ('pending', 'confirmed')
          and b.starts_at < v_end and b.ends_at > p_starts_at)
  order by p.created_at
  limit 1;

  if v_prof is null then raise exception 'Este horário acabou de ser reservado.'; end if;

  begin
    insert into public.bookings (client_id, professional_id, starts_at, ends_at,
        duration_minutes, total_cents, total_is_estimate, notes, disclaimers_accepted_at)
    values (v_uid, v_prof, p_starts_at, v_end, s.slot_length_minutes, v_total, v_estimate,
        nullif(trim(p_notes), ''), now())
    returning id into v_id;
  exception when exclusion_violation then
    raise exception 'Este horário acabou de ser reservado.';
  end;

  insert into public.booking_services
    (booking_id, service_id, service_name, unit_price_cents, price_type, duration_minutes)
  select v_id, id, name, price_cents, price_type, duration_minutes
  from public.services where id = any (v_ids);

  return v_id;
end $$;

-- 8. "Mais populares" com texto de preço -------------------------------------
drop function if exists public.get_popular_services(integer);
create function public.get_popular_services(p_limit integer default 3)
returns table (id uuid, slug text, name text, description text, price_cents integer,
               price_type public.price_type, price_note text, image_path text)
language sql stable security definer set search_path = public as $$
  select sv.id, sv.slug, sv.name, sv.description, sv.price_cents, sv.price_type,
         public.service_price_note(sv.price_cents, sv.price_type, sv.id), sv.image_path
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

-- 9. Permissões --------------------------------------------------------------
grant execute on function public.get_available_slots(date)     to anon, authenticated;
grant execute on function public.get_popular_services(integer) to anon, authenticated;

-- 10. Descrições dos serviços (mesmos textos da vitrine atual) -----------------
update public.services s set description = d.txt
from (values
  ('corte-feminino',      'Corte personalizado e finalização.'),
  ('escova',              'Finalização com movimento e brilho.'),
  ('combo-corte-escova-hidratacao', 'O cuidado completo em uma visita.'),
  ('nutricao',            'Reposição de óleos e nutrientes.'),
  ('hidratacao',          'Tratamento para maciez e luminosidade.'),
  ('reconstrucao',        'Força para fios danificados.'),
  ('reconstrucao-escova', 'Reconstrução com finalização em escova.'),
  ('reparacao',           'Cuidado direcionado para pontas e comprimento.'),
  ('cauterizacao',        'Reposição de massa e selagem.'),
  ('progressiva',         'Alinhamento mediante avaliação.'),
  ('selagem',             'Brilho e alinhamento dos fios.'),
  ('botox',               'Tratamento disciplinante e nutritivo.'),
  ('mechas',              'Iluminação mediante teste de mechas.'),
  ('coloracao',           'Retoque de raiz.')
) as d(slug, txt) where s.slug = d.slug;

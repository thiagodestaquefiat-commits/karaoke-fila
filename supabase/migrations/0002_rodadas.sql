-- =====================================================================
-- Rodadas: quem ainda não cantou tem preferência.
--
-- Cada pedido ganha um número de rodada:
--   1ª música da pessoa na noite  -> round 1
--   2ª música                     -> round 2   ...
-- Um pedido novo entra DEPOIS de todos da mesma rodada (ou menor) e ANTES
-- de quem está numa rodada maior. Ex.: fila = [Ana r1, Bruno r1, Thiago r2];
-- chega a Carla (1ª vez) -> [Ana r1, Bruno r1, Carla r1, Thiago r2].
--
-- A ordem final continua sendo só a coluna position, então quando o DJ
-- reordena na mão, a escolha dele vale.
--
-- Pode rodar este arquivo depois do 0001 (é seguro rodar mais de uma vez).
-- =====================================================================

alter table public.requests
  add column if not exists round int not null default 1;

alter table public.nights
  add column if not exists prefer_new_singers boolean not null default true;

create or replace function public.request_song(
  p_video_id          text,
  p_title             text,
  p_channel           text,
  p_thumbnail_url     text,
  p_duration_seconds  int,
  p_singer_name       text
)
returns public.requests
language plpgsql
security definer
set search_path = public
as $$
declare
  n        public.nights;
  v_count  int;
  v_round  int;
  v_prev   double precision;
  v_next   double precision;
  v_pos    double precision;
  r        public.requests;
begin
  if auth.uid() is null then
    raise exception 'Entre com o Google para pedir uma música.';
  end if;

  select * into n from public.nights where is_active limit 1;
  if n.id is null then
    raise exception 'O karaokê não está acontecendo agora.';
  end if;
  if not n.is_open then
    raise exception 'Os pedidos estão fechados no momento.';
  end if;

  if coalesce(trim(p_singer_name), '') = '' then
    raise exception 'Informe seu nome.';
  end if;
  if p_video_id !~ '^[A-Za-z0-9_-]{11}$' then
    raise exception 'Vídeo inválido.';
  end if;

  -- Só pode ter max_per_user músicas esperando/tocando (padrão 1):
  -- cantou, libera outra. Na noite toda não tem limite.
  select count(*) into v_count
  from public.requests
  where night_id = n.id and user_id = auth.uid() and status in ('queued', 'playing');

  if v_count >= n.max_per_user then
    raise exception 'Você já tem música na fila. Quando cantar, libera outra.';
  end if;

  if exists (
    select 1 from public.requests
    where night_id = n.id and video_id = p_video_id and status in ('queued', 'playing')
  ) then
    raise exception 'Essa versão já está na fila. Escolha outra.';
  end if;

  -- Rodada = quantas músicas a pessoa já cantou (ou tem na fila) + 1.
  select count(*) + 1 into v_round
  from public.requests
  where night_id = n.id and user_id = auth.uid() and status in ('done', 'playing', 'queued');

  if n.prefer_new_singers then
    -- Último da fila com rodada menor ou igual à minha.
    select max(position) into v_prev
    from public.requests
    where night_id = n.id and status = 'queued' and round <= v_round;

    -- Primeiro depois dele (será alguém de rodada maior).
    select min(position) into v_next
    from public.requests
    where night_id = n.id and status = 'queued'
      and position > coalesce(v_prev, '-infinity'::double precision);

    if v_next is null then
      v_pos := coalesce(v_prev, 0) + 1024;            -- vai pro fim
    elsif v_prev is null then
      v_pos := v_next - 1024;                         -- vai pro começo
    else
      v_pos := (v_prev + v_next) / 2;                 -- entra no meio
    end if;
  else
    -- Preferência desligada: ordem de chegada pura.
    select coalesce(max(position), 0) + 1024 into v_pos
    from public.requests
    where night_id = n.id and status = 'queued';
  end if;

  insert into public.requests (
    night_id, user_id, singer_name, video_id, title, channel,
    thumbnail_url, duration_seconds, position, round
  ) values (
    n.id, auth.uid(), left(trim(p_singer_name), 40), p_video_id,
    left(coalesce(p_title, 'Sem título'), 200), left(p_channel, 120),
    p_thumbnail_url,
    greatest(30, least(coalesce(p_duration_seconds, 240), 1200)),
    v_pos, v_round
  )
  returning * into r;

  return r;
end;
$$;

-- DJ liga/desliga a preferência para quem não cantou.
create or replace function public.dj_set_prefer_new(p_value boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_dj();
  update public.nights set prefer_new_singers = coalesce(p_value, true) where is_active;
end;
$$;

revoke execute on function public.request_song(text, text, text, text, int, text) from public, anon;
grant  execute on function public.request_song(text, text, text, text, int, text) to authenticated;
revoke execute on function public.dj_set_prefer_new(boolean) from public, anon;
grant  execute on function public.dj_set_prefer_new(boolean) to authenticated;

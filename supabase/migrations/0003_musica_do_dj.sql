-- =====================================================================
-- Música do DJ: o DJ também canta e pode colocar a música dele
-- na hora que quiser, fora das regras da fila.
--
--   modo 'now'  -> toca agora (se tiver alguém cantando, encerra aquela música)
--   modo 'next' -> entra como a próxima da fila
--
-- Não tem limite, não conta rodada e não bloqueia versão repetida.
-- Pode rodar depois do 0002 (é seguro rodar mais de uma vez).
-- =====================================================================

alter table public.requests
  add column if not exists is_dj_song boolean not null default false;

create or replace function public.dj_add_song(
  p_video_id          text,
  p_title             text,
  p_channel           text,
  p_thumbnail_url     text,
  p_duration_seconds  int,
  p_singer_name       text,
  p_mode              text default 'next'
)
returns public.requests
language plpgsql
security definer
set search_path = public
as $$
declare
  n      public.nights;
  v_pos  double precision;
  r      public.requests;
begin
  perform public.require_dj();

  select * into n from public.nights where is_active limit 1;
  if n.id is null then
    raise exception 'Nenhuma noite ativa. Comece uma noite primeiro.';
  end if;
  if p_video_id !~ '^[A-Za-z0-9_-]{11}$' then
    raise exception 'Vídeo inválido.';
  end if;
  if p_mode not in ('now', 'next') then
    raise exception 'Modo inválido.';
  end if;

  -- Entra na frente de todo mundo da fila.
  select coalesce(min(position), 2048) - 1024 into v_pos
  from public.requests
  where night_id = n.id and status = 'queued';

  insert into public.requests (
    night_id, user_id, singer_name, video_id, title, channel,
    thumbnail_url, duration_seconds, position, round, is_dj_song
  ) values (
    n.id, auth.uid(), left(coalesce(nullif(trim(p_singer_name), ''), 'DJ'), 40), p_video_id,
    left(coalesce(p_title, 'Sem título'), 200), left(p_channel, 120),
    p_thumbnail_url,
    greatest(30, least(coalesce(p_duration_seconds, 240), 1200)),
    v_pos, 0, true
  )
  returning * into r;

  -- "Tocar agora": encerra quem está cantando e já coloca a do DJ no palco.
  if p_mode = 'now' then
    update public.requests
       set status = 'done', finished_at = now()
     where night_id = n.id and status = 'playing';

    update public.requests
       set status = 'playing', started_at = now()
     where id = r.id
    returning * into r;

    update public.nights
       set current_request_id = r.id, current_started_at = now(), paused_at = null
     where id = n.id;
  end if;

  return r;
end;
$$;

-- As músicas do DJ não contam para a rodada de ninguém
-- (caso o DJ também peça pelo app como cliente).
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

  select count(*) into v_count
  from public.requests
  where night_id = n.id and user_id = auth.uid() and status in ('queued', 'playing')
    and not is_dj_song;

  if v_count >= n.max_per_user then
    raise exception 'Você já tem música na fila. Quando cantar, libera outra.';
  end if;

  if exists (
    select 1 from public.requests
    where night_id = n.id and video_id = p_video_id and status in ('queued', 'playing')
  ) then
    raise exception 'Essa versão já está na fila. Escolha outra.';
  end if;

  select count(*) + 1 into v_round
  from public.requests
  where night_id = n.id and user_id = auth.uid() and status in ('done', 'playing', 'queued')
    and not is_dj_song;

  if n.prefer_new_singers then
    select max(position) into v_prev
    from public.requests
    where night_id = n.id and status = 'queued' and round <= v_round;

    select min(position) into v_next
    from public.requests
    where night_id = n.id and status = 'queued'
      and position > coalesce(v_prev, '-infinity'::double precision);

    if v_next is null then
      v_pos := coalesce(v_prev, 0) + 1024;
    elsif v_prev is null then
      v_pos := v_next - 1024;
    else
      v_pos := (v_prev + v_next) / 2;
    end if;
  else
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

revoke execute on function public.dj_add_song(text, text, text, text, int, text, text) from public, anon;
grant  execute on function public.dj_add_song(text, text, text, text, int, text, text) to authenticated;
revoke execute on function public.request_song(text, text, text, text, int, text) from public, anon;
grant  execute on function public.request_song(text, text, text, text, int, text) to authenticated;

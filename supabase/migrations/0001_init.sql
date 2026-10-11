-- =====================================================================
-- Karaokê Fila — estrutura do banco (Supabase / Postgres)
-- Rode este arquivo inteiro no SQL Editor de um projeto Supabase NOVO.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. TABELAS
-- ---------------------------------------------------------------------

-- Perfil de cada pessoa que entra com o Google.
-- role = 'dj' libera o painel do DJ (definido à mão, veja o README).
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url   text,
  role         text not null default 'user' check (role in ('user', 'dj')),
  created_at   timestamptz not null default now()
);

-- Uma "noite" de karaokê. Só pode existir uma ativa por vez.
create table public.nights (
  id                  uuid primary key default gen_random_uuid(),
  title               text not null default 'Karaokê',
  is_active           boolean not null default true,  -- a noite está acontecendo
  is_open             boolean not null default true,  -- aceitando pedidos
  max_per_user        int not null default 1,         -- músicas por pessoa na fila
  gap_seconds         int not null default 75,        -- folga entre uma música e outra
  current_request_id  uuid,                           -- quem está cantando agora
  current_started_at  timestamptz,                    -- quando a música atual começou
  paused_at           timestamptz,                    -- preenchido enquanto está pausado
  created_at          timestamptz not null default now()
);

create unique index nights_one_active on public.nights (is_active) where is_active;

-- Cada pedido de música.
-- position: ordem na fila (número com espaços de 1024 para facilitar reordenar).
create table public.requests (
  id                uuid primary key default gen_random_uuid(),
  night_id          uuid not null references public.nights(id) on delete cascade,
  user_id           uuid not null references auth.users(id) on delete cascade,
  singer_name       text not null,
  video_id          text not null,
  title             text not null,
  channel           text,
  thumbnail_url     text,
  duration_seconds  int not null default 240,
  position          double precision not null,
  status            text not null default 'queued'
                    check (status in ('queued', 'playing', 'done', 'removed')),
  absent_count      int not null default 0,   -- quantas vezes o DJ marcou "não está aqui"
  created_at        timestamptz not null default now(),
  started_at        timestamptz,
  finished_at       timestamptz
);

create index requests_queue_idx on public.requests (night_id, status, position);

alter table public.nights
  add constraint nights_current_request_fk
  foreign key (current_request_id) references public.requests(id) on delete set null;

-- Cache das buscas no YouTube (economiza cota da API).
-- Só a Edge Function (service role) lê e escreve aqui.
create table public.search_cache (
  query_norm  text primary key,
  results     jsonb not null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2. PERFIL AUTOMÁTICO NO PRIMEIRO LOGIN
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name',
             new.raw_user_meta_data->>'name',
             split_part(new.email, '@', 1)),
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- 3. SEGURANÇA (RLS)
-- Leitura: liberada para a fila e a noite (a TV mostra sem login).
-- Escrita: NINGUÉM escreve direto nas tabelas. Tudo passa pelas
-- funções abaixo, que conferem as regras (limite por pessoa, só DJ etc.).
-- ---------------------------------------------------------------------
alter table public.profiles     enable row level security;
alter table public.nights       enable row level security;
alter table public.requests     enable row level security;
alter table public.search_cache enable row level security;

create policy "cada um le o proprio perfil"
  on public.profiles for select
  to authenticated
  using (id = auth.uid());

create policy "todos leem as noites"
  on public.nights for select
  to anon, authenticated
  using (true);

create policy "todos leem a fila"
  on public.requests for select
  to anon, authenticated
  using (true);

-- search_cache: sem políticas = ninguém de fora acessa (só service role).

create or replace function public.is_dj()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'dj');
$$;

-- ---------------------------------------------------------------------
-- 4. FUNÇÕES DO CLIENTE
-- ---------------------------------------------------------------------

-- Pedir uma música. Confere: login, noite aberta, limite por pessoa,
-- vídeo repetido na fila. Entra no fim da fila.
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

  select coalesce(max(position), 0) + 1024 into v_pos
  from public.requests
  where night_id = n.id and status = 'queued';

  insert into public.requests (
    night_id, user_id, singer_name, video_id, title, channel,
    thumbnail_url, duration_seconds, position
  ) values (
    n.id, auth.uid(), left(trim(p_singer_name), 40), p_video_id,
    left(coalesce(p_title, 'Sem título'), 200), left(p_channel, 120),
    p_thumbnail_url,
    greatest(30, least(coalesce(p_duration_seconds, 240), 1200)),
    v_pos
  )
  returning * into r;

  return r;
end;
$$;

-- O próprio cliente pode desistir enquanto ainda está na fila.
create or replace function public.cancel_my_request(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.requests
     set status = 'removed', finished_at = now()
   where id = p_id and user_id = auth.uid() and status = 'queued';
end;
$$;

-- ---------------------------------------------------------------------
-- 5. FUNÇÕES DO DJ
-- ---------------------------------------------------------------------

create or replace function public.require_dj()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_dj() then
    raise exception 'Apenas o DJ pode fazer isso.';
  end if;
end;
$$;

-- Começar uma noite (encerra a anterior, se houver).
create or replace function public.dj_start_night(p_title text default 'Karaokê')
returns public.nights
language plpgsql
security definer
set search_path = public
as $$
declare
  n public.nights;
begin
  perform public.require_dj();
  update public.nights set is_active = false, is_open = false where is_active;
  insert into public.nights (title) values (coalesce(nullif(trim(p_title), ''), 'Karaokê'))
  returning * into n;
  return n;
end;
$$;

create or replace function public.dj_end_night()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_dj();
  update public.nights set is_active = false, is_open = false where is_active;
end;
$$;

-- Abrir/fechar pedidos, folga entre músicas e limite por pessoa.
create or replace function public.dj_update_night(
  p_is_open      boolean default null,
  p_gap_seconds  int default null,
  p_max_per_user int default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_dj();
  update public.nights
     set is_open      = coalesce(p_is_open, is_open),
         gap_seconds  = greatest(0, least(coalesce(p_gap_seconds, gap_seconds), 600)),
         max_per_user = greatest(1, least(coalesce(p_max_per_user, max_per_user), 5))
   where is_active;
end;
$$;

-- Mover um pedido para a posição p_to_index (0 = primeiro da fila).
-- Renumera a fila inteira com espaços de 1024.
create or replace function public.dj_move(p_id uuid, p_to_index int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_night uuid;
  ids     uuid[];
  i       int;
begin
  perform public.require_dj();

  select night_id into v_night
  from public.requests where id = p_id and status = 'queued';
  if v_night is null then
    raise exception 'Esse pedido não está mais na fila.';
  end if;

  select coalesce(array_agg(id order by position, created_at), '{}')
    into ids
  from public.requests
  where night_id = v_night and status = 'queued' and id <> p_id;

  p_to_index := greatest(0, least(coalesce(p_to_index, 0), cardinality(ids)));
  ids := ids[1:p_to_index] || p_id || ids[p_to_index + 1:cardinality(ids)];

  for i in 1 .. cardinality(ids) loop
    update public.requests set position = i * 1024 where id = ids[i];
  end loop;
end;
$$;

-- "Não está aqui": desce 3 posições. Na 2ª vez, sai da fila.
create or replace function public.dj_not_here(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  r     public.requests;
  v_idx int;
begin
  perform public.require_dj();

  select * into r from public.requests where id = p_id and status = 'queued';
  if r.id is null then
    raise exception 'Esse pedido não está mais na fila.';
  end if;

  if r.absent_count >= 1 then
    update public.requests
       set status = 'removed', absent_count = absent_count + 1, finished_at = now()
     where id = p_id;
    return 'removed';
  end if;

  update public.requests set absent_count = absent_count + 1 where id = p_id;

  select count(*) into v_idx
  from public.requests
  where night_id = r.night_id and status = 'queued'
    and (position < r.position or (position = r.position and created_at < r.created_at));

  perform public.dj_move(p_id, v_idx + 3);
  return 'moved';
end;
$$;

create or replace function public.dj_remove(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_dj();
  update public.requests
     set status = 'removed', finished_at = now()
   where id = p_id and status = 'queued';
end;
$$;

-- Próxima: encerra a música atual e coloca o primeiro da fila para cantar.
create or replace function public.dj_next()
returns public.requests
language plpgsql
security definer
set search_path = public
as $$
declare
  n public.nights;
  r public.requests;
begin
  perform public.require_dj();

  select * into n from public.nights where is_active limit 1;
  if n.id is null then
    raise exception 'Nenhuma noite ativa. Comece uma noite primeiro.';
  end if;

  update public.requests
     set status = 'done', finished_at = now()
   where night_id = n.id and status = 'playing';

  select * into r
  from public.requests
  where night_id = n.id and status = 'queued'
  order by position, created_at
  limit 1;

  if r.id is null then
    update public.nights
       set current_request_id = null, current_started_at = null, paused_at = null
     where id = n.id;
    return null;
  end if;

  update public.requests
     set status = 'playing', started_at = now()
   where id = r.id
  returning * into r;

  update public.nights
     set current_request_id = r.id, current_started_at = now(), paused_at = null
   where id = n.id;

  return r;
end;
$$;

-- Pausar / continuar (mantém a estimativa de tempo correta).
create or replace function public.dj_pause(p_paused boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_dj();
  if p_paused then
    update public.nights
       set paused_at = coalesce(paused_at, now())
     where is_active and current_request_id is not null;
  else
    update public.nights
       set current_started_at = current_started_at + (now() - paused_at),
           paused_at = null
     where is_active and paused_at is not null;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 6. PERMISSÕES DAS FUNÇÕES
-- ---------------------------------------------------------------------
revoke execute on function
  public.request_song(text, text, text, text, int, text),
  public.cancel_my_request(uuid),
  public.dj_start_night(text),
  public.dj_end_night(),
  public.dj_update_night(boolean, int, int),
  public.dj_move(uuid, int),
  public.dj_not_here(uuid),
  public.dj_remove(uuid),
  public.dj_next(),
  public.dj_pause(boolean),
  public.require_dj(),
  public.handle_new_user()
from public, anon;

grant execute on function
  public.request_song(text, text, text, text, int, text),
  public.cancel_my_request(uuid),
  public.dj_start_night(text),
  public.dj_end_night(),
  public.dj_update_night(boolean, int, int),
  public.dj_move(uuid, int),
  public.dj_not_here(uuid),
  public.dj_remove(uuid),
  public.dj_next(),
  public.dj_pause(boolean),
  public.is_dj()
to authenticated;

-- ---------------------------------------------------------------------
-- 7. TEMPO REAL (celulares, painel e TV atualizam sozinhos)
-- ---------------------------------------------------------------------
alter publication supabase_realtime add table public.requests, public.nights;

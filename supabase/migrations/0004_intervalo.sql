-- =====================================================================
-- Intervalo do DJ: pausa com música de fundo (banheiro, descanso etc.).
--
-- O DJ escolhe quanto tempo vai durar. Enquanto isso:
--   - a TV mostra "Intervalo · já voltamos"
--   - a estimativa de todo mundo soma o tempo que falta do intervalo
-- A música de fundo toca só no player do DJ (não entra na fila).
-- "Próxima" encerra o intervalo automaticamente.
--
-- Pode rodar depois do 0003 (é seguro rodar mais de uma vez).
-- =====================================================================

alter table public.nights
  add column if not exists break_until timestamptz;

-- p_minutes > 0: começa (ou estende) o intervalo. 0: encerra.
-- Se alguém estiver cantando, a música dessa pessoa é encerrada.
create or replace function public.dj_break(p_minutes int)
returns public.nights
language plpgsql
security definer
set search_path = public
as $$
declare
  n public.nights;
begin
  perform public.require_dj();

  select * into n from public.nights where is_active limit 1;
  if n.id is null then
    raise exception 'Nenhuma noite ativa. Comece uma noite primeiro.';
  end if;

  if coalesce(p_minutes, 0) <= 0 then
    update public.nights set break_until = null where id = n.id
    returning * into n;
    return n;
  end if;

  update public.requests
     set status = 'done', finished_at = now()
   where night_id = n.id and status = 'playing';

  update public.nights
     set break_until = now() + make_interval(mins => least(p_minutes, 120)),
         current_request_id = null, current_started_at = null, paused_at = null
   where id = n.id
  returning * into n;

  return n;
end;
$$;

-- "Próxima" (e "Tocar agora" do DJ) encerram o intervalo.
create or replace function public.clear_break_on_play()
returns trigger
language plpgsql
as $$
begin
  if new.current_request_id is not null
     and new.current_request_id is distinct from old.current_request_id then
    new.break_until := null;
  end if;
  return new;
end;
$$;

drop trigger if exists nights_clear_break on public.nights;
create trigger nights_clear_break
  before update on public.nights
  for each row execute function public.clear_break_on_play();

revoke execute on function public.dj_break(int) from public, anon;
grant  execute on function public.dj_break(int) to authenticated;
revoke execute on function public.clear_break_on_play() from public, anon;

// Cálculo da estimativa de tempo da fila.
// Função pura (sem banco, sem tela) para ser fácil de entender e testar.
//
// Ideia:
//   tempo até a pessoa cantar =
//       o que falta da música atual
//     + duração de cada música na frente dela
//     + uma folga por troca de cantor (gap_seconds)

/**
 * @param {object} p
 * @param {object|null} p.night    linha da tabela nights
 * @param {object|null} p.playing  pedido que está tocando agora (status 'playing')
 * @param {object[]}    p.queue    pedidos na fila (status 'queued'), já em ordem
 * @param {number}      [p.now]    Date.now() (dá para fixar nos testes)
 */
export function computeSchedule({ night, playing, queue, now = Date.now() }) {
  const gapMs = (night?.gap_seconds ?? 75) * 1000;

  // Quanto falta da música atual.
  let remainingCurrentMs = 0;
  if (playing && night?.current_started_at) {
    const started = Date.parse(night.current_started_at);
    const reference = night.paused_at ? Date.parse(night.paused_at) : now;
    const elapsed = Math.max(0, reference - started);
    remainingCurrentMs = Math.max(0, playing.duration_seconds * 1000 - elapsed);
  }

  let cursor = remainingCurrentMs;
  const items = queue.map((req, index) => {
    // Se não tem ninguém cantando, o primeiro da fila é "agora".
    const needsGap = playing || index > 0;
    const startsInMs = cursor + (needsGap ? gapMs : 0);
    cursor = startsInMs + req.duration_seconds * 1000;
    return {
      ...req,
      index,
      startsInMs,
      startsAt: new Date(now + startsInMs),
    };
  });

  return {
    items,
    remainingCurrentMs,
    totalMs: cursor,              // até a última música da fila terminar
    endsAt: new Date(now + cursor),
  };
}

// 74 min -> "1h14" | 14 min -> "14 min" | 40 s -> "menos de 1 min"
export function formatDuration(ms) {
  const totalMin = Math.round(ms / 60000);
  if (ms < 60000) return 'menos de 1 min';
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
}

// "~20 min" | "agora"
export function formatWait(ms) {
  if (ms < 45000) return 'agora';
  return `~${formatDuration(ms)}`;
}

// Date -> "01:40"
export function formatClock(date) {
  return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

// 279 -> "4:39"
export function formatSongLength(seconds) {
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return `${m}:${s}`;
}

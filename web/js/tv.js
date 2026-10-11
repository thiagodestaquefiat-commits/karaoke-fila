// Tela da TV: quem está cantando, próximos 3 com horário e QR code.
// Não precisa de login (só lê a fila).
import { loadState, subscribeToChanges, esc } from './supabase.js';
import { computeSchedule, formatWait, formatClock } from './estimate.js';
import { applyBrand } from './brand.js';

applyBrand();

const $ = (id) => document.getElementById(id);
const state = { night: null, playing: null, queue: [] };

// QR code apontando para a tela do cliente (mesmo site, index.html).
const clientUrl = new URL('index.html', window.location.href).href;
new QRCode($('qr'), { text: clientUrl, width: 512, height: 512, correctLevel: QRCode.CorrectLevel.M });

async function refresh() {
  try {
    Object.assign(state, await loadState());
    render();
  } catch (err) {
    console.error(err);
  }
}

function render() {
  const { night, playing } = state;
  const schedule = computeSchedule(state);

  if (!playing && schedule.onBreak) {
    $('now-singer').textContent = 'Intervalo';
    $('now-song').textContent = `Já voltamos · por volta de ${formatClock(schedule.breakEndsAt)}`;
  } else {
    $('now-singer').textContent = playing ? playing.singer_name : (night ? 'Palco livre' : 'Karaokê');
    $('now-song').textContent = playing ? playing.title : (night ? 'Peça sua música pelo QR code' : 'Já já começa');
  }

  const next = schedule.items.slice(0, 3);
  $('next').innerHTML = next.map((r, i) => `
    <li>
      <span class="n">${i + 1}</span>
      <span class="who">${esc(r.singer_name)}</span>
      <span class="what">${esc(r.title)}</span>
      <span class="when">${i === 0 && !schedule.onBreak ? 'PREPARA!' : formatWait(r.startsInMs)}</span>
    </li>`).join('') || '<li><span class="what">Ninguém na fila ainda. Seja o primeiro!</span></li>';

  const more = schedule.items.length - next.length;
  $('tv-more').textContent = more > 0 ? `+ ${more} na fila` : '';

  $('tv-closed').classList.toggle('hidden', !night || night.is_open);
}

refresh();
subscribeToChanges(refresh);
setInterval(render, 30000);

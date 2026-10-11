// Tela da TV: quem está cantando, próximos 3 com horário e QR code.
// Não precisa de login (só lê a fila).
//
// Aberta como tv.html?player=1 (botão "Abrir TV" do painel), esta janela
// também é o PLAYER: quando alguém canta, mostra só o vídeo do YouTube em
// tela cheia, com o som. O painel do DJ, no mesmo notebook, comanda.
import { loadState, subscribeToChanges, esc, DEMO } from './supabase.js';
import { openTvLink } from './tvlink.js';
import { computeSchedule, formatWait } from './estimate.js';
import { applyBrand } from './brand.js';

applyBrand();

const $ = (id) => document.getElementById(id);
const state = { night: null, playing: null, queue: [] };

// QR code apontando para a tela do cliente (mesmo site, index.html).
const clientUrl = new URL('index.html', window.location.href).href;
// Se a biblioteca do QR não carregar (sem internet), a TV continua funcionando.
if (window.QRCode) {
  new QRCode($('qr'), { text: clientUrl, width: 512, height: 512, correctLevel: QRCode.CorrectLevel.M });
} else {
  $('qr').textContent = clientUrl;
  $('qr').classList.add('qr-fallback');
}

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

  $('now-singer').textContent = playing ? playing.singer_name : (night ? 'Palco livre' : 'Karaokê');
  $('now-song').textContent = playing ? playing.title : (night ? 'Peça sua música pelo QR code' : 'Já já começa');

  const next = schedule.items.slice(0, 3);
  $('next').innerHTML = next.map((r, i) => `
    <li>
      <span class="n">${i + 1}</span>
      <span class="who">${esc(r.singer_name)}</span>
      <span class="what">${esc(r.title)}</span>
      <span class="when">${i === 0 ? 'PREPARA!' : formatWait(r.startsInMs)}</span>
    </li>`).join('') || '<li><span class="what">Ninguém na fila ainda. Seja o primeiro!</span></li>';

  const more = schedule.items.length - next.length;
  $('tv-more').textContent = more > 0 ? `+ ${more} na fila` : '';

  $('tv-closed').classList.toggle('hidden', !night || night.is_open);
}

refresh();
subscribeToChanges(refresh);
setInterval(render, 30000);

// =====================================================================
// TV como player do vídeo (tv.html?player=1)
// =====================================================================
const isPlayer = new URLSearchParams(location.search).has('player');

let yt = null;           // YT.Player
let ytReady = false;
let activated = DEMO;    // o navegador só libera som depois de um clique
let current = null;      // vídeo carregado agora { videoId, title, duration }
let pending = null;      // comando que chegou antes de poder tocar
const fake = { playing: false, time: 0 }; // modo demo: vídeo de mentira

const link = isPlayer ? openTvLink(onCommand) : null;

if (isPlayer) {
  link.post({ type: 'tv-hello' });
  setInterval(() => link.post({ type: 'tv-hello' }), 2000);
  if (!activated) $('tv-activate').classList.remove('hidden');
  setInterval(reportProgress, 1000);
}

$('btn-activate').onclick = async () => {
  activated = true;
  $('tv-activate').classList.add('hidden');
  try { await document.documentElement.requestFullscreen(); } catch (_) { /* F11 resolve */ }
  if (pending) onCommand(pending);
};

window.onYouTubeIframeAPIReady = () => {
  if (!isPlayer || yt || DEMO) return;
  yt = new YT.Player('tv-player', {
    playerVars: { rel: 0, modestbranding: 1, playsinline: 1, controls: 0, disablekb: 1, iv_load_policy: 3 },
    events: {
      onReady: () => { ytReady = true; if (pending) onCommand(pending); },
      onStateChange: (e) => {
        const map = { 0: 'ended', 1: 'playing', 2: 'paused' };
        const st = map[e.data];
        if (!st) return;
        if (st === 'ended') showVideo(false);
        if (st === 'playing') showVideo(true);
        link.post({ type: 'tv-state', state: st });
      },
      onError: () => link.post({ type: 'tv-error' }),
    },
  });
};
if (window.YT?.Player) window.onYouTubeIframeAPIReady();

function showVideo(on) {
  $('tv-video').classList.toggle('hidden', !on);
}

function onCommand(m) {
  switch (m.type) {
    case 'who':
      link.post({ type: 'tv-hello' });
      break;

    case 'load':
      // Ainda sem clique para liberar o som, ou player carregando: guarda para depois.
      if (!activated || (!DEMO && !ytReady)) {
        pending = m;
        if (!activated) $('tv-activate').classList.remove('hidden');
        return;
      }
      pending = null;
      current = { videoId: m.videoId, title: m.title || '', duration: m.duration || 0 };
      // Só vai para a tela cheia quando o vídeo começa a tocar.
      showVideo(!!m.autoplay);
      if (DEMO) {
        fake.time = m.start || 0;
        fake.playing = !!m.autoplay;
        renderFake();
        link.post({ type: 'tv-state', state: fake.playing ? 'playing' : 'paused' });
      } else if (m.autoplay) {
        yt.loadVideoById({ videoId: m.videoId, startSeconds: m.start || 0 });
      } else {
        yt.cueVideoById({ videoId: m.videoId, startSeconds: m.start || 0 });
      }
      break;

    case 'play':
      if (!current) return;
      showVideo(true);
      if (DEMO) { fake.playing = true; renderFake(); link.post({ type: 'tv-state', state: 'playing' }); }
      else yt?.playVideo();
      break;

    case 'pause':
      if (DEMO) { fake.playing = false; renderFake(); link.post({ type: 'tv-state', state: 'paused' }); }
      else yt?.pauseVideo();
      break;

    case 'restart':
      if (!current) return;
      showVideo(true);
      if (DEMO) { fake.time = 0; fake.playing = true; renderFake(); }
      else { yt?.seekTo(0, true); yt?.playVideo(); }
      break;

    case 'stop':
      pending = null;
      current = null;
      fake.playing = false;
      if (!DEMO) yt?.stopVideo();
      showVideo(false);
      break;
  }
}

// Conta para o painel em que ponto está o vídeo (barra de andamento do DJ).
function reportProgress() {
  if (!current) return;
  if (DEMO) {
    const dur = current.duration || 240;
    if (fake.playing) {
      fake.time += 1;
      if (fake.time >= dur) {
        fake.playing = false;
        showVideo(false);
        link.post({ type: 'tv-state', state: 'ended' });
        return;
      }
    }
    if (!$('tv-video').classList.contains('hidden')) renderFake();
    link.post({ type: 'tv-progress', time: fake.time, duration: dur });
  } else if (ytReady && yt.getDuration) {
    link.post({ type: 'tv-progress', time: yt.getCurrentTime() || 0, duration: yt.getDuration() || 0 });
  }
}

function renderFake() {
  const box = $('tv-fake');
  box.classList.remove('hidden');
  const dur = current?.duration || 240;
  const pct = Math.min(100, (fake.time / dur) * 100);
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  box.innerHTML = `
    <span class="fake-label">MODO DEMONSTRAÇÃO · AQUI O VÍDEO DO YOUTUBE OCUPA A TV INTEIRA</span>
    <span class="fake-title">${esc(current?.title || '')}</span>
    <span class="fake-bar"><span style="width:${pct}%"></span></span>
    <span class="fake-time">${fake.playing ? '' : 'Pausado · '}${mmss(fake.time)} / ${mmss(dur)}</span>`;
}

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

let yt = null;           // YT.Player (criado só na hora de tocar, já visível)
let ytReady = false;
let ytVideoId = null;    // vídeo carregado no player agora
let wanted = null;       // vídeo esperando o player do YouTube ficar pronto
let watchdog = null;     // confere se o vídeo começou mesmo
let activated = DEMO;    // o navegador só libera som depois de um clique
let current = null;      // vídeo da vez { videoId, title, duration }
let pending = null;      // comando que chegou antes do clique de liberar o som
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
  if (pending) { const m = pending; pending = null; onCommand(m); }
};

function showVideo(on) {
  $('tv-video').classList.toggle('hidden', !on);
}

function showLoading(text) {
  const el = $('tv-loading');
  el.textContent = text || '';
  el.classList.toggle('hidden', !text);
}

function reportError(message) {
  console.error('[TV]', message);
  link?.post({ type: 'tv-error', message });
}

// Toca um vídeo na TV. O player do YouTube é criado na primeira vez, já com a
// área do vídeo VISÍVEL (criado escondido, ele pode nunca ficar pronto).
function playVideo(video, start = 0) {
  showVideo(true);
  showLoading('Carregando vídeo…');
  clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    if (!yt || !ytReady) {
      reportError('O player do YouTube não carregou na janela da TV. Recarregue a janela da TV (F5).');
      showLoading('Não foi possível carregar o player do YouTube. Recarregue esta janela (F5).');
    } else if (yt.getPlayerState?.() !== 1) {
      reportError('O vídeo não começou na TV. Clique uma vez na janela da TV e aperte Próxima de novo, ou escolha outra versão.');
      showLoading('O vídeo não começou. Clique nesta janela uma vez.');
    }
  }, 12000);

  if (yt && ytReady) {
    ytVideoId = video.videoId;
    yt.loadVideoById({ videoId: video.videoId, startSeconds: start });
    return;
  }
  wanted = { videoId: video.videoId, start };
  if (!yt && window.YT?.Player) createPlayer();
  // Se a API do YouTube ainda não chegou, onYouTubeIframeAPIReady cria o player.
}

function createPlayer() {
  if (yt || !wanted) return;
  const first = wanted;
  ytVideoId = first.videoId;
  yt = new YT.Player('tv-player', {
    videoId: first.videoId,
    playerVars: {
      autoplay: 1, start: Math.floor(first.start || 0),
      rel: 0, modestbranding: 1, playsinline: 1, controls: 0, disablekb: 1, iv_load_policy: 3,
    },
    events: {
      onReady: (e) => {
        ytReady = true;
        // Pode ter chegado outro pedido enquanto o player carregava.
        if (wanted && wanted.videoId !== first.videoId) {
          ytVideoId = wanted.videoId;
          e.target.loadVideoById({ videoId: wanted.videoId, startSeconds: wanted.start });
        } else {
          e.target.playVideo();
        }
        wanted = null;
      },
      onStateChange: (e) => {
        const map = { 0: 'ended', 1: 'playing', 2: 'paused' };
        const st = map[e.data];
        if (!st) return;
        if (st === 'playing') { showLoading(''); clearTimeout(watchdog); showVideo(true); }
        if (st === 'ended') showVideo(false);
        link.post({ type: 'tv-state', state: st });
      },
      onError: (e) => {
        clearTimeout(watchdog);
        const msg = [101, 150].includes(e.data)
          ? 'O dono desse vídeo não deixa ele tocar fora do YouTube. Aperte Próxima ou escolha outra versão.'
          : 'Esse vídeo não pôde tocar na TV. Aperte Próxima ou escolha outra versão.';
        reportError(msg);
        showLoading('');
        showVideo(false);
      },
    },
  });
}

window.onYouTubeIframeAPIReady = () => {
  if (!isPlayer || DEMO) return;
  if (wanted) createPlayer();
};
if (window.YT?.Player && wanted) createPlayer();

function onCommand(m) {
  switch (m.type) {
    case 'who':
      link.post({ type: 'tv-hello' });
      break;

    case 'load':
      // Ainda sem o clique que libera o som: guarda para depois.
      if (!activated) {
        pending = m;
        $('tv-activate').classList.remove('hidden');
        return;
      }
      current = { videoId: m.videoId, title: m.title || '', duration: m.duration || 0 };
      if (DEMO) {
        showVideo(!!m.autoplay);
        fake.time = m.start || 0;
        fake.playing = !!m.autoplay;
        renderFake();
        link.post({ type: 'tv-state', state: fake.playing ? 'playing' : 'paused' });
      } else if (m.autoplay) {
        playVideo(current, m.start || 0);
      } else {
        // Só "deixar pronto": a TV continua mostrando a fila até o DJ dar play.
        current.start = m.start || 0;
        showVideo(false);
      }
      break;

    case 'play':
      if (!current) return;
      if (DEMO) { showVideo(true); fake.playing = true; renderFake(); link.post({ type: 'tv-state', state: 'playing' }); }
      else if (yt && ytReady && ytVideoId === current.videoId) { showVideo(true); yt.playVideo(); }
      else playVideo(current, current.start || 0);
      break;

    case 'pause':
      if (DEMO) { fake.playing = false; renderFake(); link.post({ type: 'tv-state', state: 'paused' }); }
      else yt?.pauseVideo?.();
      break;

    case 'restart':
      if (!current) return;
      if (DEMO) { showVideo(true); fake.time = 0; fake.playing = true; renderFake(); }
      else if (yt && ytReady && ytVideoId === current.videoId) { showVideo(true); yt.seekTo(0, true); yt.playVideo(); }
      else playVideo(current, 0);
      break;

    case 'stop':
      pending = null;
      current = null;
      wanted = null;
      fake.playing = false;
      clearTimeout(watchdog);
      showLoading('');
      if (!DEMO) yt?.stopVideo?.();
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
  } else if (ytReady && yt?.getDuration && ytVideoId === current.videoId) {
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

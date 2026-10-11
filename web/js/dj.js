// Painel do DJ: player do YouTube, fila com horários, reordenar,
// "não está aqui", abrir/fechar pedidos.
import {
  supabase, getUser, getMyProfile, signInWithGoogle, signOut,
  loadState, subscribeToChanges, rpc, esc, toast, searchYouTube,
  DEMO, ask,
} from './supabase.js';
import { computeSchedule, formatDuration, formatWait, formatClock, formatSongLength } from './estimate.js';
import { applyBrand } from './brand.js';
import { openTvLink } from './tvlink.js';

const $ = (id) => document.getElementById(id);
const SCREENS = ['screen-loading', 'screen-login', 'screen-not-dj', 'screen-no-night', 'screen-panel'];

const state = {
  night: null,
  playing: null,
  queue: [],
  schedule: null,
  busy: false,
};

let player = null;          // YT.Player
let playerReady = false;
let loadedRequestId = null; // qual pedido está carregado no player
let autoplayNext = false;   // true quando o DJ apertou "Próxima"
let freeVideoId = null;      // "Tocar livre": vídeo tocando só no player do DJ

applyBrand();

function show(id) {
  SCREENS.forEach((s) => $(s).classList.toggle('hidden', s !== id));
}

// ---------------------------------------------------------------
// Início
// ---------------------------------------------------------------
let booted = false;

async function init() {
  if (booted) return;
  const user = await getUser();
  if (!user) { show('screen-login'); return; }
  if (booted) return;
  booted = true;

  const profile = await getMyProfile();
  if (profile?.role !== 'dj') {
    $('not-dj-email').textContent = user.email;
    show('screen-not-dj');
    return;
  }

  await refresh();
  subscribeToChanges(refresh);
  setInterval(renderNow, 1000);      // contagem "faltam 2:31"
  setInterval(renderQueue, 30000);   // horários da fila
  keepScreenOn();
}

supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_IN') init();
});

async function refresh() {
  try {
    const s = await loadState();
    Object.assign(state, s);
    if (!state.night) { show('screen-no-night'); return; }
    show('screen-panel');
    render();
    syncPlayer();
  } catch (err) {
    console.error(err);
    toast('Sem conexão com o banco. Tentando de novo…', 'error');
  }
}

// ---------------------------------------------------------------
// Renderização
// ---------------------------------------------------------------
function render() {
  const { night } = state;
  $('night-title-label').textContent = night.title;

  const open = $('btn-toggle-open');
  open.textContent = night.is_open ? 'Pedidos abertos' : 'Pedidos fechados';
  open.setAttribute('aria-pressed', String(night.is_open));

  $('gap').value = String(night.gap_seconds);
  $('max-per-user').value = String(night.max_per_user);
  $('prefer-new').checked = night.prefer_new_singers !== false;

  renderNow();
  renderQueue();
}

function currentSchedule() {
  return computeSchedule({ night: state.night, playing: state.playing, queue: state.queue });
}

// Bloco "cantando agora" + estatísticas do topo (roda a cada segundo).
function renderNow() {
  if (!state.night) return;
  const schedule = currentSchedule();
  const p = state.playing;

  $('now-singer').textContent = p ? p.singer_name : '—';
  $('now-song').textContent = p ? `${p.title} · ${formatSongLength(p.duration_seconds)}` : 'Ninguém no palco';
  renderTvArea();
  $('player-empty').classList.toggle('hidden', tv.connected || (!DEMO && (!!p || !!freeVideoId)));
  if (DEMO && !tv.connected) {
    $('player-empty').innerHTML = freeVideoId
      ? `<span>Modo demonstração<br><strong>Tocando livre: ${esc($('free-title-now').textContent)}</strong></span>`
      : p
        ? `<span>Modo demonstração: aqui toca o vídeo do YouTube<br><strong>${esc(p.title)}</strong></span>`
        : '<span>Nada tocando. Toque em <strong>Próxima</strong> para chamar o primeiro da fila.</span>';
  }

  if (p) {
    const secs = Math.round(schedule.remainingCurrentMs / 1000);
    const left = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    $('now-left').textContent = state.night.paused_at ? `Pausado · faltam ${left}` : `Faltam ${left}`;
  } else {
    $('now-left').textContent = '';
  }
  $('btn-pause').disabled = !p;
  $('btn-pause').textContent = state.night.paused_at ? 'Continuar' : 'Pausar';

  $('stat-count').textContent = String(state.queue.length);
  $('stat-total').textContent = formatDuration(schedule.totalMs);
  $('stat-end').textContent = formatClock(schedule.endsAt);

  const first = schedule.items[0];
  const upNext = $('up-next');
  upNext.classList.toggle('hidden', !first);
  if (first) {
    upNext.innerHTML = `
      <span class="eyebrow">PRÓXIMO · ${formatWait(first.startsInMs)}</span>
      <strong>${esc(first.singer_name)}</strong>
      <span class="muted">${esc(first.title)}</span>`;
  }
}

function renderQueue() {
  if (!state.night) return;
  const schedule = currentSchedule();
  const last = schedule.items.length - 1;

  $('queue').innerHTML = schedule.items.map((r) => `
    <li class="row q-row" data-id="${r.id}">
      <span class="pos">${r.index + 1}</span>
      <span class="grow">
        <span class="name-line">
          <span class="title">${esc(r.singer_name)}</span>
          <span class="badge round ${r.round > 1 ? '' : 'first'}">${r.round > 1 ? `${r.round}ª música` : '1ª vez'}</span>
        </span>
        <span class="sub">${esc(r.title)} · ${formatSongLength(r.duration_seconds)}</span>
        ${r.absent_count > 0 ? '<span class="sub absent">Já foi chamado e não estava</span>' : ''}
      </span>
      <span class="eta">
        <strong>${formatClock(r.startsAt)}</strong>
        <span class="muted">${formatWait(r.startsInMs)}</span>
      </span>
      <span class="tools">
        <button class="btn-icon" type="button" data-act="up" title="Subir uma posição" aria-label="Subir ${esc(r.singer_name)}" ${r.index === 0 ? 'disabled' : ''}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>
        </button>
        <button class="btn-icon" type="button" data-act="down" title="Descer uma posição" aria-label="Descer ${esc(r.singer_name)}" ${r.index === last ? 'disabled' : ''}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
        </button>
        <button class="btn-icon" type="button" data-act="top" title="Mandar para o topo" aria-label="Mandar ${esc(r.singer_name)} para o topo" ${r.index === 0 ? 'disabled' : ''}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4h12M12 20V9M7 14l5-5 5 5"/></svg>
        </button>
        <button class="btn-icon" type="button" data-act="bottom" title="Mandar para o fim" aria-label="Mandar ${esc(r.singer_name)} para o fim" ${r.index === last ? 'disabled' : ''}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 20h12M12 4v11M7 10l5 5 5-5"/></svg>
        </button>
        <button class="btn-text warn" type="button" data-act="absent" title="Desce 3 posições. Na segunda vez, sai da fila.">Não está aqui</button>
        <button class="btn-icon danger" type="button" data-act="remove" title="Remover da fila" aria-label="Remover ${esc(r.singer_name)}">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </span>
    </li>`).join('') || '<li class="muted">Fila vazia. Bora chamar alguém pro palco.</li>';
}

// ---------------------------------------------------------------
// Ações da fila
// ---------------------------------------------------------------
async function run(fn, okMessage) {
  if (state.busy) return;
  state.busy = true;
  try {
    const result = await fn();
    if (okMessage) toast(typeof okMessage === 'function' ? okMessage(result) : okMessage);
    await refresh();
    return result;
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    state.busy = false;
  }
}

$('queue').onclick = (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn || btn.disabled) return;
  const id = btn.closest('[data-id]').dataset.id;
  const index = state.queue.findIndex((r) => r.id === id);
  const req = state.queue[index];

  switch (btn.dataset.act) {
    case 'up':     run(() => rpc('dj_move', { p_id: id, p_to_index: index - 1 })); break;
    case 'down':   run(() => rpc('dj_move', { p_id: id, p_to_index: index + 1 })); break;
    case 'top':    run(() => rpc('dj_move', { p_id: id, p_to_index: 0 })); break;
    case 'bottom': run(() => rpc('dj_move', { p_id: id, p_to_index: state.queue.length - 1 })); break;
    case 'absent':
      run(() => rpc('dj_not_here', { p_id: id }), (res) =>
        res === 'removed'
          ? `${req.singer_name} não apareceu de novo e saiu da fila.`
          : `${req.singer_name} desceu 3 posições.`);
      break;
    case 'remove':
      if (ask(`Remover ${req.singer_name} (${req.title}) da fila?`)) {
        run(() => rpc('dj_remove', { p_id: id }), 'Removido da fila.');
      }
      break;
  }
};

$('btn-next').onclick = () => {
  $('btn-next').classList.remove('pulse');
  stopFree(false);
  autoplayNext = true;
  run(() => rpc('dj_next'), (r) => (r?.id ? `Chamando ${r.singer_name}` : 'A fila acabou.'));
};

$('btn-pause').onclick = () => {
  if (freeVideoId) return;
  if (DEMO && !tv.connected && state.playing) { // demo sem TV: sem player, avisa o banco direto
    run(() => rpc('dj_pause', { p_paused: !state.night.paused_at }));
    return;
  }
  // O player (da TV ou daqui) avisa o estado de volta e isso atualiza o banco.
  if (state.night.paused_at) out.play();
  else out.pause();
};

$('btn-toggle-open').onclick = () =>
  run(() => rpc('dj_update_night', { p_is_open: !state.night.is_open }),
    state.night.is_open ? 'Pedidos fechados.' : 'Pedidos abertos.');

$('gap').onchange = (e) =>
  run(() => rpc('dj_update_night', { p_gap_seconds: Number(e.target.value) }), 'Folga atualizada.');

$('max-per-user').onchange = (e) =>
  run(() => rpc('dj_update_night', { p_max_per_user: Number(e.target.value) }), 'Limite atualizado.');

$('prefer-new').onchange = (e) =>
  run(() => rpc('dj_set_prefer_new', { p_value: e.target.checked }),
    e.target.checked ? 'Quem não cantou passa na frente.' : 'Ordem de chegada pura.');

$('btn-settings').onclick = () => {
  const box = $('settings');
  box.classList.toggle('hidden');
  $('btn-settings').setAttribute('aria-expanded', String(!box.classList.contains('hidden')));
};

$('btn-start-night').onclick = () =>
  run(() => rpc('dj_start_night', { p_title: $('night-title').value }), 'Noite começou!');

$('btn-end-night').onclick = () => {
  if (!ask('Encerrar a noite? A fila atual será fechada.')) return;
  run(() => rpc('dj_end_night'), 'Noite encerrada.');
};

// ---------------------------------------------------------------
// Tocar livre: o DJ toca o que quiser, quando quiser.
// Vai para a TV em tela cheia (ou para o player do painel, sem TV).
// Não grava nada no banco, não mexe na fila e não aparece no
// celular dos clientes.
// ---------------------------------------------------------------
let freeResults = [];
let freeVideo = null; // { videoId, title, duration } do Tocar livre

$('free-form').onsubmit = async (e) => {
  e.preventDefault();
  const q = $('free-input').value.trim();
  if (q.length < 2) return;
  $('free-hint').textContent = 'Buscando…';
  $('free-results').innerHTML = '';
  try {
    freeResults = await searchYouTube(q, $('free-kind').value);
    $('free-hint').textContent = freeResults.length ? '' : 'Nada encontrado. Tente outro termo.';
    $('free-results').innerHTML = freeResults.map((r, i) => `
      <li class="row free-result" data-index="${i}">
        <img class="thumb" src="${esc(r.thumbnail)}" alt="" loading="lazy">
        <span class="grow">
          <span class="title">${esc(r.title)}</span>
          <span class="sub">${esc(r.channel)} · ${formatDuration(r.durationSeconds * 1000)}</span>
        </span>
        <button class="btn btn-primary" type="button">Tocar agora</button>
      </li>`).join('');
  } catch (err) {
    $('free-hint').textContent = err.message;
  }
};

$('free-results').onclick = (e) => {
  const btn = e.target.closest('button');
  if (!btn || !out.available()) return;
  const r = freeResults[Number(btn.closest('[data-index]').dataset.index)];
  freeVideoId = r.videoId;
  freeVideo = { videoId: r.videoId, title: r.title, duration: r.durationSeconds };
  out.load(freeVideo, true);
  $('free-title-now').textContent = r.title;
  $('free-playing').classList.remove('hidden');
  $('free-results').innerHTML = '';
  $('free-input').value = '';
  renderNow();
};

// Sai do modo livre. reloadQueue: volta a carregar quem está no palco (sem dar play).
function stopFree(reloadQueue = true) {
  if (!freeVideoId) return;
  freeVideoId = null;
  freeVideo = null;
  $('free-playing').classList.add('hidden');
  out.stop();
  loadedRequestId = null;
  if (reloadQueue) syncPlayer();
  renderNow();
}

$('btn-free-stop').onclick = () => stopFree(true);

$('btn-login').onclick = () => signInWithGoogle();
const logout = async () => { await signOut(); location.reload(); };
$('btn-logout').onclick = logout;
$('btn-logout-2').onclick = logout;

// ---------------------------------------------------------------
// Saída do vídeo: na janela da TV (se aberta) ou no player do painel.
// Notebook ligado na TV pelo cabo: o DJ abre a TV numa janela, arrasta
// para a TV, e o vídeo passa a tocar lá em tela cheia, com o som.
// ---------------------------------------------------------------
const tv = { connected: false, lastSeen: 0, time: 0, duration: 0, win: null };
const tvLink = openTvLink(onTvMessage);
tvLink.post({ type: 'who' });           // tem uma TV aberta de antes?
setInterval(checkTvAlive, 2000);

const out = {
  // Dá para tocar algo agora? (TV aberta, ou player do painel pronto, ou demo)
  available: () => tv.connected || playerReady || DEMO,
  load(video, autoplay, start = 0) {
    if (tv.connected) {
      tvLink.post({ type: 'load', ...video, autoplay, start });
    } else if (playerReady) {
      const opts = { videoId: video.videoId, startSeconds: start };
      if (autoplay) player.loadVideoById(opts); else player.cueVideoById(opts);
    }
  },
  play() { if (tv.connected) tvLink.post({ type: 'play' }); else if (playerReady) player.playVideo(); },
  pause() { if (tv.connected) tvLink.post({ type: 'pause' }); else if (playerReady) player.pauseVideo(); },
  stop() { if (tv.connected) tvLink.post({ type: 'stop' }); else if (playerReady) player.stopVideo(); },
  restart() {
    if (tv.connected) tvLink.post({ type: 'restart' });
    else if (playerReady) { player.seekTo(0); player.playVideo(); }
  },
};

// O que deveria estar no player agora: o Tocar livre ou quem está no palco.
function currentVideo() {
  if (freeVideo) return freeVideo;
  const p = state.playing;
  return p ? { videoId: p.video_id, title: `${p.singer_name} · ${p.title}`, duration: p.duration_seconds } : null;
}

$('btn-tv').onclick = () => {
  if (tv.win && !tv.win.closed) { tv.win.focus(); return; }
  const url = `tv.html?player=1${DEMO ? '&demo=1' : ''}`;
  tv.win = window.open(url, 'karaoke-tv', 'popup,width=1280,height=720');
  if (!tv.win) toast('O navegador bloqueou a janela. Libere pop-ups para este site e tente de novo.', 'error');
  else toast('Arraste a janela para a TV e clique em "Ligar vídeo e som da TV".');
};

function onTvMessage(m) {
  if (!m.type?.startsWith('tv-')) return;
  tv.lastSeen = Date.now();
  if (!tv.connected) onTvConnected();
  if (m.type === 'tv-state') handleVideoState(m.state);
  if (m.type === 'tv-progress') { tv.time = m.time; tv.duration = m.duration; renderTvArea(); }
  if (m.type === 'tv-error') toast(m.message || 'Esse vídeo não pôde tocar na TV. Pule para a próxima ou remova.', 'error');
}

function checkTvAlive() {
  if (tv.connected && Date.now() - tv.lastSeen > 6000) onTvDisconnected();
}

function onTvConnected() {
  tv.connected = true;
  // Passa para a TV o que estava tocando aqui, do mesmo ponto.
  let start = 0;
  let wasPlaying = false;
  if (playerReady) {
    start = player.getCurrentTime?.() || 0;
    wasPlaying = player.getPlayerState?.() === YT.PlayerState.PLAYING;
    player.stopVideo();
  }
  const video = currentVideo();
  if (video) tvLink.post({ type: 'load', ...video, autoplay: wasPlaying, start });
  toast('TV conectada. O vídeo agora toca na TV, em tela cheia.');
  renderNow();
}

function onTvDisconnected() {
  tv.connected = false;
  tv.time = 0; tv.duration = 0;
  // Volta para o player do painel, sem dar play sozinho.
  const video = currentVideo();
  if (video && playerReady) player.cueVideoById(video.videoId);
  toast('A janela da TV fechou. O vídeo volta para o painel.', 'error');
  renderNow();
}

function renderTvArea() {
  const btn = $('btn-tv');
  btn.classList.toggle('connected', tv.connected);
  $('btn-tv-label').textContent = tv.connected ? 'TV conectada' : 'Abrir TV';
  $('tv-status').classList.toggle('hidden', !tv.connected);
  if (!tv.connected) return;
  const video = currentVideo();
  $('tv-status-title').textContent = video ? video.title : 'Nada tocando. A TV mostra a fila e o QR code.';
  const pct = tv.duration ? Math.min(100, (tv.time / tv.duration) * 100) : 0;
  $('tv-progress-bar').style.width = `${video ? pct : 0}%`;
  const mmss = (x) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`;
  $('tv-status-time').textContent = video && tv.duration ? `${mmss(tv.time)} / ${mmss(tv.duration)}` : '';
}

// ---------- Player do painel (quando a TV não está aberta) ----------
window.onYouTubeIframeAPIReady = () => {
  if (player) return;
  player = new YT.Player('player', {
    playerVars: { rel: 0, modestbranding: 1, playsinline: 1 },
    events: {
      onReady: () => { playerReady = true; syncPlayer(); },
      onStateChange: (e) => {
        if (tv.connected) return; // quem manda é a TV
        const map = { 0: 'ended', 1: 'playing', 2: 'paused' };
        if (map[e.data]) handleVideoState(map[e.data]);
      },
      onError: () => toast('Esse vídeo não pôde tocar. Pule para a próxima ou remova.', 'error'),
    },
  });
};
// Se a API do YouTube carregou antes deste módulo:
if (window.YT?.Player) window.onYouTubeIframeAPIReady();

// Coloca no player (TV ou painel) quem está no palco agora.
function syncPlayer() {
  if (!out.available() || freeVideoId) return; // tocando livre: o DJ manda no player
  const p = state.playing;
  if (!p) {
    if (loadedRequestId) { out.stop(); loadedRequestId = null; }
    return;
  }
  if (p.id === loadedRequestId) return;
  loadedRequestId = p.id;
  out.load(currentVideo(), autoplayNext); // abriu o painel no meio: não dá play sozinho
  autoplayNext = false;
}

// O vídeo (da TV ou do painel) mudou de estado.
function handleVideoState(st) {
  const night = state.night;
  if (!night) return;
  if (freeVideoId) {
    // Tocando livre: nada vai para o banco. Só repete, se pedido.
    if (st === 'ended' && $('free-loop').checked) out.restart();
    return;
  }
  if (!state.playing) return;
  if (st === 'paused' && !night.paused_at) {
    rpc('dj_pause', { p_paused: true }).catch((err) => toast(err.message, 'error'));
  }
  if (st === 'playing' && night.paused_at) {
    rpc('dj_pause', { p_paused: false }).catch((err) => toast(err.message, 'error'));
  }
  if (st === 'ended') {
    toast('A música terminou. Chame o próximo quando estiver pronto.');
    $('btn-next').classList.add('pulse');
  }
}

// Mantém a tela do DJ acesa (quando o navegador permite).
async function keepScreenOn() {
  try {
    if ('wakeLock' in navigator) {
      await navigator.wakeLock.request('screen');
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') navigator.wakeLock.request('screen').catch(() => {});
      });
    }
  } catch (_) { /* sem problema */ }
}

init();

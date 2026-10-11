// Tela do cliente: login, busca, pedido e "minha vez".
import {
  supabase, getUser, getMyProfile, signInWithGoogle, signOut,
  loadState, subscribeToChanges, rpc, searchYouTube, esc, toast,
} from './supabase.js';
import { computeSchedule, formatWait, formatClock, formatDuration, formatSongLength } from './estimate.js';
import { NOTIFY_WHEN_POSITION, NOTIFY_WHEN_MINUTES } from './config.js';
import { applyBrand } from './brand.js';

const $ = (id) => document.getElementById(id);

const state = {
  user: null,
  profile: null,
  night: null,
  playing: null,
  queue: [],
  results: [],
  selected: null,
  tab: 'search',
};

// ---------------------------------------------------------------
// Início
// ---------------------------------------------------------------
applyBrand();

let booted = false;

async function init() {
  if (booted) return;
  state.user = await getUser();
  if (!state.user) {
    show('screen-login');
    return;
  }
  if (booted) return;
  booted = true;

  state.profile = await getMyProfile();
  const avatarUrl = state.profile?.avatar_url || state.user.user_metadata?.avatar_url;
  if (avatarUrl) $('avatar').src = avatarUrl;
  $('singer-name').value = savedName() || firstName(state.profile?.display_name);

  show('screen-app');
  await refresh();
  subscribeToChanges(refresh);
  setInterval(render, 30000); // atualiza os minutos mesmo sem mudanças na fila
}

supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_IN') init();
});

function show(screenId) {
  ['screen-loading', 'screen-login', 'screen-app'].forEach((id) =>
    $(id).classList.toggle('hidden', id !== screenId));
}

async function refresh() {
  try {
    const s = await loadState();
    state.night = s.night;
    state.playing = s.playing;
    state.queue = s.queue;
    render();
  } catch (err) {
    console.error(err);
    toast('Sem conexão com a fila. Tentando de novo…', 'error');
  }
}

// ---------------------------------------------------------------
// Renderização
// ---------------------------------------------------------------
function myActiveRequest() {
  const uid = state.user?.id;
  if (state.playing?.user_id === uid) return state.playing;
  return state.queue.find((r) => r.user_id === uid) ?? null;
}

function render() {
  const { night } = state;
  const schedule = computeSchedule({ night, playing: state.playing, queue: state.queue });

  // Topo
  $('night-status').textContent = !night
    ? 'Sem karaokê agora'
    : night.is_open ? 'Ao vivo · pedidos abertos' : 'Ao vivo · pedidos fechados';

  // Aviso na aba de busca
  const mine = myActiveRequest();
  const banner = $('closed-banner');
  let bannerText = '';
  if (!night) bannerText = 'O karaokê ainda não começou. Você pode buscar, mas os pedidos abrem quando o DJ iniciar a noite.';
  else if (!night.is_open) bannerText = 'O DJ fechou os pedidos por enquanto.';
  else if (mine) bannerText = 'Você já está na fila. Quando cantar, libera outro pedido (pode cantar quantas vezes quiser na noite).';
  banner.textContent = bannerText;
  banner.classList.toggle('hidden', !bannerText);

  renderResults();
  renderMyStatus(schedule, mine);
  renderQueue(schedule);
  maybeNotify(schedule, mine);
}

function renderResults() {
  const taken = new Set([state.playing?.video_id, ...state.queue.map((r) => r.video_id)]);
  $('results').innerHTML = state.results.map((r, i) => {
    const inQueue = taken.has(r.videoId);
    return `
      <li>
        <button class="row result" type="button" data-index="${i}" ${inQueue ? 'disabled' : ''}>
          <img class="thumb" src="${esc(r.thumbnail)}" alt="" loading="lazy">
          <span class="grow">
            <span class="title">${esc(r.title)}</span>
            <span class="sub">${esc(r.channel)} · ${formatSongLength(r.durationSeconds)}</span>
            ${inQueue ? '<span class="sub">Já está na fila. Escolha outra versão.</span>' : ''}
          </span>
        </button>
      </li>`;
  }).join('');
}

function renderMyStatus(schedule, mine) {
  const box = $('my-status');
  const notifyBtn = $('btn-notify');

  if (!mine) {
    box.className = 'status-card idle';
    box.innerHTML = `
      <span class="small">Você ainda não pediu</span>
      <span class="big">—</span>
      <span>Peça uma música para entrar na fila.</span>`;
    notifyBtn.classList.add('hidden');
    return;
  }

  if (mine.status === 'playing') {
    box.className = 'status-card turn';
    box.innerHTML = `
      <span class="big">É a sua vez!</span>
      <span class="song">${esc(mine.title)}</span>
      <span>Vá para o palco.</span>`;
    notifyBtn.classList.add('hidden');
    return;
  }

  const item = schedule.items.find((r) => r.id === mine.id);
  const position = item.index + 1;
  box.className = 'status-card';
  box.innerHTML = `
    <span class="small">Você é o ${position}º da fila</span>
    <span class="big">${position === 1 && !state.playing ? 'Você é o próximo' : formatWait(item.startsInMs)}</span>
    <span>Por volta de <strong>${formatClock(item.startsAt)}</strong></span>
    <span class="song">${esc(mine.title)}</span>
    ${mine.round > 1 && state.night?.prefer_new_singers !== false
      ? '<span class="small">Quem ainda não cantou hoje passa na sua frente, então o horário pode mudar um pouco.</span>'
      : ''}
    ${mine.absent_count > 0
      ? '<span class="small"><strong>O DJ te chamou e você não estava.</strong> Você desceu 3 posições. Se não estiver na próxima, sai da fila.</span>'
      : ''}
    <div class="actions">
      <button id="btn-cancel" class="btn-cancel" type="button">Desistir da música</button>
    </div>`;
  $('btn-cancel').onclick = () => cancelMine(mine.id);

  const canNotify = 'Notification' in window && Notification.permission === 'default';
  notifyBtn.classList.toggle('hidden', !canNotify);
}

function renderQueue(schedule) {
  const uid = state.user?.id;
  const rows = [];

  if (state.playing) {
    const p = state.playing;
    rows.push(`
      <li class="row now ${p.user_id === uid ? 'me' : ''}">
        <span class="pos" aria-hidden="true">♪</span>
        <span class="grow">
          <span class="title">${esc(p.title)}</span>
          <span class="sub">${esc(p.singer_name)}</span>
        </span>
        <span class="badge live">CANTANDO</span>
      </li>`);
  }

  for (const r of schedule.items) {
    rows.push(`
      <li class="row ${r.user_id === uid ? 'me' : ''}">
        <span class="pos">${r.index + 1}</span>
        <span class="grow">
          <span class="title">${esc(r.title)}</span>
          <span class="sub">${esc(r.singer_name)}</span>
        </span>
        <span class="eta">${formatClock(r.startsAt)}</span>
      </li>`);
  }

  $('queue').innerHTML = rows.join('') ||
    '<li class="muted small">A fila está vazia. Seja o primeiro!</li>';

  $('queue-total').textContent = state.queue.length
    ? `${state.queue.length} na fila · ${formatDuration(schedule.totalMs)}`
    : '';
}

// ---------------------------------------------------------------
// Ações
// ---------------------------------------------------------------
$('btn-login').onclick = () => signInWithGoogle();

$('btn-logout').onclick = async () => {
  if (!confirm('Sair da sua conta?')) return;
  await signOut();
  location.reload();
};

$('nav-search').onclick = () => setTab('search');
$('nav-queue').onclick = () => setTab('queue');

function setTab(tab) {
  state.tab = tab;
  $('tab-search').classList.toggle('hidden', tab !== 'search');
  $('tab-confirm').classList.toggle('hidden', tab !== 'confirm');
  $('tab-queue').classList.toggle('hidden', tab !== 'queue');
  $('nav-search').classList.toggle('active', tab === 'search' || tab === 'confirm');
  $('nav-queue').classList.toggle('active', tab === 'queue');
  if (tab !== 'confirm') $('preview').src = 'about:blank'; // para o vídeo da prévia
  window.scrollTo(0, 0);
}

$('search-form').onsubmit = async (e) => {
  e.preventDefault();
  const q = $('search-input').value.trim();
  if (q.length < 2) return;
  $('search-input').blur();
  $('search-hint').textContent = 'Buscando…';
  $('results').innerHTML = '';
  try {
    state.results = await searchYouTube(q);
    $('search-hint').textContent = state.results.length
      ? `${state.results.length} versões encontradas. Toque para ver e confirmar.`
      : 'Nada encontrado. Tente com o nome do artista.';
    renderResults();
  } catch (err) {
    $('search-hint').textContent = err.message;
  }
};

$('results').onclick = (e) => {
  const btn = e.target.closest('button[data-index]');
  if (!btn || btn.disabled) return;
  const r = state.results[Number(btn.dataset.index)];
  state.selected = r;
  $('confirm-title').textContent = r.title;
  $('confirm-sub').textContent = `${r.channel} · ${formatSongLength(r.durationSeconds)}`;
  $('preview').src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(r.videoId)}?rel=0&modestbranding=1`;
  setTab('confirm');
};

$('btn-back').onclick = () => setTab('search');

$('btn-confirm').onclick = async () => {
  const r = state.selected;
  const name = $('singer-name').value.trim();
  if (!r) return;
  if (!name) {
    toast('Coloque seu nome para o DJ te chamar.', 'error');
    $('singer-name').focus();
    return;
  }
  const btn = $('btn-confirm');
  btn.disabled = true;
  try {
    await rpc('request_song', {
      p_video_id: r.videoId,
      p_title: r.title,
      p_channel: r.channel,
      p_thumbnail_url: r.thumbnail,
      p_duration_seconds: r.durationSeconds,
      p_singer_name: name,
    });
    saveName(name);
    toast('Pronto! Você entrou na fila.');
    await refresh();
    setTab('queue');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
};

async function cancelMine(id) {
  if (!confirm('Tirar sua música da fila?')) return;
  try {
    await rpc('cancel_my_request', { p_id: id });
    toast('Sua música saiu da fila.');
    await refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------
// Avisos ("sua vez está chegando")
// ---------------------------------------------------------------
$('btn-notify').onclick = async () => {
  const result = await Notification.requestPermission();
  if (result === 'granted') toast('Combinado! A gente avisa quando estiver chegando.');
  render();
};

function maybeNotify(schedule, mine) {
  if (!mine) return;

  if (mine.status === 'playing') {
    notifyOnce(`${mine.id}:turn`, 'É a sua vez!', `Vá para o palco: ${mine.title}`);
    return;
  }

  const item = schedule.items.find((r) => r.id === mine.id);
  if (!item) return;
  const close =
    item.index + 1 <= NOTIFY_WHEN_POSITION ||
    item.startsInMs <= NOTIFY_WHEN_MINUTES * 60000;
  if (close) {
    notifyOnce(
      `${mine.id}:soon`,
      'Sua vez está chegando',
      `Você é o ${item.index + 1}º · ${formatWait(item.startsInMs)} (por volta de ${formatClock(item.startsAt)})`,
    );
  }
}

async function notifyOnce(key, title, body) {
  const storageKey = `notified:${key}`;
  try { if (localStorage.getItem(storageKey)) return; } catch (_) { /* sem storage */ }

  toast(`${title}. ${body}`);
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);

  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) reg.showNotification(title, { body, icon: 'icon.svg', tag: key });
      else new Notification(title, { body, icon: 'icon.svg', tag: key });
    } catch (err) {
      console.warn('Notificação falhou', err);
    }
  }

  try { localStorage.setItem(storageKey, '1'); } catch (_) { /* sem storage */ }
}

// ---------------------------------------------------------------
// Pequenas utilidades
// ---------------------------------------------------------------
function firstName(full) {
  return (full || '').split(' ')[0] || '';
}
function savedName() {
  try { return localStorage.getItem('singer-name') || ''; } catch (_) { return ''; }
}
function saveName(name) {
  try { localStorage.setItem('singer-name', name); } catch (_) { /* ok */ }
}

// PWA: permite instalar na tela inicial e mostrar notificações no Android.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();

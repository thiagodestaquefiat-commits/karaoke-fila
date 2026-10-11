// =====================================================================
// MODO DEMONSTRAÇÃO
// Simula o Supabase dentro do navegador, com dados de exemplo, para ver
// e testar as telas sem configurar nada. Liga sozinho enquanto o
// config.js ainda tem a URL de exemplo, ou com ?demo=1 no endereço.
//
// As regras são as mesmas do banco (supabase/migrations): limite por
// pessoa, versão repetida, rodadas, "não está aqui", próxima, pausa.
// As telas abertas juntas (demo.html) compartilham a mesma fila.
// =====================================================================

const DEMO_USER = { id: 'u-voce', email: 'voce@demo', user_metadata: { full_name: 'Você Demo' } };
const DEMO_DJ = { id: 'u-dj', email: 'dj@demo', user_metadata: { full_name: 'Duvi DJ' } };

// Quem "está logado" depende da tela: o painel entra como DJ.
const isDjPage = /dj\.html/.test(location.pathname);
const me = isDjPage ? DEMO_DJ : DEMO_USER;

// ---------- Catálogo falso do YouTube ----------
const CATALOG = [
  ['Evidências', 'Chitãozinho & Xororó', 279],
  ['Garçom', 'Reginaldo Rossi', 232],
  ['Tempo Perdido', 'Legião Urbana', 301],
  ['Sweet Child O’ Mine', 'Guns N’ Roses', 356],
  ['Fogo e Paixão', 'Wando', 200],
  ['Bohemian Rhapsody', 'Queen', 360],
  ['Ainda Bem', 'Marisa Monte', 238],
  ['Pais e Filhos', 'Legião Urbana', 305],
  ['Infiel', 'Marília Mendonça', 213],
  ['Zombie', 'The Cranberries', 306],
  ['Atrasadinha', 'Felipe Araújo', 186],
  ['Sorte Que Cê Beija Bem', 'Maiara & Maraisa', 179],
  ['Anunciação', 'Alceu Valença', 254],
  ['Ciumeira', 'Marília Mendonça', 203],
  ['Livin’ On A Prayer', 'Bon Jovi', 249],
];
const CHANNELS = ['Karaokê Brasil', 'Canta Comigo Karaokê', 'Sing King', 'KaraFun BR'];
const BG_MIXES = [
  ['MPB ao vivo · barzinho acústico', 'Rádio Acústico', 3720],
  ['Sertanejo raiz para ouvir', 'Viola Caipira', 2880],
  ['Rock nacional anos 80 · mix', 'Mix Brasil', 3300],
];

const COLORS = ['#a8323a', '#7a4b2a', '#3a5a7a', '#5a3a7a', '#2f6b55', '#7a6a2a'];

function thumb(text, i) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="${COLORS[i % COLORS.length]}"/><path d="M140 65v50l42-25z" fill="#fff" opacity=".9"/><text x="16" y="164" font-family="sans-serif" font-size="18" fill="#fff" opacity=".85">${text.replace(/[<&>"]/g, '')}</text></svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

function fakeId(seed) {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  let out = '';
  for (let i = 0; i < 11; i++) { out += abc[h % 64]; h = (h * 1103515245 + 12345) >>> 0; }
  return out;
}

function norm(s) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export async function demoSearch(q, mode = 'karaoke') {
  await wait(350);
  const n = norm(q);
  if (mode === 'background') {
    const list = BG_MIXES.map(([t, ch, d], i) => ({ title: t, channel: ch, durationSeconds: d, i }));
    return list.map((r) => ({
      videoId: fakeId('bg' + r.title), title: r.title, channel: r.channel,
      thumbnail: thumb('Música de fundo', r.i + 3), durationSeconds: r.durationSeconds,
    }));
  }
  let hits = CATALOG.filter(([t, a]) => norm(`${t} ${a}`).includes(n));
  if (!hits.length) hits = [[q.slice(0, 40), 'Artista', 240]];
  const results = [];
  hits.slice(0, 4).forEach(([title, artist, dur], i) => {
    CHANNELS.slice(0, 3).forEach((ch, j) => {
      results.push({
        videoId: fakeId(`${title}|${ch}`),
        title: `${title} - ${artist} (Karaokê${j === 1 ? ' com letra' : j === 2 ? ' · tom original' : ''})`,
        channel: ch,
        thumbnail: thumb(title, i + j),
        durationSeconds: dur + j * 7,
      });
    });
  });
  return results;
}

// ---------- Estado compartilhado entre as telas ----------
// A página demo.html abre as três telas em iframes do mesmo site; elas
// usam o mesmo objeto guardado na janela de cima.
function sharedHolder() {
  try { if (window.parent && window.parent !== window && window.parent.location.origin === location.origin) return window.parent; } catch (_) { /* outro site */ }
  return window;
}

function seed() {
  const now = Date.now();
  const nightId = 'n-demo';
  const mk = (i, name, title, artist, dur, extra = {}) => ({
    id: 'r' + i, night_id: nightId, user_id: 'u' + i, singer_name: name,
    video_id: fakeId(`${title}|${CHANNELS[0]}`), title: `${title} - ${artist} (Karaokê)`, channel: 'Karaokê Brasil',
    thumbnail_url: thumb(title, i), duration_seconds: dur, position: i * 1024,
    status: 'queued', absent_count: 0, round: 1, created_at: new Date(now - (10 - i) * 60000).toISOString(),
    ...extra,
  });
  return {
    seq: 100,
    night: {
      id: nightId, title: 'Sábado', is_active: true, is_open: true, max_per_user: 1, gap_seconds: 75,
      prefer_new_singers: true, current_request_id: 'r0',
      current_started_at: new Date(now - 70000).toISOString(), paused_at: null,
    },
    requests: [
      mk(0, 'Marcos', 'Garçom', 'Reginaldo Rossi', 232, { status: 'playing', started_at: new Date(now - 70000).toISOString() }),
      mk(1, 'Ju', 'Tempo Perdido', 'Legião Urbana', 301),
      mk(2, 'Rafa & Bia', 'Evidências', 'Chitãozinho & Xororó', 279),
      mk(3, 'Dona Cida', 'Fogo e Paixão', 'Wando', 200, { round: 2 }),
    ],
    listeners: new Set(),
  };
}

const holder = sharedHolder();
if (!holder.__karaokeDemo) holder.__karaokeDemo = seed();
const db = holder.__karaokeDemo;

function changed() {
  for (const fn of [...db.listeners]) {
    try { fn(); } catch (_) { db.listeners.delete(fn); } // tela fechada
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (x) => JSON.parse(JSON.stringify(x));
const fail = (msg) => { throw new Error(msg); };
const queued = () => db.requests.filter((r) => r.status === 'queued').sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));
const requireDj = () => { if (me.id !== DEMO_DJ.id) fail('Apenas o DJ pode fazer isso.'); };
const activeNight = () => (db.night && db.night.is_active ? db.night : null);

function renumber(list) { list.forEach((r, i) => { r.position = (i + 1) * 1024; }); }

// ---------- API igual à do supabase.js ----------
export const demo = {
  async getUser() { return me; },
  async getMyProfile() {
    return { id: me.id, display_name: me.user_metadata.full_name, avatar_url: 'img/icon-192.png', role: me === DEMO_DJ ? 'dj' : 'user' };
  },
  async loadState() {
    await wait(60);
    const night = activeNight();
    if (!night) return { night: null, playing: null, queue: [] };
    return {
      night: clone(night),
      playing: clone(db.requests.find((r) => r.status === 'playing') ?? null),
      queue: clone(queued()),
    };
  },
  subscribe(onChange) {
    db.listeners.add(onChange);
    return () => db.listeners.delete(onChange);
  },

  async rpc(name, p = {}) {
    await wait(120);
    const result = rpcs[name] ? rpcs[name](p) : fail(`Função ${name} não existe no modo demo.`);
    changed();
    return clone(result ?? null);
  },
};

const rpcs = {
  request_song(p) {
    const n = activeNight() || fail('O karaokê não está acontecendo agora.');
    if (!n.is_open) fail('Os pedidos estão fechados no momento.');
    if (!(p.p_singer_name || '').trim()) fail('Informe seu nome.');
    const mine = db.requests.filter((r) => r.user_id === me.id);
    if (mine.filter((r) => ['queued', 'playing'].includes(r.status)).length >= n.max_per_user) {
      fail('Você já tem música na fila. Quando cantar, libera outra.');
    }
    if (db.requests.some((r) => r.video_id === p.p_video_id && ['queued', 'playing'].includes(r.status))) {
      fail('Essa versão já está na fila. Escolha outra.');
    }
    const round = mine.filter((r) => ['done', 'playing', 'queued'].includes(r.status)).length + 1;
    const q = queued();
    let pos;
    if (n.prefer_new_singers) {
      const prevs = q.filter((r) => r.round <= round);
      const prev = prevs.length ? prevs[prevs.length - 1].position : null;
      const next = q.find((r) => prev === null || r.position > prev)?.position ?? null;
      pos = next === null ? (prev ?? 0) + 1024 : prev === null ? next - 1024 : (prev + next) / 2;
    } else {
      pos = (q.length ? q[q.length - 1].position : 0) + 1024;
    }
    const r = {
      id: 'r' + (++db.seq), night_id: n.id, user_id: me.id, singer_name: p.p_singer_name.trim().slice(0, 40),
      video_id: p.p_video_id, title: p.p_title, channel: p.p_channel, thumbnail_url: p.p_thumbnail_url,
      duration_seconds: p.p_duration_seconds || 240, position: pos, status: 'queued', absent_count: 0,
      round, created_at: new Date().toISOString(),
    };
    db.requests.push(r);
    return r;
  },
  cancel_my_request(p) {
    const r = db.requests.find((x) => x.id === p.p_id && x.user_id === me.id && x.status === 'queued');
    if (r) r.status = 'removed';
  },
  dj_start_night(p) {
    requireDj();
    db.night = { ...seed().night, id: 'n' + (++db.seq), title: p.p_title || 'Karaokê', current_request_id: null, current_started_at: null };
    return db.night;
  },
  dj_end_night() { requireDj(); if (db.night) { db.night.is_active = false; db.night.is_open = false; } },
  dj_update_night(p) {
    requireDj();
    const n = activeNight(); if (!n) return;
    if (p.p_is_open != null) n.is_open = p.p_is_open;
    if (p.p_gap_seconds != null) n.gap_seconds = p.p_gap_seconds;
    if (p.p_max_per_user != null) n.max_per_user = p.p_max_per_user;
  },
  dj_set_prefer_new(p) { requireDj(); const n = activeNight(); if (n) n.prefer_new_singers = !!p.p_value; },
  dj_move(p) {
    requireDj();
    const q = queued();
    const item = q.find((r) => r.id === p.p_id) || fail('Esse pedido não está mais na fila.');
    const rest = q.filter((r) => r !== item);
    const to = Math.max(0, Math.min(p.p_to_index ?? 0, rest.length));
    rest.splice(to, 0, item);
    renumber(rest);
  },
  dj_not_here(p) {
    requireDj();
    const q = queued();
    const idx = q.findIndex((r) => r.id === p.p_id);
    if (idx < 0) fail('Esse pedido não está mais na fila.');
    const r = q[idx];
    if (r.absent_count >= 1) { r.absent_count++; r.status = 'removed'; return 'removed'; }
    r.absent_count++;
    rpcs.dj_move({ p_id: r.id, p_to_index: idx + 3 });
    return 'moved';
  },
  dj_remove(p) {
    requireDj();
    const r = db.requests.find((x) => x.id === p.p_id && x.status === 'queued');
    if (r) r.status = 'removed';
  },
  dj_next() {
    requireDj();
    const n = activeNight() || fail('Nenhuma noite ativa. Comece uma noite primeiro.');
    db.requests.filter((r) => r.status === 'playing').forEach((r) => { r.status = 'done'; });
    const first = queued()[0];
    if (!first) { n.current_request_id = null; n.current_started_at = null; n.paused_at = null; return null; }
    first.status = 'playing';
    first.started_at = new Date().toISOString();
    n.current_request_id = first.id; n.current_started_at = first.started_at; n.paused_at = null;
    return first;
  },
  dj_pause(p) {
    requireDj();
    const n = activeNight(); if (!n || !n.current_request_id) return;
    if (p.p_paused) n.paused_at = n.paused_at || new Date().toISOString();
    else if (n.paused_at) {
      const shift = Date.now() - Date.parse(n.paused_at);
      n.current_started_at = new Date(Date.parse(n.current_started_at) + shift).toISOString();
      n.paused_at = null;
    }
  },
};

// Conexão com o Supabase + funções que as três telas usam.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------- Login ----------

export async function getUser() {
  const { data } = await supabase.auth.getSession();
  return data.session?.user ?? null;
}

export function signInWithGoogle() {
  // Volta para a mesma página depois do login.
  const redirectTo = window.location.origin + window.location.pathname;
  return supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
}

export function signOut() {
  return supabase.auth.signOut();
}

export async function getMyProfile() {
  const user = await getUser();
  if (!user) return null;
  const { data } = await supabase.from('profiles').select('*').eq('id', user.id).maybeSingle();
  return data;
}

// ---------- Noite e fila ----------

export async function fetchActiveNight() {
  const { data, error } = await supabase
    .from('nights')
    .select('*')
    .eq('is_active', true)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Devolve { playing, queue } da noite.
export async function fetchQueue(nightId) {
  const { data, error } = await supabase
    .from('requests')
    .select('*')
    .eq('night_id', nightId)
    .in('status', ['queued', 'playing'])
    .order('position', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw error;
  return {
    playing: data.find((r) => r.status === 'playing') ?? null,
    queue: data.filter((r) => r.status === 'queued'),
  };
}

// Carrega tudo de uma vez: noite + fila.
export async function loadState() {
  const night = await fetchActiveNight();
  if (!night) return { night: null, playing: null, queue: [] };
  const { playing, queue } = await fetchQueue(night.id);
  return { night, playing, queue };
}

// Escuta qualquer mudança na fila ou na noite e chama onChange.
// Simples e à prova de erro: a cada mudança, recarrega o estado inteiro.
export function subscribeToChanges(onChange) {
  let timer = null;
  const debounced = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, 150);
  };
  const channel = supabase
    .channel('karaoke-fila')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'requests' }, debounced)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'nights' }, debounced)
    .subscribe();

  // Se o celular dormir e voltar, recarrega.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') debounced();
  });

  return () => supabase.removeChannel(channel);
}

// Chama uma função do banco e transforma o erro numa mensagem legível.
export async function rpc(name, params = {}) {
  const { data, error } = await supabase.rpc(name, params);
  if (error) throw new Error(error.message);
  return data;
}

// Busca no YouTube pela Edge Function.
// mode: 'karaoke' (padrão) ou 'background' (qualquer música, usado no "Tocar livre" do DJ).
export async function searchYouTube(q, mode = 'karaoke') {
  const { data, error } = await supabase.functions.invoke('youtube-search', { body: { q, mode } });
  if (error) {
    let message = 'Não foi possível buscar agora.';
    try {
      const body = await error.context.json();
      if (body?.error) message = body.error;
    } catch (_) { /* mantém a mensagem padrão */ }
    throw new Error(message);
  }
  return data.results ?? [];
}

// ---------- Utilidades de tela ----------

// Evita que um nome tipo "<script>" vire código na página.
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function toast(message, kind = 'info') {
  let box = document.getElementById('toast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast';
    box.setAttribute('role', 'status');
    document.body.appendChild(box);
  }
  box.textContent = message;
  box.dataset.kind = kind;
  box.classList.add('show');
  clearTimeout(box._t);
  box._t = setTimeout(() => box.classList.remove('show'), 3500);
}

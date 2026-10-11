// Canal entre o painel do DJ e a janela da TV, no MESMO notebook.
// Usa o BroadcastChannel do navegador: as janelas conversam direto,
// sem internet e sem banco, então o comando chega na hora.
//
// Mensagens do painel -> TV:
//   { type: 'load', videoId, title, duration, autoplay, start }  carrega um vídeo
//   { type: 'play' } | { type: 'pause' } | { type: 'stop' }      controla o vídeo
//   { type: 'restart' }                                          volta ao começo e toca
//   { type: 'who' }                                              "tem TV aí?"
// Mensagens da TV -> painel:
//   { type: 'tv-hello' }                                         "estou aberta" (a cada 2 s)
//   { type: 'tv-state', state: 'playing'|'paused'|'ended' }      mudou o estado do vídeo
//   { type: 'tv-progress', time, duration }                      andamento (a cada 1 s)
//   { type: 'tv-error' }                                         o vídeo não pôde tocar

const CHANNEL = 'karaoke-tv';

export function openTvLink(onMessage) {
  if (!('BroadcastChannel' in window)) return { post() {}, close() {} };
  const ch = new BroadcastChannel(CHANNEL);
  ch.onmessage = (e) => onMessage(e.data || {});
  return {
    post: (msg) => { try { ch.postMessage(msg); } catch (_) { /* janela fechando */ } },
    close: () => ch.close(),
  };
}

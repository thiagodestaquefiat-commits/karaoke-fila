// Aplica a marca do bar (nome, logo, slogan, WhatsApp) em qualquer tela.
// Basta marcar o HTML com data-venue, data-logo, data-tagline ou data-whatsapp.
import {
  VENUE_NAME, VENUE_TAGLINE, LOGO_URL, LOGO_FALLBACK_URL, WHATSAPP_GROUP_URL,
} from './config.js';

export function applyBrand() {
  document.querySelectorAll('[data-venue]').forEach((el) => (el.textContent = VENUE_NAME));
  document.querySelectorAll('[data-tagline]').forEach((el) => (el.textContent = VENUE_TAGLINE));

  document.querySelectorAll('img[data-logo]').forEach((img) => {
    img.alt = VENUE_NAME;
    img.onerror = () => {
      // Sem img/logo.png ainda? Usa a do Linktree. Sem nenhuma? Esconde.
      if (LOGO_FALLBACK_URL && img.src !== LOGO_FALLBACK_URL) img.src = LOGO_FALLBACK_URL;
      else img.classList.add('hidden');
    };
    img.src = LOGO_URL;
  });

  document.querySelectorAll('a[data-whatsapp]').forEach((a) => {
    if (!WHATSAPP_GROUP_URL) { a.classList.add('hidden'); return; }
    a.href = WHATSAPP_GROUP_URL;
  });
}

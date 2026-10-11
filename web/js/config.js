// Preencha com os dados do SEU projeto Supabase
// (Project Settings > API). A "anon key" é pública, pode ficar no front.
export const SUPABASE_URL = 'https://SEU-PROJETO.supabase.co';
export const SUPABASE_ANON_KEY = 'COLE-AQUI-A-ANON-KEY';

// ---------- Marca do bar ----------
// Nome que aparece no topo das telas.
export const VENUE_NAME = 'karaokê do Duvi';
export const VENUE_TAGLINE = 'Para os amantes de karaokê, seu lugar é aqui.';

// Logo: coloque o arquivo em web/img/logo.png (de preferência PNG com fundo
// transparente). Enquanto ele não existir, usa a imagem do Linktree do bar.
export const LOGO_URL = 'img/logo.png';
export const LOGO_FALLBACK_URL =
  'https://ugc.production.linktr.ee/39843f52-4d8a-4e28-80b7-dc64ee51ebb9_WhatsApp-Image-2026-04-24-at-16.28.55-removebg-preview.png';

// Grupo do WhatsApp do karaokê (aparece no app do cliente). Deixe '' para esconder.
export const WHATSAPP_GROUP_URL = 'https://chat.whatsapp.com/Lwg2ONm24CgBXYrkHxqJp8';

// As cores ficam em web/css/brand.css.

// Avisar o cliente quando faltar isso (ou menos) para a vez dele.
export const NOTIFY_WHEN_POSITION = 2;      // faltam 2 músicas
export const NOTIFY_WHEN_MINUTES = 8;       // ou faltam 8 minutos

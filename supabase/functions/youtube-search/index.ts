// Edge Function: busca versões de karaokê no YouTube.
//
// Fluxo (igual à lógica do ROUDY: primeiro o que já temos, depois a API):
//   1. Confere se quem chamou está logado.
//   2. Procura a busca no cache (tabela search_cache). Achou e é recente? Devolve.
//   3. Senão: search.list (100 unidades de cota) + videos.list para pegar a
//      duração de cada vídeo (1 unidade). Salva no cache e devolve.
//
// Segredo necessário: YOUTUBE_API_KEY (supabase secrets set YOUTUBE_API_KEY=...)

import { createClient } from "jsr:@supabase/supabase-js@2";

const CACHE_DAYS = 30;
const MIN_SECONDS = 60;   // descarta vinhetas e shorts
const MAX_SECONDS = 900;  // descarta compilações de 1 hora
const MAX_SECONDS_BACKGROUND = 3 * 3600; // no "Tocar livre" pode ser um mix longo

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// "Evidências  KARAOKÊ" -> "evidencias karaoke"
function normalize(q: string) {
  return q
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// "PT4M39S" -> 279
function isoDurationToSeconds(iso: string) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso ?? "");
  if (!m) return 0;
  const [, d, h, min, s] = m.map((x) => Number(x ?? 0));
  return d * 86400 + h * 3600 + min * 60 + s;
}

// Os títulos da busca vêm com &amp; &#39; &quot; etc.
function decodeEntities(s: string) {
  return (s ?? "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const YT_KEY = Deno.env.get("YOUTUBE_API_KEY");
    if (!YT_KEY) return json({ error: "YOUTUBE_API_KEY não configurada." }, 500);

    // 1. Só quem está logado pode buscar (protege a cota).
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: userData } = await userClient.auth.getUser();
    if (!userData?.user) return json({ error: "Entre com o Google para buscar." }, 401);

    const { q, mode } = await req.json().catch(() => ({ q: "", mode: "" }));
    // mode "background": "Tocar livre" do DJ, qualquer música (sem filtro de karaokê).
    const background = mode === "background";
    const query = String(q ?? "").trim().slice(0, 80);
    const norm = normalize(query);
    const cacheKey = background ? `bg:${norm}` : norm;
    if (norm.length < 2) return json({ results: [] });

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // 2. Cache.
    const { data: cached } = await admin
      .from("search_cache")
      .select("results, created_at")
      .eq("query_norm", cacheKey)
      .maybeSingle();

    const maxAgeMs = CACHE_DAYS * 24 * 60 * 60 * 1000;
    if (cached && Date.now() - Date.parse(cached.created_at) < maxAgeMs) {
      return json({ results: cached.results, cached: true });
    }

    // 3a. Busca (100 unidades).
    const searchParams = new URLSearchParams({
      part: "snippet",
      type: "video",
      videoEmbeddable: "true",
      maxResults: "15",
      q: background || /karaok/i.test(norm) ? query : `${query} karaoke`,
      regionCode: "BR",
      relevanceLanguage: "pt",
      key: YT_KEY,
    });
    const sRes = await fetch(`https://www.googleapis.com/youtube/v3/search?${searchParams}`);
    if (!sRes.ok) {
      const text = await sRes.text();
      if (sRes.status === 403 && /quota/i.test(text)) {
        return json({ error: "Limite diário de buscas do YouTube atingido. Tente uma música já pedida hoje." }, 429);
      }
      console.error("search.list falhou", sRes.status, text);
      return json({ error: "Não foi possível buscar no YouTube agora." }, 502);
    }
    const sJson = await sRes.json();
    const items: any[] = sJson.items ?? [];
    const ids = items.map((i) => i.id?.videoId).filter(Boolean);

    let results: any[] = [];

    if (ids.length) {
      // 3b. Duração e se pode tocar fora do YouTube (1 unidade).
      const videoParams = new URLSearchParams({
        part: "contentDetails,status",
        id: ids.join(","),
        key: YT_KEY,
      });
      const vRes = await fetch(`https://www.googleapis.com/youtube/v3/videos?${videoParams}`);
      const vJson = vRes.ok ? await vRes.json() : { items: [] };
      const info = new Map<string, { seconds: number; embeddable: boolean }>();
      for (const v of vJson.items ?? []) {
        info.set(v.id, {
          seconds: isoDurationToSeconds(v.contentDetails?.duration),
          embeddable: v.status?.embeddable !== false,
        });
      }

      results = items
        .map((i) => {
          const id = i.id.videoId;
          const meta = info.get(id);
          return {
            videoId: id,
            title: decodeEntities(i.snippet?.title),
            channel: decodeEntities(i.snippet?.channelTitle),
            thumbnail:
              i.snippet?.thumbnails?.medium?.url ??
              i.snippet?.thumbnails?.default?.url ??
              `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
            durationSeconds: meta?.seconds ?? 0,
            embeddable: meta?.embeddable ?? false,
          };
        })
        .filter((r) => r.embeddable && r.durationSeconds >= MIN_SECONDS && r.durationSeconds <= (background ? MAX_SECONDS_BACKGROUND : MAX_SECONDS))
        .map(({ embeddable: _e, ...r }) => r)
        .slice(0, 12);
    }

    await admin
      .from("search_cache")
      .upsert({ query_norm: cacheKey, results, created_at: new Date().toISOString() });

    return json({ results, cached: false });
  } catch (err) {
    console.error(err);
    return json({ error: "Erro inesperado na busca." }, 500);
  }
});

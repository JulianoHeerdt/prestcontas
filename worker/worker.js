/**
 * Proxy da Geoapify para o sistema de Prestação de Contas de Deslocamentos.
 *
 * A chave da Geoapify fica SOMENTE aqui, como "secret" do Cloudflare (GEOAPIFY_KEY).
 * Ela nunca é enviada ao navegador nem aparece no repositório.
 *
 * Proteções:
 *  - Só atende requisições vindas das origens autorizadas (ALLOWED_ORIGINS).
 *  - Código de acesso opcional (ACCESS_CODE), digitado uma vez por dispositivo.
 *  - Limite de requisições por IP (binding RATE_LIMITER, opcional).
 *  - Expõe apenas 3 operações, com parâmetros fixos e validados:
 *    geocodificação no Brasil, rota de carro entre 2 pontos no Brasil e
 *    imagem de mapa em tamanho fixo. Não funciona como proxy genérico da Geoapify.
 */

const GEO = "https://api.geoapify.com";
const MAPS = "https://maps.geoapify.com";
// Retângulo aproximado do território brasileiro
const BR = { latMin: -34.5, latMax: 5.6, lonMin: -74.5, lonMax: -28.5 };

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const originOk = allowed.includes(origin);
    const cors = originOk
      ? {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-Codigo-Acesso",
          "Access-Control-Max-Age": "86400",
          Vary: "Origin",
        }
      : { Vary: "Origin" };

    if (request.method === "OPTIONS") return new Response(null, { status: originOk ? 204 : 403, headers: cors });
    if (!originOk) return json({ erro: "Origem não autorizada." }, 403, cors);
    if (!env.GEOAPIFY_KEY) return json({ erro: "Proxy sem chave configurada." }, 500, cors);

    if (env.ACCESS_CODE) {
      const informado = request.headers.get("X-Codigo-Acesso") || "";
      if (!(await sameSecret(informado, env.ACCESS_CODE))) return json({ erro: "Código de acesso inválido." }, 401, cors);
    }

    if (env.RATE_LIMITER) {
      const ip = request.headers.get("CF-Connecting-IP") || "desconhecido";
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) return json({ erro: "Muitas consultas em pouco tempo. Aguarde um minuto e tente de novo." }, 429, cors);
    }

    const url = new URL(request.url);
    try {
      if (url.pathname === "/ping" && request.method === "GET") return json({ ok: true }, 200, cors);
      if (url.pathname === "/geocode" && request.method === "GET") return await geocode(url, env, cors);
      if (url.pathname === "/route" && request.method === "GET") return await route(url, env, cors);
      if (url.pathname === "/staticmap" && request.method === "POST") return await staticMap(request, env, cors);
      return json({ erro: "Operação inexistente." }, 404, cors);
    } catch (err) {
      if (err instanceof ErroValidacao) return json({ erro: err.message }, 400, cors);
      return json({ erro: "Falha ao consultar o serviço de mapas." }, 502, cors);
    }
  },
};

class ErroValidacao extends Error {}

async function geocode(url, env, cors) {
  const text = (url.searchParams.get("text") || "").trim();
  if (text.length < 3 || text.length > 300) throw new ErroValidacao("Endereço vazio ou longo demais.");
  const q = new URLSearchParams({ text, format: "json", limit: "1", lang: "pt", filter: "countrycode:br", apiKey: env.GEOAPIFY_KEY });
  const r = await fetch(`${GEO}/v1/geocode/search?${q}`);
  if (!r.ok) return upstreamError(r, cors);
  const data = await r.json();
  const f = (data.results || [])[0];
  if (!f) return json({ resultado: null }, 200, cors);
  // Devolve só o necessário
  return json({
    resultado: {
      lat: f.lat, lon: f.lon, formatted: f.formatted,
      cidade: f.city || f.town || f.village || f.county || "",
      confianca: f.rank && typeof f.rank.confidence === "number" ? f.rank.confidence : null,
    },
  }, 200, cors);
}

async function route(url, env, cors) {
  const a = point(url.searchParams.get("de")), b = point(url.searchParams.get("para"));
  const q = new URLSearchParams({ waypoints: `${a.lat},${a.lon}|${b.lat},${b.lon}`, mode: "drive", format: "geojson", apiKey: env.GEOAPIFY_KEY });
  const r = await fetch(`${GEO}/v1/routing?${q}`);
  if (!r.ok) return upstreamError(r, cors);
  const data = await r.json();
  const feat = (data.features || [])[0];
  if (!feat) return json({ erro: "Nenhuma rota disponível entre os endereços informados." }, 404, cors);
  const g = feat.geometry || {};
  const coords = g.type === "LineString" ? g.coordinates : g.type === "MultiLineString" ? g.coordinates.flat() : [];
  return json({ metros: Math.round(Number(feat.properties?.distance || 0)), segundos: Number(feat.properties?.time || 0), coords }, 200, cors);
}

async function staticMap(request, env, cors) {
  const raw = await request.text();
  if (raw.length > 400000) throw new ErroValidacao("Rota grande demais para o mapa.");
  let body;
  try { body = JSON.parse(raw); } catch { throw new ErroValidacao("Requisição inválida."); }
  const poly = String(body.polyline6 || "");
  if (!poly || !/^[\x3f-\x7e]+$/.test(poly)) throw new ErroValidacao("Traçado inválido.");
  const o = point(`${body.origem?.lat},${body.origem?.lon}`), d = point(`${body.destino?.lat},${body.destino?.lon}`);
  // Parâmetros do mapa definidos aqui, não pelo navegador
  const spec = {
    style: "osm-bright", width: 900, height: 480, scaleFactor: 2, format: "png",
    geometries: [{ type: "polyline6", value: poly, linecolor: "#0057b8", lineopacity: 0.9, linewidth: 6, linestyle: "solid" }],
    markers: [
      { lat: o.lat, lon: o.lon, type: "circle", color: "#188038", size: 38, contentsize: 24, text: "O" },
      { lat: d.lat, lon: d.lon, type: "circle", color: "#d93025", size: 38, contentsize: 24, text: "D" },
    ],
  };
  const r = await fetch(`${MAPS}/v1/staticmap?apiKey=${encodeURIComponent(env.GEOAPIFY_KEY)}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(spec),
  });
  if (!r.ok) return upstreamError(r, cors);
  return new Response(r.body, { status: 200, headers: { ...cors, "Content-Type": "image/png", "Cache-Control": "no-store" } });
}

function point(text) {
  const m = /^(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)$/.exec(String(text || ""));
  if (!m) throw new ErroValidacao("Coordenada inválida.");
  const lat = Number(m[1]), lon = Number(m[2]);
  if (lat < BR.latMin || lat > BR.latMax || lon < BR.lonMin || lon > BR.lonMax) throw new ErroValidacao("Coordenada fora do Brasil.");
  return { lat, lon };
}

async function upstreamError(r, cors) {
  let detalhe = "";
  try { const j = await r.json(); detalhe = j.message || j.error?.message || ""; } catch {}
  const msg = r.status === 429 ? "Limite diário de consultas da Geoapify atingido." : `Serviço de mapas retornou HTTP ${r.status}${detalhe ? ": " + String(detalhe).slice(0, 200) : ""}`;
  return json({ erro: msg }, 502, cors);
}

// Comparação em tempo constante (via hash) para o código de acesso
async function sameSecret(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function json(payload, status, headers) {
  return new Response(JSON.stringify(payload), { status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

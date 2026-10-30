// Prestação de contas de deslocamentos — versão web (GitHub Pages)
// Nenhuma chave de API existe neste código: as consultas passam pelo proxy configurado em config.js.

const PROXY = String((window.APP_CONFIG || {}).proxyUrl || "").replace(/\/+$/, "");
const LS_CONFIG = "prestacao.config.v1";
const LS_CODIGO = "prestacao.codigo.v1";
const $ = (s) => document.querySelector(s);
let items = [];
let precisaCodigo = false;

/* ---------------- utilidades ---------------- */
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m])); }
function msg(html, type = "loading") { $("#message").innerHTML = `<div class="message ${type}">${html}</div>`; }
function brl(v) { return Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
function km1(v) { return Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }
function money(v) {
  if (typeof v === "number") return v;
  let raw = String(v || "").replace(/R\$|\s/g, "");
  if (raw.includes(",")) raw = raw.replace(/\./g, "").replace(",", ".");
  const n = Number(raw || 0);
  return Number.isFinite(n) ? n : 0;
}
function round(v, casas) { const f = 10 ** casas; return Math.round((v + 1e-9) * f) / f; }
function displayDate(iso) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ""); return m ? `${m[3]}/${m[2]}/${m[1]}` : iso; }
function mapsLink(o, d) { return "https://www.google.com/maps/dir/?api=1&origin=" + encodeURIComponent(o) + "&destination=" + encodeURIComponent(d) + "&travelmode=driving"; }

/* ---------------- configuração local ---------------- */
const DEFAULT = { usuario: { nome: "", matricula: "", cargo: "", lotacao: "", cidade_emissao: "", valor_km: 0 }, gestor: { nome: "", matricula: "", cargo: "" }, casas_km: 1 };
function loadConfig() {
  try {
    const c = JSON.parse(localStorage.getItem(LS_CONFIG) || "{}");
    return { ...DEFAULT, ...c, usuario: { ...DEFAULT.usuario, ...(c.usuario || {}) }, gestor: { ...DEFAULT.gestor, ...(c.gestor || {}) } };
  } catch { return structuredClone(DEFAULT); }
}
function saveConfig(c) { localStorage.setItem(LS_CONFIG, JSON.stringify(c)); }
function codigo() { try { return localStorage.getItem(LS_CODIGO) || ""; } catch { return ""; } }
function configOk(c) { return c.usuario.nome && money(c.usuario.valor_km) > 0; }

function fillConfig() {
  const c = loadConfig();
  $("#nome").value = c.usuario.nome; $("#matricula").value = c.usuario.matricula; $("#cargo").value = c.usuario.cargo;
  $("#lotacao").value = c.usuario.lotacao; $("#cidade").value = c.usuario.cidade_emissao;
  $("#valor").value = c.usuario.valor_km ? String(c.usuario.valor_km).replace(".", ",") : "";
  $("#gnome").value = c.gestor.nome; $("#gmatricula").value = c.gestor.matricula; $("#gcargo").value = c.gestor.cargo;
  $("#codigoBox").hidden = !precisaCodigo; $("#codigo").value = "";
}
$("#btnConfig").onclick = () => { fillConfig(); $("#config").showModal(); };
$("#save").onclick = (e) => {
  e.preventDefault();
  const valor = money($("#valor").value);
  if (!(valor > 0)) { alert("Informe o valor por km (maior que zero)."); return; }
  const c = loadConfig();
  c.usuario = { nome: $("#nome").value.trim(), matricula: $("#matricula").value.trim(), cargo: $("#cargo").value.trim(), lotacao: $("#lotacao").value.trim(), cidade_emissao: $("#cidade").value.trim(), valor_km: valor };
  c.gestor = { nome: $("#gnome").value.trim(), matricula: $("#gmatricula").value.trim(), cargo: $("#gcargo").value.trim() };
  saveConfig(c);
  const cod = $("#codigo").value.trim();
  if (cod) localStorage.setItem(LS_CODIGO, cod);
  $("#config").close();
  msg("Configurações salvas.", "success");
  updateSteps();
};

/* ---------------- leitura de .xlsx sem bibliotecas externas ---------------- */
async function unzip(buffer) {
  const v = new DataView(buffer), bytes = new Uint8Array(buffer), files = new Map();
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("O arquivo não é uma planilha .xlsx válida.");
  const total = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  for (let n = 0; n < total; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true);
    const nlen = v.getUint16(p + 28, true), xlen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
    files.set(name, { method, csize, local });
    p += 46 + nlen + xlen + clen;
  }
  return async (name) => {
    const f = files.get(name);
    if (!f) return null;
    const start = f.local + 30 + v.getUint16(f.local + 26, true) + v.getUint16(f.local + 28, true);
    const data = bytes.subarray(start, start + f.csize);
    if (f.method === 0) return dec.decode(data);
    if (f.method !== 8) throw new Error("Compressão da planilha não suportada.");
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return await new Response(stream).text();
  };
}
const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
function xml(text) { return new DOMParser().parseFromString(text, "application/xml"); }
function colNumber(ref) { const m = /^([A-Z]+)/.exec(String(ref).toUpperCase()); let n = 0; if (m) for (const ch of m[1]) n = n * 26 + ch.charCodeAt(0) - 64; return n; }
function parseDate(value) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("Data não informada");
  if (/^\d+(\.\d+)?$/.test(raw) && Number(raw) > 20000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(raw)) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  let m;
  if ((m = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2}|\d{4})$/.exec(raw))) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const d = new Date(Date.UTC(y, Number(m[2]) - 1, Number(m[1])));
    if (d.getUTCDate() === Number(m[1])) return d.toISOString().slice(0, 10);
  }
  if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw))) return `${m[1]}-${m[2]}-${m[3]}`;
  throw new Error(`Data inválida: ${raw}`);
}
async function parseXlsx(buffer) {
  const read = await unzip(buffer);
  const shared = [];
  const ss = await read("xl/sharedStrings.xml");
  if (ss) for (const si of xml(ss).getElementsByTagNameNS(NS, "si")) shared.push([...si.getElementsByTagNameNS(NS, "t")].map((t) => t.textContent).join(""));
  const wb = xml(await read("xl/workbook.xml"));
  const rels = xml(await read("xl/_rels/workbook.xml.rels"));
  const sheet = wb.getElementsByTagNameNS(NS, "sheet")[0];
  if (!sheet) throw new Error("A planilha não possui abas.");
  const rid = sheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
  let target = "worksheets/sheet1.xml";
  for (const r of rels.getElementsByTagName("Relationship")) if (r.getAttribute("Id") === rid) target = r.getAttribute("Target");
  target = target.replace(/^\//, "");
  const doc = xml(await read(target.startsWith("xl/") ? target : "xl/" + target));
  const matrix = [];
  for (const row of doc.getElementsByTagNameNS(NS, "row")) {
    const vals = {};
    for (const c of row.getElementsByTagNameNS(NS, "c")) {
      const t = c.getAttribute("t") || "", vEl = c.getElementsByTagNameNS(NS, "v")[0];
      let val = "";
      if (t === "inlineStr") val = [...c.getElementsByTagNameNS(NS, "t")].map((x) => x.textContent).join("");
      else if (vEl) val = t === "s" ? shared[Number(vEl.textContent)] ?? "" : vEl.textContent;
      vals[colNumber(c.getAttribute("r") || "A1")] = val;
    }
    const keys = Object.keys(vals).map(Number);
    if (keys.length) matrix.push(Array.from({ length: Math.max(...keys) }, (_, i) => vals[i + 1] ?? ""));
  }
  if (!matrix.length) throw new Error("A primeira aba está vazia.");
  const headers = {};
  matrix[0].forEach((h, i) => (headers[String(h).trim().toLowerCase().replace(/\s+/g, " ")] = i));
  const aliases = {
    data: ["data", "data do deslocamento"],
    empresa: ["destino/empresa", "destino / empresa", "empresa", "destino (empresa)", "destino"],
    origem: ["endereço de origem", "endereco de origem", "origem"],
    destino: ["endereço de destino", "endereco de destino"],
    observacao: ["observação", "observacao", "finalidade"],
  };
  const pos = {};
  for (const [f, opts] of Object.entries(aliases)) for (const o of opts) if (o in headers && !(f in pos)) pos[f] = headers[o];
  const missing = ["data", "empresa", "origem", "destino"].filter((x) => !(x in pos));
  if (missing.length) throw new Error("Colunas obrigatórias ausentes: " + missing.join(", "));
  const result = [], errors = [];
  matrix.slice(1).forEach((row, k) => {
    if (!row.some((v) => String(v).trim())) return;
    const get = (f) => (pos[f] !== undefined && pos[f] < row.length ? String(row[pos[f]]).trim() : "");
    try {
      const item = { data: parseDate(get("data")), empresa: get("empresa"), origem: get("origem"), destino: get("destino"), observacao: get("observacao") };
      for (const f of ["empresa", "origem", "destino"]) if (!item[f]) throw new Error(`${f[0].toUpperCase() + f.slice(1)} não informado`);
      result.push(item);
    } catch (e) { errors.push({ linha: k + 2, erro: e.message }); }
  });
  if (!result.length && errors.length) throw new Error("Nenhuma linha válida. " + errors.map((e) => `Linha ${e.linha}: ${e.erro}`).join("; "));
  return { itens: result, erros: errors };
}

/* ---------------- tabela de conferência ---------------- */
$("#file").onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  if (!/\.xlsx$/i.test(f.name)) { msg("Envie a planilha no formato .xlsx.", "error"); return; }
  msg("Lendo a planilha...");
  try {
    const d = await parseXlsx(await f.arrayBuffer());
    items = d.itens; render();
    msg(`${items.length} deslocamento(s) importado(s).${d.erros.length ? " Linhas ignoradas: " + d.erros.map((x) => `${x.linha} (${esc(x.erro)})`).join(", ") : ""}`, d.erros.length ? "error" : "success");
  } catch (err) { msg(esc(err.message || "Falha na importação."), "error"); }
};
$("#addRow").onclick = () => { items.push({ data: new Date().toISOString().slice(0, 10), empresa: "", origem: "", destino: "", observacao: "" }); render(); };
function render() {
  const body = $("#rows"); body.innerHTML = "";
  items.forEach((x, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${i + 1}</td><td><input type="date" data-k="data" value="${esc(x.data)}"></td><td><input data-k="empresa" value="${esc(x.empresa)}"></td><td><input data-k="origem" value="${esc(x.origem)}"></td><td><input data-k="destino" value="${esc(x.destino)}"></td><td><input data-k="observacao" value="${esc(x.observacao || "")}"></td><td><button class="delete">Excluir</button></td>`;
    tr.querySelectorAll("input").forEach((inp) => (inp.oninput = () => (items[i][inp.dataset.k] = inp.value)));
    tr.querySelector(".delete").onclick = () => { items.splice(i, 1); render(); };
    body.appendChild(tr);
  });
  $("#preview").hidden = !items.length;
  updateSteps();
}
function updateSteps() {
  $("#st1").className = configOk(loadConfig()) ? "done" : "active";
  $("#st2").className = items.length ? "done" : configOk(loadConfig()) ? "active" : "";
  $("#st3").className = items.length ? "active" : "";
}

/* ---------------- chamadas ao proxy ---------------- */
async function proxy(path, opts = {}) {
  if (!PROXY || PROXY.includes("SEU-SUBDOMINIO")) throw new Error("O endereço do proxy não foi configurado em config.js.");
  const headers = { ...(opts.headers || {}) };
  const cod = codigo(); if (cod) headers["X-Codigo-Acesso"] = cod;
  let r;
  try { r = await fetch(PROXY + path, { ...opts, headers }); }
  catch { throw new Error("Não foi possível acessar o serviço de rotas. Verifique a conexão."); }
  if (r.status === 401) { precisaCodigo = true; localStorage.removeItem(LS_CODIGO); throw new Error("Código de acesso ausente ou inválido. Informe-o em Configurações."); }
  if (!r.ok) { let m = `Erro ${r.status}`; try { m = (await r.json()).erro || m; } catch {} throw new Error(m); }
  return r;
}
async function geocode(address) {
  const d = await (await proxy("/geocode?text=" + encodeURIComponent(address))).json();
  if (!d.resultado) throw new Error(`Endereço não localizado: ${address}`);
  const g = d.resultado;
  return { lat: Number(g.lat), lng: Number(g.lon), formatado: g.formatted || address, cidade: g.cidade || "", confianca: g.confianca };
}
async function computeRoute(a, b) {
  const d = await (await proxy(`/route?de=${a.lat},${a.lng}&para=${b.lat},${b.lng}`)).json();
  return { metros: d.metros, coords: d.coords };
}
function polyline6(coords) {
  let out = "", lastLat = 0, lastLon = 0;
  for (const [lon, lat] of coords) {
    const la = Math.round(lat * 1e6), lo = Math.round(lon * 1e6);
    for (let v of [la - lastLat, lo - lastLon]) {
      v = v < 0 ? ~(v * 2) : v * 2;
      while (v >= 0x20) { out += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v = Math.floor(v / 32); }
      out += String.fromCharCode(v + 63);
    }
    lastLat = la; lastLon = lo;
  }
  return out;
}
function blobToDataUrl(blob) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); }); }
async function staticMap(coords, a, b) {
  const r = await proxy("/staticmap", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ polyline6: polyline6(simplifyLonLat(coords, 6000)), origem: { lat: a.lat, lon: a.lng }, destino: { lat: b.lat, lon: b.lng } }) });
  const blob = await r.blob();
  if (blob.size < 1000) throw new Error("Imagem do mapa inválida");
  return blobToDataUrl(blob);
}
// Reduz rotas muito longas para não exceder o tamanho aceito pelo mapa
function simplifyLonLat(coords, max) { if (coords.length <= max) return coords; const step = Math.ceil(coords.length / max), out = []; for (let i = 0; i < coords.length; i += step) out.push(coords[i]); out.push(coords[coords.length - 1]); return out; }

/* ---------------- mapa vetorial de reserva (sem fundo de ruas) ---------------- */
function merc(lon, lat) { lat = Math.max(Math.min(lat, 85), -85); const r = Math.PI / 180; return [lon * r, Math.log(Math.tan(Math.PI / 4 + (lat * r) / 2))]; }
function simplifyPx(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(); const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, norm = Math.hypot(dx, dy) || 1e-9;
    let idx = -1, dmax = tol;
    for (let i = a + 1; i < b; i++) { const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / norm; if (d > dmax) { idx = i; dmax = d; } }
    if (idx >= 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
function routeSvg(coords, o, d, km, titulo) {
  const W = 900, H = 480, PAD = 55, TOP = 36, BOTTOM = 40;
  const pts = (coords.length ? coords : [[o.lng, o.lat], [d.lng, d.lat]]).map(([lon, lat]) => merc(lon, lat));
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
  const span = Math.max(maxx - minx, maxy - miny, 1e-5), cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
  const scale = Math.min((W - 2 * PAD) / Math.max(maxx - minx, span * 0.05), (H - TOP - BOTTOM - 2 * PAD + 40) / Math.max(maxy - miny, span * 0.05));
  const midY = TOP + (H - TOP - BOTTOM) / 2;
  const px = (p) => [W / 2 + (p[0] - cx) * scale, midY - (p[1] - cy) * scale];
  const path = "M" + simplifyPx(pts.map(px), 0.6).map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" L");
  const [ox, oy] = px(merc(o.lng, o.lat)), [dx, dy] = px(merc(d.lng, d.lat));
  const latC = (2 * Math.atan(Math.exp(cy)) - Math.PI / 2) * 180 / Math.PI;
  const mpp = 6378137 * Math.cos(latC * Math.PI / 180) / scale, target = mpp * 130;
  const mag = 10 ** Math.floor(Math.log10(target));
  const nice = [5, 2, 1].map((n) => n * mag).find((v) => v <= target) || mag;
  const bar = nice / mpp, barLabel = nice >= 1000 ? `${nice / 1000} km` : `${nice} m`;
  let grid = ""; for (let x = 0; x < W; x += 60) grid += `<line x1="${x}" y1="${TOP}" x2="${x}" y2="${H - BOTTOM}"/>`; for (let y = TOP; y < H - BOTTOM; y += 60) grid += `<line x1="0" y1="${y}" x2="${W}" y2="${y}"/>`;
  const label = (x, y, t, right) => { if (!t) return ""; const tx = right ? x - 26 : x + 26, c = `x="${tx.toFixed(1)}" y="${(y + 5).toFixed(1)}" text-anchor="${right ? "end" : "start"}" font-size="15" font-weight="bold"`; return `<text ${c} fill="#fff" stroke="#fff" stroke-width="5" stroke-linejoin="round">${esc(t)}</text><text ${c} fill="#1b2a3a">${esc(t)}</text>`; };
  const oRight = ox > dx;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Arial,Helvetica,sans-serif"><rect width="${W}" height="${H}" fill="#f5f7fa"/><g stroke="#e1e6ed" stroke-width="1">${grid}</g><rect width="${W}" height="${TOP}" fill="#193b68"/><text x="14" y="24" font-size="15" fill="#fff" font-weight="bold">${esc(titulo)}</text><text x="${W - 14}" y="24" font-size="15" fill="#f7d117" font-weight="bold" text-anchor="end">${km1(km)} km</text><path d="${path}" fill="none" stroke="#fff" stroke-width="10" stroke-linejoin="round" stroke-linecap="round"/><path d="${path}" fill="none" stroke="#0057b8" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${ox.toFixed(1)}" cy="${oy.toFixed(1)}" r="17" fill="#188038" stroke="#fff" stroke-width="3"/><text x="${ox.toFixed(1)}" y="${(oy + 6).toFixed(1)}" text-anchor="middle" font-size="16" font-weight="bold" fill="#fff">O</text><circle cx="${dx.toFixed(1)}" cy="${dy.toFixed(1)}" r="17" fill="#d93025" stroke="#fff" stroke-width="3"/><text x="${dx.toFixed(1)}" y="${(dy + 6).toFixed(1)}" text-anchor="middle" font-size="16" font-weight="bold" fill="#fff">D</text>${label(ox, oy, o.cidade, oRight)}${label(dx, dy, d.cidade, !oRight)}<g transform="translate(${W - 40},${TOP + 48})"><polygon points="0,-22 9,6 0,0 -9,6" fill="#1b2a3a"/><text y="22" text-anchor="middle" font-size="13" font-weight="bold" fill="#1b2a3a">N</text></g><rect x="0" y="${H - BOTTOM}" width="${W}" height="${BOTTOM}" fill="#fff"/><line x1="0" y1="${H - BOTTOM}" x2="${W}" y2="${H - BOTTOM}" stroke="#c9d2dd"/><g transform="translate(16,${H - 16})"><rect width="${bar.toFixed(1)}" height="6" fill="#1b2a3a"/><rect width="${(bar / 2).toFixed(1)}" height="6" fill="#fff" stroke="#1b2a3a"/><text x="${(bar + 8).toFixed(1)}" y="7" font-size="12" fill="#1b2a3a">${barLabel}</text></g><text x="${W - 14}" y="${H - 14}" text-anchor="end" font-size="11" fill="#637083">Traçado: Geoapify Routing API. Dados viários © OpenStreetMap contributors</text></svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

/* ---------------- processamento ---------------- */
async function processRoutes(list, cfg, progress) {
  const valorKm = money(cfg.usuario.valor_km), casas = Number(cfg.casas_km ?? 1);
  if (!(valorKm > 0)) throw new Error("Cadastre o valor de ressarcimento por km em Configurações.");
  const out = [], avisos = [];
  let ruas = true;
  for (let i = 0; i < list.length; i++) {
    const it = list[i], n = i + 1;
    for (const f of ["empresa", "origem", "destino"]) if (!String(it[f] || "").trim()) throw new Error(`Linha ${n}: ${f} não informado.`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(it.data || "")) throw new Error(`Linha ${n}: data inválida.`);
    progress(`Rota ${n} de ${list.length}: localizando endereços...`);
    const o = await geocode(it.origem), d = await geocode(it.destino);
    for (const [g, txt] of [[o, it.origem], [d, it.destino]]) if (g.confianca !== null && g.confianca < 0.6) avisos.push(`Rota ${n}: "${txt}" foi reconhecido como "${g.formatado}". Confira se está correto.`);
    progress(`Rota ${n} de ${list.length}: calculando ida e retorno...`);
    const ida = await computeRoute(o, d), ret = await computeRoute(d, o);
    const kmIda = round(ida.metros / 1000, casas), kmRet = round(ret.metros / 1000, casas);
    const kmTotal = round(kmIda + kmRet, casas); // total = soma dos valores exibidos
    progress(`Rota ${n} de ${list.length}: gerando mapas...`);
    const mapas = {};
    for (const [k, r, a, b] of [["ida", ida, o, d], ["retorno", ret, d, o]]) {
      if (ruas) { try { mapas[k] = await staticMap(r.coords, a, b); continue; } catch (e) { if (/código de acesso/i.test(e.message)) throw e; ruas = false; } }
      mapas[k] = routeSvg(r.coords, a, b, k === "ida" ? kmIda : kmRet, `Rota ${String(n).padStart(2, "0")} - ${k}`);
    }
    out.push({ ...it, numero: n, origem_formatada: o.formatado, destino_formatado: d.formatado, km_ida: kmIda, km_retorno: kmRet, km_total: kmTotal, valor_km: valorKm, valor_ressarcir: round(kmTotal * valorKm, 2), link_ida: mapsLink(o.formatado, d.formatado), link_retorno: mapsLink(d.formatado, o.formatado), mapa_ida: mapas.ida, mapa_retorno: mapas.retorno });
  }
  if (!ruas) avisos.push("O mapa com ruas não pôde ser obtido; algumas rotas foram desenhadas sem o fundo de ruas.");
  return { deslocamentos: out, avisos };
}

/* ---------------- relatório ---------------- */
const REPORT_CSS = `@page { size:A4; margin:14mm; }
*{box-sizing:border-box} body{font-family:Arial,sans-serif;color:#111;margin:0;background:#eceff3;font-size:11px;line-height:1.35}
.page{width:210mm;min-height:297mm;margin:18px auto;background:white;padding:14mm;box-shadow:0 3px 18px #0002}
h1,h2,h3{margin:0} .brand{text-align:center;border-bottom:2px solid #f7d117;padding-bottom:10px;margin-bottom:15px} .brand h1{font-size:15px} .brand h2{font-size:13px;margin-top:3px}
.section-title{font-size:12px;background:#193b68;color:white;padding:6px 9px;margin:14px 0 8px} .identity{display:grid;grid-template-columns:1fr 1fr;gap:5px 18px} .identity div{border-bottom:1px solid #aaa;padding:3px 0}
table{width:100%;border-collapse:collapse;font-size:9px} th{background:#e8edf4;border:1px solid #9aa7b8;padding:6px 4px} td{border:1px solid #b3bdc9;padding:6px 4px;vertical-align:middle} .center{text-align:center} .number{text-align:right;white-space:nowrap} .total td{font-weight:bold;background:#f3f5f8} .muted{color:#555;font-size:8px}
.route-block{page-break-before:always} .route-block h3{border-left:5px solid #f7d117;padding:6px 8px;background:#eef2f7;font-size:13px} .route-data{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:9px 0} .route-data div{background:#f6f7f9;padding:6px;text-align:center} .links a{color:#0057b8} figure{margin:8px 0 14px;page-break-inside:avoid} figure img{display:block;width:100%;border:1px solid #aaa} figcaption{font-size:9px;text-align:center;color:#555;margin-top:3px}
.statement{text-align:justify} .signature{margin-top:22px;display:grid;grid-template-columns:1fr 1fr;gap:16px} .line{border-top:1px solid #222;padding-top:3px;text-align:center;margin-top:30px} .meta{margin-top:12px;font-size:8px;color:#666} .no-print{position:fixed;right:20px;top:20px;background:#0057b8;color:white;border:0;padding:10px 16px;border-radius:5px;cursor:pointer}
@media print{body{background:white} .page{box-shadow:none;margin:0;padding:0;width:auto;min-height:auto} .no-print{display:none} a{color:#000;text-decoration:underline}}`;
function reportHtml(rep) {
  const u = rep.configuracao.usuario, g = rep.configuracao.gestor, it = rep.deslocamentos;
  const totalKm = it.reduce((s, x) => s + x.km_total, 0), totalV = it.reduce((s, x) => s + x.valor_ressarcir, 0);
  const n2 = (n) => String(n).padStart(2, "0");
  const rows = it.map((x) => `<tr><td class="center">${x.numero}</td><td class="center">${displayDate(x.data)}</td><td>${esc(x.origem_formatada)}</td><td><strong>${esc(x.empresa)}</strong><br><span class="muted">${esc(x.destino_formatado)}</span></td><td class="number">${km1(x.km_total)}</td><td class="number">${brl(x.valor_km)}</td><td class="number"><strong>${brl(x.valor_ressarcir)}</strong></td></tr>`).join("");
  const routes = it.map((x) => `<section class="route-block"><h3>Rota ${n2(x.numero)} - ${esc(x.empresa)}</h3><div class="route-data"><div><b>Data:</b> ${displayDate(x.data)}</div><div><b>Ida:</b> ${km1(x.km_ida)} km</div><div><b>Retorno:</b> ${km1(x.km_retorno)} km</div><div><b>Total:</b> ${km1(x.km_total)} km</div></div><p><b>Origem:</b> ${esc(x.origem_formatada)}<br><b>Destino:</b> ${esc(x.destino_formatado)}</p><p class="links"><a href="${esc(x.link_ida)}" target="_blank" rel="noopener">Abrir roteiro de ida no Google Maps</a> &nbsp;|&nbsp; <a href="${esc(x.link_retorno)}" target="_blank" rel="noopener">Abrir roteiro de retorno no Google Maps</a></p><figure><img src="${esc(x.mapa_ida)}" alt="Rota ${n2(x.numero)} de ida"><figcaption>Rota ${n2(x.numero)} - ida</figcaption></figure><figure><img src="${esc(x.mapa_retorno)}" alt="Rota ${n2(x.numero)} de retorno"><figcaption>Rota ${n2(x.numero)} - retorno</figcaption></figure></section>`).join("");
  const gerado = new Date(rep.gerado_em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Declaração de deslocamento ${esc(rep.id)}</title><style>${REPORT_CSS}</style></head><body><main class="page">
<div class="brand"><h1>BANCO DO BRASIL S.A.</h1><h2>DECLARAÇÃO DE DESLOCAMENTO A SERVIÇO</h2><h2>RESSARCIMENTO POR QUILÔMETRO RODADO</h2></div>
<h2 class="section-title">1. IDENTIFICAÇÃO DO(A) FUNCIONÁRIO(A)</h2><div class="identity"><div><b>Nome:</b> ${esc(u.nome)}</div><div><b>Matrícula:</b> ${esc(u.matricula)}</div><div><b>Cargo/Função:</b> ${esc(u.cargo)}</div><div><b>Lotação:</b> ${esc(u.lotacao)}</div></div>
<h2 class="section-title">2. DADOS DO DESLOCAMENTO</h2><p>Declaro, para fins de solicitação de ressarcimento por quilômetro rodado, que realizei deslocamento a serviço do Banco do Brasil, conforme informações abaixo:</p>
<table><thead><tr><th style="width:5%">Nº</th><th style="width:10%">Data</th><th style="width:21%">Origem</th><th>Destino/Empresa</th><th style="width:9%">Km total</th><th style="width:11%">Valor/km</th><th style="width:13%">Ressarcimento</th></tr></thead><tbody>${rows}<tr class="total"><td colspan="4" class="number">TOTAL</td><td class="number">${km1(totalKm)}</td><td></td><td class="number">${brl(totalV)}</td></tr></tbody></table>
<h2 class="section-title">3. ROTA EFETIVAMENTE REALIZADA</h2><p>As imagens, os endereços reconhecidos e os links dos roteiros estão identificados pela mesma numeração da tabela acima.</p>${routes}
<section><h2 class="section-title">4. DECLARAÇÃO</h2><p class="statement">Declaro que as informações acima são <b>verdadeiras</b>, <b>completas</b> e <b>correspondem ao deslocamento efetivamente realizado a serviço</b>, estando ciente de que a prestação de informações inexatas ou indevidas poderá ensejar a apuração de responsabilidades administrativas, nos termos da normatização interna vigente.</p>
<p>Local e data: ${esc(u.cidade_emissao)}, ____/____/________</p><div class="signature"><div class="line">Assinatura do(a) declarante<br>${esc(u.nome)}</div><div class="line">Matrícula<br>${esc(u.matricula)}</div></div>
<h2 class="section-title">5. CONFERÊNCIA E ATESTE DO GESTOR</h2><p>Atesto que conferi as informações prestadas, bem como a pertinência do deslocamento declarado com as atividades funcionais desempenhadas pelo(a) funcionário(a).</p><p>( &nbsp; ) De acordo &nbsp;&nbsp;&nbsp; ( &nbsp; ) Em desacordo</p><p><b>Observações:</b> ____________________________________________________________________________________</p><p>Local e data: ________________________________, ____/____/________</p><div class="signature"><div class="line">Assinatura do gestor<br>${esc(g.nome)}</div><div class="line">Cargo / Matrícula<br>${esc(g.cargo)} - ${esc(g.matricula)}</div></div>
<p class="meta">Relatório ${esc(rep.id)}. Rotas calculadas em ${gerado}. Valor por km congelado na geração: ${brl(u.valor_km)}. Rotas e imagens: Geoapify. Dados cartográficos: © OpenStreetMap contributors.</p></section></main></body></html>`;
}

/* ---------------- armazenamento dos relatórios (IndexedDB, só neste navegador) ---------------- */
function db() { return new Promise((res, rej) => { const r = indexedDB.open("prestacao-deslocamentos", 1); r.onupgradeneeded = () => r.result.createObjectStore("relatorios", { keyPath: "id" }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function store(mode, fn) { const d = await db(); return new Promise((res, rej) => { const tx = d.transaction("relatorios", mode); const req = fn(tx.objectStore("relatorios")); tx.oncomplete = () => res(req && req.result); tx.onerror = () => rej(tx.error); }); }
const saveReport = (r) => store("readwrite", (s) => s.put(r));
const getReport = (id) => store("readonly", (s) => s.get(id));
const allReports = () => store("readonly", (s) => s.getAll());
const deleteReport = (id) => store("readwrite", (s) => s.delete(id));

function openReport(rep, print = false) {
  const url = URL.createObjectURL(new Blob([rep.html], { type: "text/html" }));
  const w = window.open(url, "_blank");
  if (!w) { msg("O navegador bloqueou a nova janela. Permita pop-ups para este site.", "error"); return; }
  if (print) w.addEventListener("load", () => setTimeout(() => w.print(), 300));
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function downloadReport(rep) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([rep.html], { type: "text/html" }));
  a.download = `relatorio_${rep.id}.html`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
async function loadReports() {
  let list = [];
  try { list = (await allReports()).sort((a, b) => b.id.localeCompare(a.id)); } catch {}
  const box = $("#reports");
  if (!list.length) { box.innerHTML = "<p>Nenhum relatório gerado ainda. Importe uma planilha para começar.</p>"; return; }
  box.innerHTML = list.map((x) => `<div class="report-card"><strong>Relatório ${esc(x.id)}</strong><p>${esc(x.usuario || "Sem nome")}, ${x.quantidade} deslocamento(s), ${brl(x.total)}</p><p>${new Date(x.gerado_em).toLocaleString("pt-BR")}</p><div class="actions"><button class="primary" data-a="print" data-id="${esc(x.id)}">Imprimir / PDF</button><button class="secondary" data-a="open" data-id="${esc(x.id)}">Abrir</button><button class="secondary" data-a="down" data-id="${esc(x.id)}">Baixar HTML</button><button class="delete" data-a="del" data-id="${esc(x.id)}">Excluir</button></div></div>`).join("");
  box.querySelectorAll("button[data-a]").forEach((b) => (b.onclick = async () => {
    const id = b.dataset.id;
    if (b.dataset.a === "del") { if (confirm("Excluir este relatório deste navegador?")) { await deleteReport(id); loadReports(); } return; }
    const rep = await getReport(id); if (!rep) return;
    if (b.dataset.a === "down") downloadReport(rep); else openReport(rep, b.dataset.a === "print");
  }));
}

$("#process").onclick = async () => {
  if (!items.length) return;
  const cfg = loadConfig();
  if (!configOk(cfg)) { msg("Cadastre seu nome e o valor por km em Configurações antes de gerar o relatório.", "error"); fillConfig(); $("#config").showModal(); return; }
  $("#process").disabled = true; $("#st4").className = "active";
  try {
    const { deslocamentos, avisos } = await processRoutes(items, cfg, (t) => msg(esc(t)));
    const now = new Date(), p = (n) => String(n).padStart(2, "0");
    const id = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
    const rep = { id, gerado_em: now.toISOString(), configuracao: cfg, deslocamentos };
    const html = reportHtml(rep);
    await saveReport({ id, gerado_em: rep.gerado_em, usuario: cfg.usuario.nome, quantidade: deslocamentos.length, total: deslocamentos.reduce((s, x) => s + x.valor_ressarcir, 0), html });
    msg(`Relatório gerado. Use "Imprimir / PDF" na lista abaixo.${avisos.length ? "<ul>" + avisos.map((a) => `<li>${esc(a)}</li>`).join("") + "</ul>" : ""}`, avisos.length ? "warn" : "success");
    $("#st4").className = "done";
    loadReports();
  } catch (e) {
    msg(esc(e.message), "error"); $("#st4").className = "";
    if (precisaCodigo) { fillConfig(); $("#config").showModal(); }
  } finally { $("#process").disabled = false; }
};

updateSteps();
loadReports();

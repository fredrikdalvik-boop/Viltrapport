// =============================================================
// Rondering – kartan delas i rutor som blir gröna där man varit
// =============================================================
// Rutorna är röda tills de ronderats. En ruta är grön i "greenDays" dagar,
// blir sedan gradvis orange under lika lång tid och är röd igen efter 2 × greenDays.
// Med GPS blir rutorna inom radien kring dig gröna. Man kan också trycka på rutor själv.
// Bara rutans mittpunkt, vem och när sparas (tabellen patrol_visits) – inte GPS-spåret.
//
// Ronderingen har en egen flik med en egen karta (patrolMap). På den vanliga kartan kan
// rutnätet visas eller döljas med knappen "🚶 Rutnät".
// Filen laddas före app.js och använder app.js variabler (map, db, $ …) först när den körs.

const PATROL = {
  DEFAULTS: { grid: 100, greenDays: 7 },
  GRIDS: [50, 100, 200, 250, 500],        // rutstorlekar admin kan välja (meter)
  RADII: [25, 50, 100, 200],              // radie kring dig när GPS är på (meter)
  MAX_ACCURACY: 100,                      // sämre GPS än så här (meter) markerar inga rutor
  SAME_USER_GAP_H: 2,                     // samma person i samma ruta sparas högst en gång per 2 h
  FALLBACK_HALF_SIZE: 4000,               // utan yttergräns: rutor ±4 km kring kartans mitt
  LOAD_DAYS: 62,                          // så här många dagar bakåt hämtas (räcker för 30 + 30)
  MIN_ZOOM: 11,                           // rutorna ritas inte när man zoomat ut mer än så här
};

let patrolCfg = { ...PATROL.DEFAULTS };
let patrolCfgMeta = null;     // vem/när inställningarna senast ändrades
let patrolVisits = [];        // { id, user_id, lat, lng, method, visited_at }
let patrolLast = new Map();   // ruta → senaste besöket
let patrolBorder = null;      // yttergränsen från GPX-filen: [[lat, lng], …]
let patrolCells = null;       // rutorna som ingår (inom yttergränsen), { keys: Set, list: [[i, j]] }
let patrolLayer = null;       // rutnätet på den vanliga kartan
let patrolMap = null;         // ronderingsflikens karta
let patrolMapLayer = null;    // rutnätet på ronderingsflikens karta
let patrolBorderLine = null;  // yttergränsen ritad på ronderingskartan
let patrolObsLayer = null;    // observationerna på ronderingskartan (fylls av renderMarkers i app.js)

const patrol = {
  open: false,       // visas ronderingsfliken?
  gps: false,        // är GPS-ronderingen igång?
  manual: false,     // trycker man på rutor själv?
  reporting: false,  // väntar på ett tryck för en ny observation?
  draft: null,       // nålen för den nya observationen på ronderingskartan
  watchId: null,
  wakeLock: null,
  pos: null,         // senaste position { lat, lng, accuracy }
  marker: null,
  circle: null,
  sessionCells: 0,   // rutor som blivit gröna under den här ronderingen
  myManual: new Map(),   // ruta → id för rutor man själv markerat nyss (kan ångras)
  queue: loadPatrolQueue(),
  flushing: false,
  flushTimer: null,
  redrawTimer: null,
};

const PATROL_RADIUS_KEY = 'viltrapport-patrol-radius';
const PATROL_QUEUE_KEY = 'viltrapport-patrol-queue';

let patrolRadius = (() => {
  try { return Number(localStorage.getItem(PATROL_RADIUS_KEY)) || 50; } catch { return 50; }
})();

// ---------- Inställningar ----------

function applyPatrolConfig(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const grid = PATROL.GRIDS.includes(Number(c.grid)) ? Number(c.grid) : PATROL.DEFAULTS.grid;
  const days = Math.round(Number(c.greenDays));
  const greenDays = Number.isFinite(days) ? Math.min(30, Math.max(1, days)) : PATROL.DEFAULTS.greenDays;
  const changed = grid !== patrolCfg.grid;
  patrolCfg = { grid, greenDays };
  if (changed) patrolCells = null;
}

// ---------- Rutnätet ----------
// Rutorna räknas i meter från kartans mitt (räcker gott för en flygplats).

const PATROL_ORIGIN = CONFIG.MAP_CENTER;
const PATROL_KX = Math.cos(PATROL_ORIGIN[0] * Math.PI / 180) * 111320;
const PATROL_KY = 110540;

const toMeters = (lat, lng) => [(lng - PATROL_ORIGIN[1]) * PATROL_KX, (lat - PATROL_ORIGIN[0]) * PATROL_KY];
const toLatLng = (x, y) => [PATROL_ORIGIN[0] + y / PATROL_KY, PATROL_ORIGIN[1] + x / PATROL_KX];
const cellKey = (i, j) => `${i}:${j}`;

function cellAt(lat, lng, g = patrolCfg.grid) {
  const [x, y] = toMeters(lat, lng);
  return [Math.floor(x / g), Math.floor(y / g)];
}
function cellCenter(i, j, g = patrolCfg.grid) {
  return toLatLng((i + 0.5) * g, (j + 0.5) * g);
}
// [[syd, väst], [nord, öst]]
function cellBounds(i, j, g = patrolCfg.grid) {
  return [toLatLng(i * g, j * g), toLatLng((i + 1) * g, (j + 1) * g)];
}

function pointInPolygon([lat, lng], poly) {
  let inside = false;
  for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
    const [ya, xa] = poly[a];
    const [yb, xb] = poly[b];
    if ((ya > lat) !== (yb > lat) && lng < ((xb - xa) * (lat - ya)) / (yb - ya) + xa) inside = !inside;
  }
  return inside;
}

// Vilka rutor som ingår: de vars mitt eller något hörn ligger innanför yttergränsen
function buildPatrolCells() {
  const g = patrolCfg.grid;
  const keys = new Set();
  const list = [];
  let box;
  if (patrolBorder?.length > 2) {
    const lats = patrolBorder.map((p) => p[0]);
    const lngs = patrolBorder.map((p) => p[1]);
    box = [cellAt(Math.min(...lats), Math.min(...lngs)), cellAt(Math.max(...lats), Math.max(...lngs))];
  } else {
    const n = Math.ceil(PATROL.FALLBACK_HALF_SIZE / g);
    box = [[-n, -n], [n - 1, n - 1]];
  }
  for (let i = box[0][0]; i <= box[1][0]; i++) {
    for (let j = box[0][1]; j <= box[1][1]; j++) {
      if (patrolBorder?.length > 2) {
        const [[s, w], [n, e]] = cellBounds(i, j);
        const pts = [cellCenter(i, j), [s, w], [s, e], [n, w], [n, e]];
        if (!pts.some((p) => pointInPolygon(p, patrolBorder))) continue;
      }
      keys.add(cellKey(i, j));
      list.push([i, j]);
    }
  }
  patrolCells = { keys, list };
}

function ensurePatrolCells() {
  if (!patrolCells) buildPatrolCells();
  return patrolCells;
}

// Anropas från loadAreas() när GPX-filens yttergräns lästs in
// Ändras gränsen (t.ex. en större yttergräns i GPX-filen) räknas rutorna om – nya rutor fylls i automatiskt.
function setPatrolBorder(points) {
  patrolBorder = points;
  patrolCells = null;
  rebuildPatrolLast();
  drawPatrolBorder();
  redrawPatrol();
  renderPatrolBar();
}

function drawPatrolBorder() {
  if (!patrolMap || !patrolBorder) return;
  patrolBorderLine?.remove();
  patrolBorderLine = L.polygon(patrolBorder, { color: '#ffd60a', weight: 3, fillOpacity: 0, interactive: false }).addTo(patrolMap);
}

// ---------- Färger ----------

// Två färgscheman. "Kromosom-läge" = färger som går att skilja åt även vid färgblindhet
// (blått/orange/vinrött från Okabe–Ito och Tol, kontrollerade för rött-grön- och blå-gul-blindhet).
const PATROL_PALETTES = {
  normal: { fresh: 'hsl(130, 65%, 38%)', mid: 'hsl(30, 85%, 48%)', old: 'hsl(4, 80%, 48%)', names: ['grönt', 'orange', 'rött'] },
  cvd:    { fresh: '#0072b2', mid: '#e69f00', old: '#882255', names: ['blått', 'orange', 'vinrött'] },
};
const PATROL_CVD_KEY = 'viltrapport-patrol-cvd';
let patrolCvd = (() => { try { return localStorage.getItem(PATROL_CVD_KEY) === '1'; } catch { return false; } })();
const patrolPalette = () => PATROL_PALETTES[patrolCvd ? 'cvd' : 'normal'];
const patrolOldColor = () => patrolPalette().old;

// Blanda två #rrggbb-färger (t = 0 → a, t = 1 → b)
function mixHex(a, b, t) {
  const n = (h, i) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  return `rgb(${[0, 1, 2].map((i) => Math.round(n(a, i) + (n(b, i) - n(a, i)) * t)).join(',')})`;
}

// Ålder i dagar → färg. null = aldrig ronderad.
function patrolColor(ageDays) {
  const x = patrolCfg.greenDays;
  const pal = patrolPalette();
  if (ageDays == null || ageDays >= 2 * x) return pal.old;
  if (ageDays <= x) return pal.fresh;
  const t = (ageDays - x) / x;
  // Kromosom-läge: orange → vinrött (blått används bara för nyss ronderat)
  if (patrolCvd) return mixHex(pal.mid, pal.old, t);
  // Grön → orange → röd under nästa period (snabbt mot orange, sedan sakta mot rött)
  return `hsl(${Math.round(100 * (1 - t) ** 1.4)}, 85%, 46%)`;
}

function setPatrolCvd(on) {
  patrolCvd = on;
  try { localStorage.setItem(PATROL_CVD_KEY, on ? '1' : ''); } catch { /* privat läge */ }
  redrawPatrol();
  renderPatrolBar();
  if (typeof renderPatrolStats === 'function' && !$('stats-view').hidden) renderPatrolStats();
}

function patrolState(ageDays) {
  const x = patrolCfg.greenDays;
  if (ageDays == null || ageDays >= 2 * x) return 'red';
  return ageDays <= x ? 'green' : 'orange';
}

const ageDaysOf = (iso) => (Date.now() - new Date(iso).getTime()) / 86400000;

// Senaste besöket per ruta (för det rutnät som gäller nu)
function rebuildPatrolLast() {
  patrolLast = new Map();
  for (const v of patrolVisits) {
    const [i, j] = cellAt(v.lat, v.lng);
    const key = cellKey(i, j);
    const prev = patrolLast.get(key);
    if (!prev || new Date(v.visited_at) > new Date(prev.visited_at)) patrolLast.set(key, v);
  }
}

// ---------- Kartlagret ----------
// Ett canvaslager som ritar rutorna bit för bit (snabbt även med tusentals rutor).

const PatrolGrid = L.GridLayer.extend({
  createTile(coords) {
    const tile = document.createElement('canvas');
    const size = this.getTileSize();
    tile.width = size.x;
    tile.height = size.y;
    drawPatrolTile(this._map, tile.getContext('2d'), coords, size);
    return tile;
  },
});

// Ett rutnätslager för en karta (den vanliga eller ronderingskartan)
function createPatrolLayer(targetMap, opacity = 0.38) {
  targetMap.createPane('patrolPane').style.zIndex = 350;   // över kartbilden, under områden och nålar
  return new PatrolGrid({ pane: 'patrolPane', opacity, minZoom: PATROL.MIN_ZOOM, updateWhenZooming: false });
}

function redrawPatrol() {
  patrolLayer?.redraw();
  patrolMapLayer?.redraw();
}

function drawPatrolTile(map, ctx, coords, size) {
  const { list, keys } = ensurePatrolCells();
  if (!list.length) return;
  const z = coords.z;
  const origin = coords.scaleBy(size);
  const nw = map.unproject(origin, z);
  const se = map.unproject(origin.add(size), z);
  const [i0, j0] = cellAt(se.lat, nw.lng);
  const [i1, j1] = cellAt(nw.lat, se.lng);
  const lines = z >= 15;
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      const key = cellKey(i, j);
      if (!keys.has(key)) continue;
      const last = patrolLast.get(key);
      const [[s, w], [n, e]] = cellBounds(i, j);
      const a = map.project([n, w], z).subtract(origin);
      const b = map.project([s, e], z).subtract(origin);
      ctx.fillStyle = patrolColor(last ? ageDaysOf(last.visited_at) : null);
      ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
      if (lines) ctx.strokeRect(a.x + 0.5, a.y + 0.5, b.x - a.x - 1, b.y - a.y - 1);
    }
  }
}

// Rita om högst var 1,5 sekund (GPS kan ge många positioner i rad)
function schedulePatrolRedraw() {
  if (patrol.redrawTimer) return;
  patrol.redrawTimer = setTimeout(() => {
    patrol.redrawTimer = null;
    redrawPatrol();
    renderPatrolBar();
  }, 1500);
}

// ---------- Hämta och spara ----------

function patrolSince() {
  return new Date(Date.now() - PATROL.LOAD_DAYS * 86400000).toISOString();
}

// Anropas från loadReports()
function setPatrolData(visits, configRow) {
  if (configRow) {
    applyPatrolConfig(configRow.config);
    patrolCfgMeta = configRow;
  }
  // Rader som ännu inte nått databasen (kö) ska fortfarande synas
  const pending = patrol.queue.map((v) => ({ ...v, id: null, user_id: currentUser?.id }));
  patrolVisits = [...(visits ?? patrolVisits.filter((v) => !v.tmp)), ...pending];
  rebuildPatrolLast();
  redrawPatrol();
  renderPatrolBar();
}

function loadPatrolQueue() {
  try { return JSON.parse(localStorage.getItem(PATROL_QUEUE_KEY) || '[]'); } catch { return []; }
}
function savePatrolQueue() {
  try { localStorage.setItem(PATROL_QUEUE_KEY, JSON.stringify(patrol.queue)); } catch { /* privat läge */ }
}

// Skicka sparade rutor till databasen. Utan nät ligger de kvar i telefonen och skickas sen.
async function flushPatrolQueue() {
  if (!patrol.queue.length || !currentUser || !navigator.onLine) return;
  if (patrol.flushing) return;
  patrol.flushing = true;
  const batch = patrol.queue.slice(0, 200);
  const { data, error } = await db.from('patrol_visits')
    .insert(batch.map(({ tmp, ...v }) => v))
    .select('id, user_id, lat, lng, method, visited_at');
  patrol.flushing = false;
  if (error?.code === '23514' && patrol.queue.some((v) => v.method === 'filled')) {
    patrol.queue.forEach((v) => { if (v.method === 'filled') v.method = 'manual'; });
    savePatrolQueue();
    return flushPatrolQueue();
  }
  if (error) {
    console.warn('Rondering sparades inte än:', error.message);
    patrol.flushFailed = true;
    renderPatrolBar();
    setTimeout(flushPatrolQueue, 30000);
    return;
  }
  patrol.flushFailed = false;
  const sent = new Set(batch.map((v) => v.tmp));
  patrol.queue = patrol.queue.filter((v) => !sent.has(v.tmp));
  savePatrolQueue();
  // Byt ut de lokala raderna mot de sparade (som har id)
  patrolVisits = [...patrolVisits.filter((v) => !sent.has(v.tmp)), ...(data ?? [])];
  for (const row of data ?? []) if (row.method === 'manual') patrol.myManual.set(cellKey(...cellAt(row.lat, row.lng)), row.id);
  rebuildPatrolLast();
  if (patrol.queue.length) flushPatrolQueue();
}

function scheduleFlush() {
  clearTimeout(patrol.flushTimer);
  patrol.flushTimer = setTimeout(flushPatrolQueue, patrol.queue.length >= 25 ? 0 : 8000);
}

// Har jag själv varit i rutan nyss? Då sparas den inte igen.
function visitedByMeRecently(key) {
  const limit = Date.now() - PATROL.SAME_USER_GAP_H * 3600000;
  return patrolVisits.some((v) => v.user_id === currentUser?.id && new Date(v.visited_at).getTime() > limit
    && cellKey(...cellAt(v.lat, v.lng)) === key);
}

// Markera en ruta som ronderad (läggs i kön och syns direkt)
// method: gps, manual eller filled (ifylld sträcka). at = tid (standard nu).
function markCell(i, j, method, at = new Date()) {
  const key = cellKey(i, j);
  if (!ensurePatrolCells().keys.has(key) || visitedByMeRecently(key)) return false;
  const [lat, lng] = cellCenter(i, j);
  const visit = { tmp: `${Date.now()}-${Math.random()}`, lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)), method, visited_at: at.toISOString() };
  patrol.queue.push(visit);
  savePatrolQueue();
  const local = { ...visit, id: null, user_id: currentUser?.id };
  patrolVisits.push(local);
  patrolLast.set(key, local);
  patrol.sessionCells++;
  scheduleFlush();
  return true;
}

// ---------- GPS ----------

// Rutor som ligger (helt eller delvis) inom radien kring en punkt
function cellsWithin(lat, lng, radius) {
  const g = patrolCfg.grid;
  const [x, y] = toMeters(lat, lng);
  const out = [];
  for (let i = Math.floor((x - radius) / g); i <= Math.floor((x + radius) / g); i++) {
    for (let j = Math.floor((y - radius) / g); j <= Math.floor((y + radius) / g); j++) {
      const dx = Math.max(i * g - x, 0, x - (i + 1) * g);
      const dy = Math.max(j * g - y, 0, y - (j + 1) * g);
      if (Math.hypot(dx, dy) <= radius) out.push([i, j]);
    }
  }
  return out;
}

function onPatrolPosition(p) {
  const { latitude: lat, longitude: lng, accuracy } = p.coords;
  const first = !patrol.pos;
  patrol.pos = { lat, lng, accuracy };
  $('patrol-warning').hidden = true;
  if (patrolMap) {
    if (!patrol.marker) {
      patrol.circle = L.circle([lat, lng], { radius: patrolRadius, color: '#1565c0', weight: 2, fillOpacity: 0.08, interactive: false }).addTo(patrolMap);
      patrol.marker = L.circleMarker([lat, lng], { radius: 8, color: '#fff', weight: 3, fillColor: '#1565c0', fillOpacity: 1, interactive: false }).addTo(patrolMap);
    } else {
      patrol.marker.setLatLng([lat, lng]);
      patrol.circle.setLatLng([lat, lng]).setRadius(patrolRadius);
    }
    // Följ med på kartan: visa dig första gången och när du närmar dig kanten (panelen till höger räknas bort)
    if (patrol.open) {
      if (first) patrolMap.setZoom(Math.max(patrolMap.getZoom(), 16), { animate: false });
      followMe([lat, lng]);
    }
  }

  if (accuracy <= PATROL.MAX_ACCURACY) {
    // Glapp i GPS:en (släckt skärm, appen omstartad …)? Jämför med senaste säkra positionen.
    const now = Date.now();
    if (patrol.lastFix && now - patrol.lastFix.t > GAP_MIN_SECONDS * 1000) offerGapFill(patrol.lastFix, { lat, lng, t: now });
    saveLastFix({ lat, lng, t: now });
    let changed = false;
    for (const [i, j] of cellsWithin(lat, lng, patrolRadius)) changed = markCell(i, j, 'gps') || changed;
    if (changed) schedulePatrolRedraw();
  }
  renderPatrolBar();
}

function onPatrolError(err) {
  const texts = {
    1: 'Appen får inte använda platsen. Tillåt plats för sidan i telefonens inställningar.',
    2: 'Hittar ingen GPS-signal just nu.',
    3: 'GPS:en svarar inte. Försöker igen …',
  };
  $('patrol-warning').textContent = texts[err.code] ?? err.message;
  $('patrol-warning').hidden = false;
  if (err.code === 1) stopPatrolGps();
}

async function keepScreenOn() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      patrol.wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch { /* stöds inte – då kan skärmen slockna */ }
}

function startPatrolGps() {
  if (!('geolocation' in navigator)) {
    $('patrol-warning').textContent = 'Den här webbläsaren kan inte läsa av platsen.';
    $('patrol-warning').hidden = false;
    return;
  }
  patrol.gps = true;
  patrol.sessionCells = 0;
  // Startades appen om mitt i en rondering? Jämför första positionen med den sparade.
  const saved = loadLastFix();
  patrol.lastFix = saved && Date.now() - saved.t < GAP_MAX_HOURS * 3600000 ? saved : null;
  $('patrol-warning').hidden = true;
  patrol.watchId = navigator.geolocation.watchPosition(onPatrolPosition, onPatrolError,
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  keepScreenOn();
  renderPatrolBar();
}

function stopPatrolGps() {
  if (patrol.watchId !== null) navigator.geolocation.clearWatch(patrol.watchId);
  patrol.watchId = null;
  patrol.gps = false;
  patrol.pos = null;
  clearLastFix();
  patrol.wakeLock?.release().catch(() => {});
  patrol.wakeLock = null;
  patrol.marker?.remove();
  patrol.circle?.remove();
  patrol.marker = null;
  patrol.circle = null;
  if (!$('pocket').hidden) closePocket();
  flushPatrolQueue();
  redrawPatrol();
  renderPatrolBar();
}

// Skärmlåset släpps när man byter app eller släcker skärmen – ta tillbaka det när man kommer tillbaka.
// En webbapp får inte läsa GPS:en när skärmen är släckt, så säg till om det blev ett glapp.
let patrolHiddenAt = null;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    patrolHiddenAt = patrol.gps ? Date.now() : null;
    return;
  }
  if (!patrol.gps) return;
  keepScreenOn();
  patrolHiddenAt = null;
  // Själva glappet upptäcks i onPatrolPosition: nästa position jämförs med den förra
});

// ---------- Fylla i sträckan när GPS:en varit pausad ----------
// Webbläsaren stoppar GPS:en när skärmen släcks. Har man förflyttat sig under tiden
// kan rutorna längs en rak linje mellan punkterna fyllas i (method 'filled').

const PATROL_LASTFIX_KEY = 'viltrapport-patrol-lastfix';
const GAP_MIN_SECONDS = 30;      // så här länge utan GPS-position räknas som ett glapp
const GAP_MIN_METERS = 150;      // kortare förflyttning än så frågar vi inte om
const GAP_MAX_METERS = 20000;    // längre än så är troligen fel
const GAP_MAX_HOURS = 3;         // äldre position än så används inte

function saveLastFix(fix) {
  patrol.lastFix = fix;
  try { localStorage.setItem(PATROL_LASTFIX_KEY, JSON.stringify(fix)); } catch { /* privat läge */ }
}
function loadLastFix() {
  try { return JSON.parse(localStorage.getItem(PATROL_LASTFIX_KEY) || 'null'); } catch { return null; }
}
function clearLastFix() {
  patrol.lastFix = null;
  try { localStorage.removeItem(PATROL_LASTFIX_KEY); } catch { /* privat läge */ }
}

function metersBetween(a, b) {
  const [ax, ay] = toMeters(a.lat, a.lng);
  const [bx, by] = toMeters(b.lat, b.lng);
  return Math.hypot(bx - ax, by - ay);
}

function offerGapFill(from, to) {
  const dist = metersBetween(from, to);
  const hours = (to.t - from.t) / 3600000;
  if (dist < Math.max(GAP_MIN_METERS, patrolRadius * 2) || dist > GAP_MAX_METERS || hours > GAP_MAX_HOURS || hours <= 0) return;
  const min = Math.max(1, Math.round((to.t - from.t) / 60000));
  const distText = dist >= 1000 ? `${(dist / 1000).toFixed(1).replace('.', ',')} km` : `${Math.round(dist / 10) * 10} m`;
  $('gap-text').textContent = `Du verkar ha flyttat dig ${distText} på ${min} min utan GPS-signal. ` +
    'Vill du fylla i sträckan mellan punkterna? Rutorna längs en rak linje blir gröna och märks som ifyllda.';
  $('gap-dialog').hidden = false;
  $('gap-yes').onclick = () => { $('gap-dialog').hidden = true; fillGap(from, to); };
  $('gap-no').onclick = () => { $('gap-dialog').hidden = true; };
}

// Rutor längs en rak linje mellan två punkter, med tider jämnt fördelade över glappet
function fillGap(from, to) {
  const [ax, ay] = toMeters(from.lat, from.lng);
  const [bx, by] = toMeters(to.lat, to.lng);
  const dist = Math.hypot(bx - ax, by - ay);
  const step = Math.max(5, patrolCfg.grid / 3);
  const steps = Math.max(1, Math.ceil(dist / step));
  let count = 0;
  for (let k = 0; k <= steps; k++) {
    const f = k / steps;
    const [lat, lng] = toLatLng(ax + (bx - ax) * f, ay + (by - ay) * f);
    const at = new Date(from.t + (to.t - from.t) * f);
    for (const [i, j] of cellsWithin(lat, lng, patrolRadius)) if (markCell(i, j, 'filled', at)) count++;
  }
  redrawPatrol();
  renderPatrolBar();
  showToast(count ? `${count} ${count === 1 ? 'ruta' : 'rutor'} ifyllda längs sträckan` : 'Inga nya rutor att fylla i');
}

// ---------- Fickläge ----------
// Svart skärm som drar lite ström. Skärmen är tekniskt på, så GPS:en fortsätter.
// Avsluta genom att hålla in knappen en sekund (så att det inte händer av misstag i fickan).
let pocketTimer = null;
let pocketHold = null;
function openPocket() {
  if (!patrol.gps) return;
  $('pocket').hidden = false;
  keepScreenOn();
  updatePocket();
  pocketTimer = setInterval(updatePocket, 5000);
}
function closePocket() {
  $('pocket').hidden = true;
  clearInterval(pocketTimer);
  renderPatrolBar();
}
function updatePocket() {
  if ($('pocket').hidden) return;
  if (!patrol.gps) { closePocket(); return; }
  const acc = patrol.pos ? `GPS ±${Math.round(patrol.pos.accuracy)} m` : 'Söker GPS …';
  $('pocket-status').textContent = `🚶 Rondering pågår · ${patrol.sessionCells} nya rutor · ${acc}`;
}
window.addEventListener('online', () => flushPatrolQueue());

// ---------- Markera rutor själv ----------

// Tryck på ronderingskartan: ny observation, markera ruta – eller ett tips om inget läge är valt
function patrolMapClick(latlng) {
  // Formuläret är öppet: trycket flyttar nålen (som på vanliga kartan)
  if (patrol.draft && !$('sheet').hidden) {
    patrol.draft.setLatLng(latlng);
    placeDraftMarker(latlng);
    return true;
  }
  if (patrol.reporting) {
    startPatrolReport(latlng);
    return true;
  }
  if (!patrol.manual) {
    showToast('Välj ✋ Markera rutor eller ➕ Ny observation först');
    return false;
  }
  const [i, j] = cellAt(latlng.lat, latlng.lng);
  const key = cellKey(i, j);
  if (!ensurePatrolCells().keys.has(key)) {
    showToast('Rutan ligger utanför området');
    return true;
  }
  // Tryck igen på en ruta du nyss markerat = ångra
  if (patrol.myManual.has(key) || patrol.queue.some((v) => v.method === 'manual' && cellKey(...cellAt(v.lat, v.lng)) === key)) {
    undoManualCell(key);
    return true;
  }
  if (markCell(i, j, 'manual')) {
    flashCell(i, j);
    redrawPatrol();
    renderPatrolBar();
  } else {
    showToast('Du har redan ronderat rutan de senaste 2 timmarna');
  }
  return true;
}

// Kort markering runt rutan man tryckte på, så att man ser att det tog
function flashCell(i, j) {
  if (!patrolMap) return;
  const box = L.rectangle(cellBounds(i, j), { color: '#fff', weight: 4, fillColor: '#2e7d32', fillOpacity: 0.55, interactive: false }).addTo(patrolMap);
  setTimeout(() => box.remove(), 900);
}

// ---------- Ny observation under ronderingen ----------
// Formuläret är detsamma som på vanliga kartan. Nålen visas på ronderingskartan
// och samma position används för rapporten (draftMarker på vanliga kartan).

function startPatrolReport(latlng) {
  patrol.reporting = false;
  removePatrolDraft();
  patrol.draft = L.marker(latlng, { draggable: true, autoPan: true }).addTo(patrolMap);
  patrol.draft.on('dragend', () => placeDraftMarker(patrol.draft.getLatLng()));
  placeDraftMarker(latlng);
  openSheet();
  renderPatrolBar();
  // Flytta kartan så att nålen syns ovanför formuläret
  setTimeout(() => {
    const sheet = $('sheet').offsetHeight || 0;
    patrolMap.panInside(latlng, { paddingTopLeft: [30, 30], paddingBottomRight: [IS_MOBILE ? 30 : $('patrol-bar').offsetWidth + 40, (IS_MOBILE ? sheet : 0) + 40] });
  }, 60);
}

function removePatrolDraft() {
  patrol.draft?.remove();
  patrol.draft = null;
}

// ---------- Observationer på ronderingskartan ----------

function setPatrolObs(on) {
  saveLayerPrefs({ patrolObs: on });
  if (patrolMap && patrolObsLayer) {
    if (on && !patrolMap.hasLayer(patrolObsLayer)) patrolObsLayer.addTo(patrolMap);
    if (!on) patrolObsLayer.remove();
  }
  updatePatrolFilterUI();
  render();
  renderPatrolBar();
}

// Filterknappen och filterraden behövs i ronderingen bara när observationerna visas där
function updatePatrolFilterUI(viewId = patrol.open ? 'patrol-view' : null) {
  const hide = viewId === 'patrol-view' && !layerPrefs.patrolObs;
  document.querySelector('.filter-bar').hidden = hide;
  $('filter-open').hidden = hide;
}

async function undoManualCell(key) {
  const sameCell = (v) => cellKey(...cellAt(v.lat, v.lng)) === key;
  patrol.queue = patrol.queue.filter((v) => !(v.method === 'manual' && sameCell(v)));
  savePatrolQueue();
  const id = patrol.myManual.get(key);
  patrol.myManual.delete(key);
  if (id) {
    const { error } = await db.from('patrol_visits').delete().eq('id', id);
    if (error) { showToast(translateError(error)); return; }
  }
  patrolVisits = patrolVisits.filter((v) => !(v.method === 'manual' && v.user_id === currentUser?.id && sameCell(v)
    && (v.id === id || v.id === null)));
  patrol.sessionCells = Math.max(0, patrol.sessionCells - 1);
  rebuildPatrolLast();
  redrawPatrol();
  renderPatrolBar();
  showToast('Rutan är inte längre markerad');
}

// ---------- Panelen ----------

function patrolCoverage() {
  const { list } = ensurePatrolCells();
  const count = { green: 0, orange: 0, red: 0 };
  for (const [i, j] of list) {
    const last = patrolLast.get(cellKey(i, j));
    count[patrolState(last ? ageDaysOf(last.visited_at) : null)]++;
  }
  return { ...count, total: list.length };
}

// Håll positionen synlig i den del av kartan som inte täcks av panelen
function followMe(latlng) {
  // Menyn eller ikonerna ligger till höger – håll positionen till vänster om dem
  const panel = $('patrol-bar').hidden ? 64 : $('patrol-bar').offsetWidth;
  patrolMap.panInside(latlng, { paddingTopLeft: [50, 60], paddingBottomRight: [panel + 50, 60] });
}

// Ronderingsflikens karta skapas första gången fliken visas (Leaflet behöver synlig storlek)
function initPatrolMap() {
  if (patrolMap) {
    patrolMap.invalidateSize();
    return;
  }
  patrolMap = L.map('patrol-map', { zoomControl: !IS_TOUCH }).setView(map ? map.getCenter() : CONFIG.MAP_CENTER, Math.max(map?.getZoom() ?? 0, 14));
  const streets = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, className: 'tiles-streets',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-bidragsgivare',
  });
  const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, attribution: 'Bild &copy; Esri &mdash; Källa: Esri, Maxar, Earthstar Geographics och GIS User Community',
  });
  (layerPrefs.patrolBase === 'Satellit' ? satellite : streets).addTo(patrolMap);
  // Panelen ligger till höger – lagerknapp och upphovstext till vänster
  L.control.layers({ 'Karta': streets, 'Satellit': satellite }, null, { collapsed: true, position: 'topleft' }).addTo(patrolMap);
  patrolMap.attributionControl.setPosition('bottomleft');
  patrolMap.on('baselayerchange', (e) => saveLayerPrefs({ patrolBase: e.name }));
  patrolMapLayer = createPatrolLayer(patrolMap, 0.5).addTo(patrolMap);
  patrolObsLayer = L.layerGroup();
  if (layerPrefs.patrolObs) patrolObsLayer.addTo(patrolMap);
  drawPatrolBorder();
  patrolMap.on('click', (e) => patrolMapClick(e.latlng));
  render();   // fyller observationerna
}

// Anropas från switchTab()
function onPatrolTab(visible) {
  patrol.open = visible;
  if (!visible) return;
  initPatrolMap();
  // Startar man fliken med GPS igång: visa var man är
  if (patrol.pos && !patrol.marker) onPatrolPosition({ coords: { latitude: patrol.pos.lat, longitude: patrol.pos.lng, accuracy: patrol.pos.accuracy } });
  else if (patrol.pos) followMe([patrol.pos.lat, patrol.pos.lng]);
  renderPatrolBar();
}

// Vid utloggning
function stopPatrol() {
  if (patrol.gps) stopPatrolGps();
  patrol.manual = false;
  patrol.reporting = false;
}

// Rutnätet på den vanliga kartan: knappen "🚶 Rutnät" (och lagerknappen)
function setMainPatrolGrid(on) {
  if (!patrolLayer || !map) return;
  if (on && !map.hasLayer(patrolLayer)) patrolLayer.addTo(map);
  if (!on && map.hasLayer(patrolLayer)) patrolLayer.remove();
  saveLayerPrefs({ patrol: on });
  syncPatrolToggle();
}
function syncPatrolToggle() {
  const on = Boolean(patrolLayer && map?.hasLayer(patrolLayer));
  const text = on ? 'Dölj ronderingsrutor' : 'Visa ronderingsrutor';
  $('patrol-toggle').title = text;
  $('patrol-toggle').setAttribute('aria-label', text);
  $('patrol-toggle').setAttribute('aria-pressed', String(on));
  $('patrol-toggle').classList.toggle('on', on);
}

function setPatrolMenu(open) {
  $('patrol-bar').hidden = !open;
  $('patrol-fab').hidden = open;
  $('patrol-menu').setAttribute('aria-expanded', String(open));
  renderPatrolBar();
}

// Ikonerna när menyn är stängd + kort text högst upp när man är i ett läge
function renderPatrolFab() {
  const fab = $('patrol-gps-fab');
  const weak = patrol.gps && (!patrol.pos || patrol.pos.accuracy > PATROL.MAX_ACCURACY);
  fab.classList.toggle('on', patrol.gps && !weak);
  fab.classList.toggle('weak', weak);
  fab.setAttribute('aria-pressed', String(patrol.gps));
  const label = !patrol.gps ? 'Starta GPS' : weak ? 'GPS igång – svag signal. Tryck för att stoppa' : 'GPS igång. Tryck för att stoppa';
  fab.title = label;
  fab.setAttribute('aria-label', label);
  $('patrol-gps-count').hidden = !patrol.gps || !patrol.sessionCells;
  $('patrol-gps-count').textContent = patrol.sessionCells;

  $('patrol-pocket-fab').hidden = !patrol.gps;
  const mode = patrol.reporting ? 'report' : patrol.manual ? 'manual' : '';
  $('patrol-mode-fab').hidden = !mode;
  $('patrol-mode-fab').textContent = mode === 'report' ? '➕' : '✋';
  $('patrol-mode-fab').className = `fab fab-mode ${mode}`;
  $('patrol-mode-fab').title = mode === 'report' ? 'Avbryt ny observation' : 'Sluta markera rutor';
  $('patrol-mode-fab').setAttribute('aria-label', $('patrol-mode-fab').title);

  let hint = '';
  if (patrol.reporting) hint = '➕ Tryck på kartan där djuret är';
  else if (patrol.manual) hint = `✋ Tryck på rutorna du ser · ${patrol.sessionCells} nya`;
  else if (weak) hint = patrol.pos ? `📡 Svag GPS (±${Math.round(patrol.pos.accuracy)} m)` : '📡 Söker GPS …';
  $('patrol-hint').hidden = !hint || !$('patrol-bar').hidden;
  $('patrol-hint').textContent = hint;
}

function renderPatrolBar() {
  if ($('patrol-fab')) renderPatrolFab();
  if (!$('patrol-view') || $('patrol-view').hidden) return;
  const c = patrolCoverage();
  const pct = (n) => (c.total ? Math.round((n / c.total) * 100) : 0);
  const x = patrolCfg.greenDays;

  $('patrol-gps').textContent = patrol.gps ? '⏸ Pausa GPS' : '▶ Starta GPS';
  $('patrol-gps').classList.toggle('btn-primary', !patrol.gps);
  $('patrol-gps').classList.toggle('btn-secondary', patrol.gps);
  $('patrol-manual').classList.toggle('selected', patrol.manual);
  $('patrol-manual').textContent = patrol.manual ? '✋ Klar' : '✋ Markera rutor';
  $('patrol-report').classList.toggle('selected', patrol.reporting);
  $('patrol-report').textContent = patrol.reporting ? '✕ Avbryt' : '➕ Ny observation';
  $('patrol-obs').innerHTML = [['', 'Dölj'], ['1', 'Visa']].map(([v, label]) =>
    `<button type="button" data-obs="${v}" class="${Boolean(v) === Boolean(layerPrefs.patrolObs) ? 'selected' : ''}">${label}</button>`).join('');
  patrolMap?.getContainer().classList.toggle('patrol-manual', patrol.manual);
  $('patrol-center').hidden = !patrol.pos;

  let status;
  if (patrol.reporting) status = '➕ Tryck på kartan där djuret är';
  else if (patrol.gps && !patrol.pos) status = '📡 Söker GPS …';
  else if (patrol.gps && patrol.pos.accuracy > PATROL.MAX_ACCURACY) status = `📡 Dålig GPS (±${Math.round(patrol.pos.accuracy)} m) – inga rutor markeras`;
  else if (patrol.gps) status = `🟢 Rondering pågår · GPS ±${Math.round(patrol.pos.accuracy)} m · ${patrol.sessionCells} nya rutor`;
  else if (patrol.manual) status = `✋ Tryck på rutorna du ser (igen = ångra) · ${patrol.sessionCells} nya`;
  else status = '🚶 Rondering';
  $('patrol-status').textContent = status;
  const queued = patrol.queue.length;
  $('patrol-queue').hidden = !queued || (navigator.onLine && !patrol.flushFailed);
  $('patrol-queue').textContent = `☁️ ${queued} ${queued === 1 ? 'ruta' : 'rutor'} väntar på nät och skickas automatiskt`;

  const pal = patrolPalette();
  $('patrol-coverage').innerHTML = `
    <span class="pc" style="flex:${c.green || 0.001};background:${pal.fresh}"></span><span class="pc" style="flex:${c.orange || 0.001};background:${pal.mid}"></span><span class="pc" style="flex:${c.red || 0.001};background:${pal.old}"></span>`;
  $('patrol-legend').innerHTML = `
    <span><i class="sw" style="background:${patrolColor(0)}"></i>${pct(c.green)} % ${pal.names[0]} (0–${x} d)</span>
    <span><i class="sw" style="background:${patrolColor(x * 1.4)}"></i>${pct(c.orange)} % ${pal.names[1]}</span>
    <span><i class="sw" style="background:${pal.old}"></i>${pct(c.red)} % ${pal.names[2]} (${2 * x}+ d)</span>`;
  $('patrol-cvd').classList.toggle('selected', patrolCvd);
  $('patrol-cvd').setAttribute('aria-pressed', String(patrolCvd));
  $('patrol-pocket').hidden = !patrol.gps;

  $('patrol-radius').innerHTML = PATROL.RADII.map((r) =>
    `<button type="button" data-radius="${r}" class="${r === patrolRadius ? 'selected' : ''}">${r} m</button>`).join('');

  // Inställningar: alla ser dem, bara admin ändrar
  $('patrol-grid').innerHTML = PATROL.GRIDS.map((g) => `<option value="${g}">${g} × ${g} m</option>`).join('');
  $('patrol-grid').value = patrolCfg.grid;
  $('patrol-days').value = patrolCfg.greenDays;
  $('patrol-grid').disabled = !isAdmin;
  $('patrol-days').disabled = !isAdmin;
  $('patrol-cfg-save').hidden = !isAdmin;
  $('patrol-cfg-hint').textContent = isAdmin
    ? `${c.total} rutor inom yttergränsen.`
    : `Bara admin kan ändra. ${c.total} rutor inom yttergränsen.`;
}

async function savePatrolConfig() {
  const config = { grid: Number($('patrol-grid').value), greenDays: Number($('patrol-days').value) };
  if (!(config.greenDays >= 1 && config.greenDays <= 30)) {
    showToast('Grön i: välj 1–30 dagar');
    return;
  }
  const { error } = await db.from('patrol_config').update({ config }).eq('id', 1);
  if (error) {
    showToast(translateError(error));
    return;
  }
  applyPatrolConfig(config);
  rebuildPatrolLast();
  redrawPatrol();
  renderPatrolBar();
  showToast('Ronderingsinställningarna är sparade');
}

function initPatrolUI() {
  $('patrol-toggle').addEventListener('click', () => setMainPatrolGrid(!(patrolLayer && map?.hasLayer(patrolLayer))));
  $('patrol-gps').addEventListener('click', () => (patrol.gps ? stopPatrolGps() : startPatrolGps()));
  $('patrol-manual').addEventListener('click', () => {
    patrol.manual = !patrol.manual;
    patrol.reporting = false;
    if (patrol.manual) {
      setPatrolMenu(false);
      if (!patrol.gps) patrol.sessionCells = 0;
      // Zooma in så att rutorna är stora nog att trycka på
      if (patrolMap && patrolMap.getZoom() < 16) patrolMap.setZoom(16);
    }
    renderPatrolBar();
  });
  $('patrol-report').addEventListener('click', () => {
    patrol.reporting = !patrol.reporting;
    patrol.manual = false;
    if (patrol.reporting) setPatrolMenu(false);
    renderPatrolBar();
  });
  $('patrol-obs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-obs]');
    if (b) setPatrolObs(Boolean(b.dataset.obs));
  });
  $('patrol-center').addEventListener('click', () => {
    if (!patrol.pos || !patrolMap) return;
    patrolMap.setZoom(Math.max(patrolMap.getZoom(), 16), { animate: false });
    followMe([patrol.pos.lat, patrol.pos.lng]);
  });
  $('patrol-radius').addEventListener('click', (e) => {
    const b = e.target.closest('[data-radius]');
    if (!b) return;
    patrolRadius = Number(b.dataset.radius);
    try { localStorage.setItem(PATROL_RADIUS_KEY, String(patrolRadius)); } catch { /* privat läge */ }
    patrol.circle?.setRadius(patrolRadius);
    renderPatrolBar();
  });
  $('patrol-cfg-save').addEventListener('click', savePatrolConfig);
  $('patrol-cvd').addEventListener('click', () => setPatrolCvd(!patrolCvd));
  $('patrol-pocket').addEventListener('click', openPocket);
  $('patrol-pocket-fab').addEventListener('click', openPocket);
  // Håll in en sekund för att lämna fickläget
  const exit = $('pocket-exit');
  const startHold = (e) => {
    e.preventDefault();
    exit.classList.add('holding');
    pocketHold = setTimeout(() => { exit.classList.remove('holding'); closePocket(); }, 1000);
  };
  const stopHold = () => { clearTimeout(pocketHold); exit.classList.remove('holding'); };
  exit.addEventListener('pointerdown', startHold);
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => exit.addEventListener(ev, stopHold));
  exit.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') closePocket(); });
  // Menyn: stängd som standard (bara ikoner), ☰ öppnar, ✕ stänger
  $('patrol-menu').addEventListener('click', () => setPatrolMenu(true));
  $('patrol-close').addEventListener('click', () => setPatrolMenu(false));
  $('patrol-gps-fab').addEventListener('click', () => (patrol.gps ? stopPatrolGps() : startPatrolGps()));
  // Ikonen för läget (✋ eller ➕): tryck = avsluta läget
  $('patrol-mode-fab').addEventListener('click', () => {
    patrol.manual = false;
    patrol.reporting = false;
    renderPatrolBar();
  });
  $('patrol-bar').querySelector('.patrol-settings').addEventListener('toggle', (e) => {
    $('patrol-bar').classList.toggle('wide', e.target.open);
  });
}

// ---------- Statistik och export ----------

// Ronderade rutor per person och sätt (senaste 30 dagarna)
function patrolStats(days = 30) {
  const since = Date.now() - days * 86400000;
  const recent = patrolVisits.filter((v) => new Date(v.visited_at).getTime() >= since);
  const byUser = new Map();
  const byMethod = { gps: 0, manual: 0, filled: 0 };
  for (const v of recent) {
    byUser.set(v.user_id, (byUser.get(v.user_id) ?? 0) + 1);
    byMethod[v.method] = (byMethod[v.method] ?? 0) + 1;
  }
  return { recent, byUser: [...byUser].sort((a, b) => b[1] - a[1]), byMethod };
}

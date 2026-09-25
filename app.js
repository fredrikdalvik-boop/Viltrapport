// =============================================================
// Viltrapport – appens logik
// =============================================================

// Kommer man från en inbjudnings- eller återställningslänk ska man välja lösenord.
// Kontrollera detta innan Supabase hinner läsa och rensa adressen.
let needsNewPassword = /type=(invite|recovery)/.test(location.hash);

const db = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

// Appens tillstånd
let currentUser = null;
let reports = [];
let map = null;
let markerLayer = null;
let draftMarker = null;   // nålen man placerar innan man sparar
let editingId = null;     // id på rapporten som redigeras, annars null
let userColors = new Map();   // user_id → vald färg
let customSpecies = [];       // arter som användarna lagt till själva
let profiles = [];            // alla användares profiler (e-post, admin …)
let isAdmin = false;          // är den inloggade admin?
let riskZones = [];           // banor, taxibanor och stängsel (ritas av admin)
let reportActions = [];       // åtgärder på rapporter (skrämt bort …)
let riskLayer = null;         // kartlager som visar riskzonerna
let riskConfigMeta = null;    // vem/när riskinställningarna senast ändrades

// Färger man kan välja mellan
const COLORS = [
  '#e53935', '#d81b60', '#8e24aa', '#3949ab', '#1e88e5', '#00acc1', '#00897b',
  '#43a047', '#9e9d24', '#fdd835', '#fb8c00', '#6d4c41', '#546e7a', '#212121',
];

const $ = (id) => document.getElementById(id);

// ---------- Hjälpfunktioner ----------

// Gör text säker att visa (skyddar mot att någon skriver in HTML-kod)
function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function formatDateTime(iso) {
  return new Date(iso).toLocaleString('sv-SE', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

// Datum som "ÅÅÅÅ-MM-DD" i lokal tid
function localDate(iso) {
  return new Date(iso).toLocaleDateString('sv-SE');
}

// Värde till datetime-local-fältet (lokal tid)
function toLocalInput(date) {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function showToast(text) {
  const toast = $('toast');
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 3000);
}

function translateError(error) {
  const msg = error?.message || String(error);
  if (/Invalid login credentials/i.test(msg)) return 'Fel e-post eller lösenord.';
  if (/Email not confirmed/i.test(msg)) return 'E-postadressen är inte bekräftad ännu.';
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return 'Ingen kontakt med servern. Kontrollera uppkopplingen.';
  if (/Password should be at least/i.test(msg)) return 'Lösenordet är för kort.';
  if (/rate limit/i.test(msg)) return 'För många försök. Vänta en stund och försök igen.';
  if (/already registered/i.test(msg)) return 'Det finns redan ett konto med den e-postadressen. Logga in i stället.';
  if (/Signups not allowed/i.test(msg)) return 'Det går inte att skapa konton just nu. Kontakta en admin.';
  if (/Bara admin|minst 6 tecken|egen admin/i.test(msg)) return msg;
  return 'Något gick fel: ' + msg;
}

// ---------- Arter och ikoner ----------

// Alla arter (inbyggda + användarnas egna), sökbara på namn med små bokstäver
function speciesIndex() {
  const index = new Map();
  for (const [name, group] of window.SPECIES) index.set(name.toLowerCase(), { name, group });
  for (const s of customSpecies) {
    const key = s.name.toLowerCase();
    if (!index.has(key)) index.set(key, { name: s.name, group: s.category });
  }
  return index;
}

function findKnownSpecies(name) {
  return speciesIndex().get(String(name ?? '').trim().toLowerCase()) ?? null;
}

// Kontrollerar om telefonen kan visa en viss ikon (nyare ikoner saknas på äldre telefoner)
const emojiCache = {};
function emojiSupported(emoji) {
  if (emoji in emojiCache) return emojiCache[emoji];
  let ok = true;
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = '32px sans-serif';
    if (emoji.includes('\u200d')) {
      // Sammansatt ikon som inte stöds blir två ikoner bredvid varandra
      ok = ctx.measureText(emoji).width < ctx.measureText('🐦').width * 1.5;
    } else {
      canvas.width = canvas.height = 40;
      ctx.font = '32px sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText(emoji, 0, 0);
      const d = ctx.getImageData(0, 0, 40, 40).data;
      ok = false;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] > 50 && (Math.abs(d[i] - d[i + 1]) > 25 || Math.abs(d[i + 1] - d[i + 2]) > 25)) {
          ok = true;
          break;
        }
      }
    }
  } catch {
    ok = true;
  }
  return (emojiCache[emoji] = ok);
}

// Ikon för en art (eller direkt för en grupp om groupKey anges)
function iconFor(speciesName, groupKey) {
  const key = groupKey ?? findKnownSpecies(speciesName)?.group;
  const group = window.SPECIES_GROUPS[key] ?? window.SPECIES_GROUPS.ovrigt;
  return group.fallback && !emojiSupported(group.icon) ? group.fallback : group.icon;
}

function fillCategorySelect() {
  const options = Object.entries(window.SPECIES_GROUPS)
    .map(([key, g]) => `<option value="${key}">${g.icon} ${escapeHtml(g.label)}</option>`)
    .join('');
  $('category').innerHTML = '<option value="">Välj typ …</option>' + options;
}
fillCategorySelect();

// Visa "Ny art!"-rutan om man skrivit en art som inte finns i listan
// (men inte medan förslagslistan visas – då håller man troligen på att skriva)
function updateCategoryVisibility() {
  const value = $('species').value.trim();
  const isNew = value.length > 0 && !findKnownSpecies(value) && $('species-suggestions').hidden;
  $('category-wrap').hidden = !isNew;
  $('category').required = isNew;
  updateBirdFields();
}

// ---------- Flock, fågelns läge och biotop i formuläret ----------

let selectedPosition = '';
let selectedHabitat = '';

// Är det valda djuret en fågel? (känd art, eller ny art med vald fågelgrupp)
function formIsBird() {
  const known = findKnownSpecies($('species').value.trim());
  const group = known ? known.group : $('category').value;
  return window.SPECIES_GROUPS[group]?.kind === 'fagel';
}

// Flock och läge visas bara för fåglar. Vid flock behövs inget antal.
function updateBirdFields() {
  const bird = formIsBird();
  $('flock-wrap').hidden = !bird;
  $('position-wrap').hidden = !bird;
  const flock = bird && $('is-flock').checked;
  $('animal-count').required = !flock;
  $('animal-count').placeholder = flock ? 'ca antal' : '';
  $('count-label').textContent = flock ? 'Ungefärligt antal (valfritt)' : 'Antal';
}

function renderChoiceChips() {
  $('bird-position').innerHTML = Object.entries(window.BIRD_POSITIONS).map(([k, t]) =>
    `<button type="button" data-position="${k}" class="${k === selectedPosition ? 'selected' : ''}">${t.icon} ${t.label}</button>`).join('');
  $('habitat').innerHTML = Object.entries(window.HABITATS).map(([k, t]) =>
    `<button type="button" data-habitat="${k}" class="${k === selectedHabitat ? 'selected' : ''}">${t.icon} ${t.label}</button>`).join('');
}

// Tryck igen på ett valt alternativ för att ta bort valet
$('bird-position').addEventListener('click', (e) => {
  const b = e.target.closest('[data-position]');
  if (!b) return;
  selectedPosition = selectedPosition === b.dataset.position ? '' : b.dataset.position;
  renderChoiceChips();
});
$('habitat').addEventListener('click', (e) => {
  const b = e.target.closest('[data-habitat]');
  if (!b) return;
  selectedHabitat = selectedHabitat === b.dataset.habitat ? '' : b.dataset.habitat;
  renderChoiceChips();
});

$('is-flock').addEventListener('change', () => {
  // Flock: töm antalet "1" så att man inte råkar spara en flock med 1 djur
  if ($('is-flock').checked && $('animal-count').value === '1') $('animal-count').value = '';
  if (!$('is-flock').checked && !$('animal-count').value) $('animal-count').value = 1;
  updateBirdFields();
});
$('category').addEventListener('change', updateBirdFields);

// ---------- Fler arter i samma observation ----------
// Varje extra art blir en egen rapport med samma plats, tid, biotop, väder och kommentar.
// Rapporterna får samma sighting_id så att de hör ihop.

let extraSeq = 0;

function fillSpeciesDatalist() {
  $('species-datalist').innerHTML = [...speciesIndex().values()].map((sp) => `<option value="${escapeHtml(sp.name)}">`).join('');
}

function addExtraSpecies() {
  fillSpeciesDatalist();
  const row = document.createElement('div');
  row.className = 'extra-species';
  row.dataset.extra = ++extraSeq;
  row.innerHTML = `
    <div class="extra-head">
      <strong class="extra-title"></strong>
      <button type="button" class="extra-remove" aria-label="Ta bort arten">✕ Ta bort</button>
    </div>
    <input type="text" class="extra-name" list="species-datalist" autocomplete="off" maxlength="100"
           placeholder="Art, t.ex. Fälthare" aria-label="Art">
    <div class="extra-category new-species" hidden>
      <label>Ny art! Vilken sorts djur är det?</label>
      <select>${$('category').innerHTML}</select>
    </div>
    <div class="extra-bird" hidden>
      <label class="check"><input type="checkbox" class="extra-flock"> 🐦🐦🐦 Flock – antalet är okänt</label>
      <div class="chipset extra-position">${Object.entries(window.BIRD_POSITIONS).map(([k, t]) =>
        `<button type="button" data-xposition="${k}">${t.icon} ${t.label}</button>`).join('')}</div>
    </div>
    <div class="stepper">
      <button type="button" class="btn btn-secondary" data-xstep="-1" aria-label="Minska">−</button>
      <input class="extra-count" type="number" inputmode="numeric" min="1" max="10000" value="1" aria-label="Antal">
      <button type="button" class="btn btn-secondary" data-xstep="1" aria-label="Öka">+</button>
    </div>`;
  $('extra-species').append(row);
  numberExtras();
  updateExtraRow(row);
  row.querySelector('.extra-name').focus();
}

// "Art 2", "Art 3" … i ordning
function numberExtras() {
  [...$('extra-species').children].forEach((row, i) => { row.querySelector('.extra-title').textContent = `Art ${i + 2}`; });
}

function extraGroup(row) {
  const name = row.querySelector('.extra-name').value.trim();
  const known = findKnownSpecies(name);
  return { name, known, group: known ? known.group : row.querySelector('.extra-category select').value };
}

// Visa gruppval för ny art och flock/läge för fåglar
function updateExtraRow(row) {
  const { name, known, group } = extraGroup(row);
  row.querySelector('.extra-category').hidden = !name || Boolean(known);
  const bird = window.SPECIES_GROUPS[group]?.kind === 'fagel';
  row.querySelector('.extra-bird').hidden = !bird;
  const count = row.querySelector('.extra-count');
  count.placeholder = bird && row.querySelector('.extra-flock').checked ? 'ca antal' : '';
}

$('add-species').addEventListener('click', addExtraSpecies);
$('extra-species').addEventListener('input', (e) => {
  const row = e.target.closest('.extra-species');
  if (row) updateExtraRow(row);
});
$('extra-species').addEventListener('change', (e) => {
  const row = e.target.closest('.extra-species');
  if (!row) return;
  if (e.target.classList.contains('extra-flock')) {
    const count = row.querySelector('.extra-count');
    if (e.target.checked && count.value === '1') count.value = '';
    if (!e.target.checked && !count.value) count.value = 1;
  }
  updateExtraRow(row);
});
$('extra-species').addEventListener('click', (e) => {
  const row = e.target.closest('.extra-species');
  if (!row) return;
  if (e.target.closest('.extra-remove')) {
    row.remove();
    $('form-message').textContent = '';
    numberExtras();
    return;
  }
  const pos = e.target.closest('[data-xposition]');
  if (pos) {
    const was = pos.classList.contains('selected');
    row.querySelectorAll('[data-xposition]').forEach((b) => b.classList.remove('selected'));
    pos.classList.toggle('selected', !was);
  }
  const step = e.target.closest('[data-xstep]');
  if (step) {
    const input = row.querySelector('.extra-count');
    const value = (parseInt(input.value, 10) || 0) + Number(step.dataset.xstep);
    const flock = row.querySelector('.extra-flock').checked && !row.querySelector('.extra-bird').hidden;
    input.value = value < 1 && flock ? '' : Math.min(10000, Math.max(1, value));
  }
});

// Läser de extra arterna. Ger { list: [...] } eller { error, focus }.
function collectExtras() {
  const list = [];
  for (const row of $('extra-species').children) {
    const title = row.querySelector('.extra-title').textContent;
    const { name, known, group } = extraGroup(row);
    if (!name) return { error: `${title}: skriv vilken art, eller ta bort raden.`, focus: row.querySelector('.extra-name') };
    if (!known && !group) return { error: `${title}: ny art – välj vilken sorts djur det är.`, focus: row.querySelector('.extra-category select') };
    const bird = window.SPECIES_GROUPS[group]?.kind === 'fagel';
    const flock = bird && row.querySelector('.extra-flock').checked;
    const raw = row.querySelector('.extra-count').value.trim();
    const count = raw === '' ? null : parseInt(raw, 10);
    if (count === null ? !flock : !(count >= 1 && count <= 10000)) {
      return { error: `${title}: fyll i antal (1–10 000)${bird ? ' eller kryssa i Flock' : ''}.`, focus: row.querySelector('.extra-count') };
    }
    list.push({
      species: known ? known.name : name.charAt(0).toUpperCase() + name.slice(1),
      newCategory: known ? null : group,
      animal_count: count,
      is_flock: flock,
      bird_position: bird ? row.querySelector('[data-xposition].selected')?.dataset.xposition ?? null : null,
    });
  }
  return { list };
}

// Sparar en ny art i listan så att alla får den som förslag
async function saveCustomSpecies(name, category) {
  if (findKnownSpecies(name)) return;
  const { error } = await db.from('custom_species').insert({ name, category: category || 'ovrigt' });
  // 23505 = arten finns redan (någon annan hann före) – det gör inget
  if (error && error.code !== '23505') console.warn('Kunde inte spara ny art:', error.message);
  if (!error) customSpecies.push({ name, category: category || 'ovrigt' });
}

function newSightingId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Snabbval när man inte ser exakt vilken art det är
$('quick-picks').innerHTML = (window.QUICK_PICKS || []).map((name) =>
  `<button type="button" data-pick="${escapeHtml(name)}">${iconFor(name)} ${escapeHtml(name.replace(' (okänd art)', ''))}</button>`).join('');
$('quick-picks').addEventListener('click', (e) => {
  const b = e.target.closest('[data-pick]');
  if (!b) return;
  $('species').value = b.dataset.pick;
  hideSuggestions();
  $('quick-picks-wrap').open = false;
});

// Namnet som visas för en användare: för- och efternamn om det finns, annars e-posten
function nameFor(userId, fallbackEmail) {
  const p = profiles.find((x) => x.user_id === userId);
  return p?.full_name || p?.email || fallbackEmail || 'okänd';
}

// ---------- Antal, flock, läge och biotop ----------

// "3 st", "flock" eller "flock, ca 40"
function countText(r) {
  if (r.is_flock) return r.animal_count ? `flock, ca ${r.animal_count}` : 'flock';
  return `${r.animal_count ?? 1} st`;
}

// Antal som risken räknar med (flock utan antal = RISK.FLOCK_UNKNOWN_COUNT)
function riskCount(r) {
  return r.animal_count ?? (r.is_flock ? RISK.FLOCK_UNKNOWN_COUNT : 1);
}

// Fågelns läge och biotop, t.ex. "☁️ I luften · 🌾 Långt gräs"
function fieldsText(r) {
  const parts = [];
  const pos = window.BIRD_POSITIONS[r.bird_position];
  const hab = window.HABITATS[r.habitat];
  if (pos) parts.push(`${pos.icon} ${pos.label}`);
  if (hab) parts.push(`${hab.icon} ${hab.label}`);
  return parts.join(' · ');
}
function fieldsLine(r, tag = 'span') {
  const text = fieldsText(r);
  return text ? `<${tag} class="obs-fields">${escapeHtml(text)}</${tag}>` : '';
}

// Rapporter som hör till samma observation (samma sighting_id). Byggs om vid varje laddning.
let sightingMap = null;
function sightingGroup(r) {
  if (!r.sighting_id) return [r];
  if (!sightingMap) {
    sightingMap = new Map();
    for (const x of reports) {
      if (!x.sighting_id) continue;
      if (!sightingMap.has(x.sighting_id)) sightingMap.set(x.sighting_id, []);
      sightingMap.get(x.sighting_id).push(x);
    }
    for (const list of sightingMap.values()) list.sort((a, b) => a.id - b.id);
  }
  return sightingMap.get(r.sighting_id) ?? [r];
}
function companions(r) {
  return sightingGroup(r).filter((x) => x.id !== r.id);
}
function companionsLine(r, tag = 'span') {
  const c = companions(r);
  if (!c.length) return '';
  return `<${tag} class="obs-fields">👥 Tillsammans med: ${c.map((x) =>
    `${iconFor(x.species)} ${escapeHtml(x.species)} (${escapeHtml(countText(x))})`).join(', ')}</${tag}>`;
}

// Nål i rapportörens färg. Flock ritas som en hög med tre nålar.
function pinHtml(r) {
  const c = colorFor(r.user_id);
  return `<div class="pin${r.is_flock ? ' pin-flock' : ''}" style="background:${c};--c:${c}">${iconFor(r.species)}</div>`;
}

// Får den inloggade ändra/ta bort rapporten?
function canEdit(report) {
  return isAdmin || report.user_id === currentUser?.id;
}

// ---------- Rapporttyper ----------

const REPORT_TYPES = {
  observation: { label: 'Observation', plural: 'Observationer', emoji: null },
  olycka:      { label: 'Olycka',      plural: 'Olyckor',       emoji: '🚗' },
  birdstrike:  { label: 'Birdstrike',  plural: 'Birdstrikes',   emoji: '✈️' },
};
let selectedType = 'observation';

function typeOf(report) {
  return REPORT_TYPES[report.report_type] ? report.report_type : 'observation';
}

// Varningstriangel med en ikon i (bil eller flygplan). color = liten prick för rapportören.
function triangleHtml(emoji, color) {
  return `<span class="tri"><svg viewBox="0 0 44 40" aria-hidden="true">
      <path d="M22 3 L41 37 H3 Z" fill="#ffd60a" stroke="#d32f2f" stroke-width="4" stroke-linejoin="round"/>
    </svg><span class="tri-emoji">${emoji}</span>${color ? `<span class="tri-dot" style="background:${color}"></span>` : ''}</span>`;
}

// Liten etikett "⚠ Olycka" i listan och i nålens ruta
function typeBadge(report) {
  const t = REPORT_TYPES[typeOf(report)];
  return t.emoji ? `<span class="type-badge">${triangleHtml(t.emoji)} ${t.label}</span>` : '';
}

// Fyll i trianglarna i knapparna (element med data-triangle="🚗")
document.querySelectorAll('[data-triangle]').forEach((el) => { el.innerHTML = triangleHtml(el.dataset.triangle); });

function setReportType(type) {
  selectedType = REPORT_TYPES[type] ? type : 'observation';
  document.querySelectorAll('#type-picker [data-type]').forEach((b) => {
    b.classList.toggle('selected', b.dataset.type === selectedType);
  });
  const isStrike = selectedType !== 'observation';
  $('species-label').textContent = isStrike ? 'Viltslag' : 'Djurslag';
  const verb = editingId ? 'Redigera' : 'Ny';
  $('sheet-title').textContent = selectedType === 'observation'
    ? (editingId ? 'Redigera rapport' : 'Ny rapport')
    : `${verb} ${REPORT_TYPES[selectedType].label.toLowerCase()}`;
}

$('type-picker').addEventListener('click', (e) => {
  const b = e.target.closest('[data-type]');
  if (b) setReportType(b.dataset.type);
});

// ---------- Färger ----------

function defaultColor(userId) {
  let sum = 0;
  for (const ch of String(userId)) sum += ch.charCodeAt(0);
  return COLORS[sum % COLORS.length];
}

function colorFor(userId) {
  return userColors.get(userId) ?? defaultColor(userId);
}

function renderColorPicker() {
  const mine = colorFor(currentUser?.id);
  $('color-picker').innerHTML = COLORS.map((c) => `
    <button type="button" class="swatch ${c === mine ? 'selected' : ''}" data-color="${c}"
            style="background:${c}" aria-label="Välj färg ${c}"></button>`).join('');
}

$('color-picker').addEventListener('click', async (e) => {
  const swatch = e.target.closest('[data-color]');
  if (!swatch) return;
  const color = swatch.dataset.color;
  const message = $('settings-message');
  message.textContent = '';

  const { error } = await db.from('profiles').update({ color }).eq('user_id', currentUser.id);
  if (error) {
    message.textContent = translateError(error);
    return;
  }
  userColors.set(currentUser.id, color);
  renderColorPicker();
  render();
  showToast('Din färg är sparad');
});

// ---------- Inställningar ----------

function openSettings() {
  closeSheet();
  closeRisk();
  closeRiskConfig();
  closeFilter();
  $('user-email').textContent = (currentUser?.email ?? '') + (isAdmin ? ' (admin)' : '');
  $('settings-message').textContent = '';
  $('export-message').textContent = '';
  const me = profiles.find((p) => p.user_id === currentUser?.id);
  $('my-name').value = me?.full_name ?? '';
  $('my-name-hint').hidden = Boolean(me?.full_name);
  renderColorPicker();
  $('admin-section').hidden = !isAdmin;
  if (isAdmin) renderAdmin();
  $('settings-sheet').hidden = false;
}

$('my-name-save').addEventListener('click', async () => {
  const message = $('settings-message');
  message.className = 'message';
  const name = $('my-name').value.trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 80) {
    message.textContent = 'Skriv ditt för- och efternamn (2–80 tecken).';
    return;
  }
  const { error } = await db.from('profiles').update({ full_name: name }).eq('user_id', currentUser.id);
  if (error) {
    message.textContent = translateError(error);
    return;
  }
  showToast('Ditt namn är sparat');
  await loadReports();
  openSettings();
});

// ---------- Tema (ljust/mörkt) ----------
// 'auto' = följ telefonens inställning. Valet sparas i webbläsaren.

const THEME_KEY = 'viltrapport-theme';

function getTheme() {
  try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch { return 'auto'; }
}

function applyTheme(choice) {
  if (choice === 'light' || choice === 'dark') document.documentElement.dataset.theme = choice;
  else delete document.documentElement.dataset.theme;
  document.querySelectorAll('#theme-picker [data-theme-choice]').forEach((b) => {
    b.classList.toggle('selected', b.dataset.themeChoice === choice);
  });
}

$('theme-picker').addEventListener('click', (e) => {
  const b = e.target.closest('[data-theme-choice]');
  if (!b) return;
  try { localStorage.setItem(THEME_KEY, b.dataset.themeChoice); } catch { /* privat läge m.m. */ }
  applyTheme(b.dataset.themeChoice);
});
applyTheme(getTheme());

// ---------- Admin ----------

async function renderAdmin() {
  // Inbjudningskoden
  const { data, error } = await db.from('app_settings').select('value').eq('key', 'signup_code').maybeSingle();
  $('admin-code').value = error ? '' : (data?.value ?? '');

  // Användare
  const members = profiles.filter((p) => p.is_member)
    .sort((a, b) => nameFor(a.user_id).localeCompare(nameFor(b.user_id), 'sv'));
  $('admin-users').innerHTML = members.map((p) => `
    <li class="admin-user">
      <span>
        <span style="color:${colorFor(p.user_id)}">●</span>
        <strong>${escapeHtml(p.full_name || 'Inget namn')}</strong>
        ${p.is_admin ? '👑' : ''}
        <small>${escapeHtml(p.email ?? '')}</small>
      </span>
      <span class="admin-user-buttons">
        <button type="button" class="btn btn-secondary" data-rename="${p.user_id}">Ändra namn</button>
        ${p.user_id === currentUser.id ? '' : `
          <button type="button" class="btn ${p.is_admin ? 'btn-danger' : 'btn-secondary'}"
                  data-admin-toggle="${p.user_id}" data-make="${!p.is_admin}">
            ${p.is_admin ? 'Ta bort admin' : 'Gör till admin'}
          </button>`}
      </span>
    </li>`).join('') || '<li><span class="hint">Inga användare</span></li>';

  // Egna arter
  $('admin-species').innerHTML = customSpecies.map((sp) => `
    <li>
      <span>${iconFor(sp.name)} ${escapeHtml(sp.name)}</span>
      <button type="button" class="btn btn-danger" data-species-delete="${sp.id}">Ta bort</button>
    </li>`).join('') || '<li><span class="hint">Inga egna arter ännu</span></li>';
}

$('admin-code-save').addEventListener('click', async () => {
  const message = $('settings-message');
  message.className = 'message';
  const { error } = await db.rpc('set_signup_code', { new_code: $('admin-code').value });
  if (error) {
    message.textContent = translateError(error);
    return;
  }
  showToast('Ny inbjudningskod sparad');
  renderAdmin();
});

$('admin-users').addEventListener('click', async (e) => {
  // Ändra någons namn
  const renameBtn = e.target.closest('[data-rename]');
  if (renameBtn) {
    const person = profiles.find((p) => p.user_id === renameBtn.dataset.rename);
    const answer = prompt(`Nytt namn för ${person?.email}:`, person?.full_name ?? '');
    if (answer === null) return;
    const name = answer.trim().replace(/\s+/g, ' ');
    const { error } = person?.user_id === currentUser.id
      ? await db.from('profiles').update({ full_name: name }).eq('user_id', currentUser.id)
      : await db.rpc('set_full_name', { target: person.user_id, new_name: name });
    if (error) {
      $('settings-message').textContent = /check constraint|2–80/.test(error.message)
        ? 'Namnet måste vara 2–80 tecken.' : translateError(error);
      return;
    }
    showToast('Namnet är ändrat');
    await loadReports();
    renderAdmin();
    return;
  }

  const button = e.target.closest('[data-admin-toggle]');
  if (!button) return;
  const makeAdmin = button.dataset.make === 'true';
  const person = profiles.find((p) => p.user_id === button.dataset.adminToggle);
  const question = makeAdmin
    ? `Göra ${nameFor(person?.user_id)} till admin? Admin kan ändra och ta bort allas rapporter.`
    : `Ta bort admin för ${nameFor(person?.user_id)}?`;
  if (!confirm(question)) return;

  const { error } = await db.rpc('set_admin', { target: button.dataset.adminToggle, make_admin: makeAdmin });
  if (error) {
    $('settings-message').textContent = translateError(error);
    return;
  }
  await loadReports();
  renderAdmin();
});

$('admin-species').addEventListener('click', async (e) => {
  const button = e.target.closest('[data-species-delete]');
  if (!button) return;
  const sp = customSpecies.find((x) => String(x.id) === button.dataset.speciesDelete);
  if (!confirm(`Ta bort arten "${sp?.name}" från förslagslistan? Rapporter med arten finns kvar.`)) return;

  const { error } = await db.from('custom_species').delete().eq('id', button.dataset.speciesDelete);
  if (error) {
    $('settings-message').textContent = translateError(error);
    return;
  }
  await loadReports();
  renderAdmin();
});

function closeSettings() {
  $('settings-sheet').hidden = true;
}

$('settings-btn').addEventListener('click', openSettings);
$('settings-close').addEventListener('click', closeSettings);

// ---------- Appens namn ----------

// Fyller i namnet från CONFIG.APP_NAME överallt där det står data-app-name="…"
function applyAppName() {
  const n = CONFIG.APP_NAME;
  const rest = `${n.line2}${n.line3}`;
  const full = `${n.line1} ${rest}`;
  document.title = full;
  document.querySelectorAll('[data-app-name]').forEach((el) => {
    const key = el.dataset.appName;
    el.textContent = key === 'full' ? full : key === 'rest' ? rest : n[key];
  });
}
applyAppName();

// ---------- Vyer ----------

function showView(name) {
  const isApp = name === 'app';
  $('app-view').hidden = !isApp;
  $('auth-view').hidden = isApp;
  if (!isApp) showPanel(name);
}

// Vilken ruta som visas i inloggningskortet: login, forgot, signup, code, password
function showPanel(name) {
  document.querySelectorAll('.auth-panel').forEach((panel) => {
    panel.hidden = panel.dataset.panel !== name;
  });
  clearErrors();
}

document.querySelectorAll('[data-goto]').forEach((btn) => {
  btn.addEventListener('click', () => showPanel(btn.dataset.goto));
});

// ---------- Hjälp för formulären ----------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function setFieldError(input, text) {
  input.classList.add('invalid');
  const field = input.closest('.field');
  let el = field.querySelector('.field-error');
  if (!el) {
    el = document.createElement('div');
    el.className = 'field-error';
    field.appendChild(el);
  }
  el.textContent = text;
}

function setFormError(id, text) {
  const el = $(id);
  el.className = 'form-error';
  el.textContent = text;
  el.hidden = !text;
}

function clearErrors() {
  document.querySelectorAll('.auth-card .invalid').forEach((el) => el.classList.remove('invalid'));
  document.querySelectorAll('.auth-card .field-error').forEach((el) => el.remove());
  document.querySelectorAll('.auth-card .form-error').forEach((el) => { el.hidden = true; });
}

// Felet för ett fält försvinner när man börjar skriva i det
document.querySelectorAll('.auth-card input').forEach((input) => {
  input.addEventListener('input', () => {
    input.classList.remove('invalid');
    input.closest('.field')?.querySelector('.field-error')?.remove();
    const formError = input.closest('form')?.querySelector('.form-error');
    if (formError) formError.hidden = true;
  });
});

function validateEmail(input) {
  const value = input.value.trim();
  if (!value) { setFieldError(input, 'Fyll i din e-post.'); return false; }
  if (!EMAIL_RE.test(value)) { setFieldError(input, 'Kontrollera e-postadressen.'); return false; }
  return true;
}

function validatePassword(input, minLength = 1) {
  if (!input.value) { setFieldError(input, 'Fyll i ditt lösenord.'); return false; }
  if (input.value.length < minLength) { setFieldError(input, `Lösenordet måste vara minst ${minLength} tecken.`); return false; }
  return true;
}

// Knapp med snurra medan något laddar
function setLoading(form, loading, loadingText) {
  const button = form.querySelector('.auth-primary');
  const label = button.querySelector('.label');
  if (loading) button.dataset.label = label.textContent;
  button.disabled = loading;
  button.querySelector('.spinner').hidden = !loading;
  label.textContent = loading ? loadingText : button.dataset.label;
}

// Visa/Dölj lösenord
document.querySelectorAll('.pw-toggle').forEach((btn) => {
  btn.addEventListener('click', () => {
    const input = btn.parentElement.querySelector('input');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.textContent = show ? 'Dölj' : 'Visa';
  });
});

// ---------- Inloggning ----------

db.auth.onAuthStateChange((event, session) => {
  if (event === 'PASSWORD_RECOVERY') needsNewPassword = true;
  // Vänta ett ögonblick så att Supabase hinner klart innan vi gör nya anrop
  setTimeout(() => handleSession(session), 0);
});

async function handleSession(session) {
  currentUser = session?.user ?? null;

  if (!currentUser) {
    reports = [];
    isAdmin = false;
    // Byt inte bort t.ex. "Skapa konto" om man redan står där
    if ($('auth-view').hidden || ['code', 'password'].includes(currentPanel())) showView('login');
    return;
  }
  if (needsNewPassword) {
    showView('password');
    return;
  }

  // Har kontot en giltig inbjudningskod? Annars får man skriva in den.
  const { data: me, error } = await db.from('profiles')
    .select('is_member, is_admin').eq('user_id', currentUser.id).maybeSingle();
  if (error) {
    // T.ex. om databasen inte är uppdaterad än – släpp in som vanlig användare
    console.warn('Profil:', error.message);
  } else if (!me?.is_member) {
    // Försök med koden som angavs när kontot skapades
    const code = currentUser.user_metadata?.signup_code;
    const result = code ? (await db.rpc('redeem_signup_code', { code })).data : null;
    if (result !== 'ok') {
      showView('code');
      return;
    }
    return handleSession(session);
  }
  isAdmin = Boolean(me?.is_admin);

  showView('app');
  initMap();
  loadReports();
}

function currentPanel() {
  return document.querySelector('.auth-panel:not([hidden])')?.dataset.panel;
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  clearErrors();
  const okEmail = validateEmail($('login-email'));
  const okPw = validatePassword($('login-password'));
  if (!okEmail || !okPw) return;

  setLoading(form, true, 'Loggar in…');
  const { error } = await db.auth.signInWithPassword({
    email: $('login-email').value.trim(),
    password: $('login-password').value,
  });
  setLoading(form, false);

  if (error) {
    setFormError('login-message', /Invalid login credentials/i.test(error.message)
      ? 'Fel e-post eller lösenord. Försök igen.'
      : translateError(error));
  }
});

// ---------- Glömt lösenord ----------

$('forgot-btn').addEventListener('click', () => {
  showPanel('forgot');
  $('forgot-email').value = $('login-email').value;
  $('forgot-form').hidden = false;
  $('forgot-done').hidden = true;
});

$('forgot-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  clearErrors();
  if (!validateEmail($('forgot-email'))) return;

  const email = $('forgot-email').value.trim();
  setLoading(form, true, 'Skickar…');
  const { error } = await db.auth.resetPasswordForEmail(email, {
    redirectTo: location.origin + location.pathname,
  });
  setLoading(form, false);

  if (error && !/rate limit/i.test(error.message)) {
    setFormError('forgot-message', translateError(error));
    return;
  }
  // Samma besked oavsett om kontot finns (avslöjar inte vilka konton som finns)
  form.hidden = true;
  $('forgot-done').textContent = `Om adressen finns hos oss har en länk skickats till ${email}.`;
  $('forgot-done').hidden = false;
  $('login-email').value = email;
});

// ---------- Skapa konto ----------

$('show-signup').addEventListener('click', () => {
  showPanel('signup');
  $('signup-email').value = $('login-email').value;
  $('signup-name').focus();
});

$('signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  clearErrors();
  const fullName = $('signup-name').value.trim().replace(/\s+/g, ' ');
  const okName = fullName.length >= 2 && fullName.length <= 80 && fullName.includes(' ');
  if (!okName) setFieldError($('signup-name'), 'Skriv både för- och efternamn.');
  const okEmail = validateEmail($('signup-email'));
  const okPw = validatePassword($('signup-password'), 8);
  const okCode = Boolean($('signup-code').value.trim());
  if (!okCode) setFieldError($('signup-code'), 'Fyll i inbjudningskoden.');
  if (!okName || !okEmail || !okPw || !okCode) return;

  setLoading(form, true, 'Skapar konto…');
  const { data, error } = await db.auth.signUp({
    email: $('signup-email').value.trim(),
    password: $('signup-password').value,
    options: { data: { signup_code: $('signup-code').value.trim(), full_name: fullName } },
  });
  setLoading(form, false);

  if (error) {
    setFormError('signup-message', translateError(error));
  } else if (!data.session) {
    // Supabase kräver att e-posten bekräftas först
    setFormError('signup-message', 'Kontot är skapat! Öppna mejlet vi skickat och klicka på länken, logga sedan in.');
    $('signup-message').className = 'form-ok';
  }
  // Annars loggas man in direkt (onAuthStateChange sköter resten)
});

// ---------- Inbjudningskod i efterhand ----------

$('code-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  clearErrors();
  const code = $('code-input').value.trim();
  if (!code) {
    setFieldError($('code-input'), 'Fyll i koden.');
    return;
  }

  setLoading(form, true, 'Kontrollerar…');
  const { data, error } = await db.rpc('redeem_signup_code', { code });
  setLoading(form, false);

  if (error) {
    setFormError('code-message', translateError(error));
  } else if (data === 'locked') {
    setFormError('code-message', 'För många felaktiga försök. Kontakta en admin.');
  } else if (data !== 'ok') {
    setFormError('code-message', 'Fel kod. Kontrollera och försök igen.');
  } else {
    showToast('Välkommen!');
    const { data: { session } } = await db.auth.getSession();
    handleSession(session);
  }
});

$('code-logout').addEventListener('click', () => db.auth.signOut());

// ---------- Välj nytt lösenord ----------

$('password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  clearErrors();
  if (!validatePassword($('new-password'), 8)) return;

  setLoading(form, true, 'Sparar…');
  const { data, error } = await db.auth.updateUser({ password: $('new-password').value });
  setLoading(form, false);

  if (error) {
    setFormError('password-message', translateError(error));
    return;
  }
  needsNewPassword = false;
  history.replaceState(null, '', location.pathname);
  showToast('Lösenordet är sparat');
  const { data: { session } } = await db.auth.getSession();
  handleSession(session ?? { user: data.user });
});

$('logout-btn').addEventListener('click', async () => {
  closeSheet();
  closeFilter();
  closeSettings();
  await db.auth.signOut();
});

// ---------- Karta ----------

function initMap() {
  if (map) {
    map.invalidateSize();
    return;
  }

  map = L.map('map').setView(CONFIG.MAP_CENTER, CONFIG.MAP_ZOOM);

  const streets = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    className: 'tiles-streets',  // görs mörk i mörkt tema (se style.css)
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-bidragsgivare',
  });
  const satellite = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Bild &copy; Esri &mdash; Källa: Esri, Maxar, Earthstar Geographics och GIS User Community',
    });

  // Kom ihåg karta/satellit till nästa gång
  (layerPrefs.base === 'Satellit' ? satellite : streets).addTo(map);
  map.on('baselayerchange', (e) => saveLayerPrefs({ base: e.name }));
  const layersControl = L.control.layers({ 'Karta': streets, 'Satellit': satellite }, null, { collapsed: true }).addTo(map);
  loadAreas(layersControl);

  // Riskzoner (banor, in-/utflygning, taxibanor, stängsel)
  riskLayer = L.layerGroup();
  if (layerPrefs.risk !== false) riskLayer.addTo(map);
  layersControl.addOverlay(riskLayer, '⚠️ Riskzoner');
  map.on('overlayadd overlayremove', (e) => {
    if (e.layer === riskLayer) saveLayerPrefs({ risk: e.type === 'overlayadd' });
  });
  drawRiskZones();

  markerLayer = L.layerGroup().addTo(map);

  // Tryck på kartan = placera (eller flytta) nålen
  map.on('click', (e) => {
    // Ritar admin en riskzon blir trycket en ny punkt i zonen
    if (drawing) {
      addDrawPoint(e.latlng);
      return;
    }
    // Är filterpanelen öppen stänger första trycket bara den
    if (!$('filter-sheet').hidden) {
      closeFilter();
      return;
    }
    placeDraftMarker(e.latlng);
    if ($('sheet').hidden) openSheet();
  });
}

// ---------- Områden (GPX) ----------
// Ritar tomtgränser och områden från en GPX-fil. WeHunt anger typen i <type>:
// border = yttergräns, subarea = delområde, forbidden = förbjudet område.

const AREA_STYLES = {
  border:    { color: '#ffd60a', weight: 4, opacity: 0.95, fillOpacity: 0 },
  subarea:   { color: '#ff8c1a', weight: 2.5, opacity: 0.9, fillColor: '#ff8c1a', fillOpacity: 0.06 },
  forbidden: { color: '#e53935', weight: 3, opacity: 0.95, dashArray: '8 6', fillColor: '#e53935', fillOpacity: 0.25 },
};

// Vilka lager man valt (sparas i webbläsaren)
const LAYERS_KEY = 'viltrapport-layers';
let layerPrefs = loadLayerPrefs();

function loadLayerPrefs() {
  const defaults = { base: 'Karta', border: true, subarea: true, forbidden: true, labels: true };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(LAYERS_KEY) || '{}') };
  } catch {
    return defaults;
  }
}

function saveLayerPrefs(changes) {
  layerPrefs = { ...layerPrefs, ...changes };
  try { localStorage.setItem(LAYERS_KEY, JSON.stringify(layerPrefs)); } catch { /* privat läge m.m. */ }
}

async function loadAreas(layersControl) {
  if (!CONFIG.AREAS_GPX) return;
  try {
    const response = await fetch(CONFIG.AREAS_GPX, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const xml = new DOMParser().parseFromString(await response.text(), 'application/xml');

    // Eget lager för namnen: ovanför ytorna men under rapportnålarna
    map.createPane('areaLabels').style.zIndex = 450;

    // Ett lager per typ, plus ett (tomt) lager som bara styr om namnen visas
    const groups = { border: L.layerGroup(), subarea: L.layerGroup(), forbidden: L.layerGroup() };
    const labels = L.layerGroup();
    const tracks = [...xml.getElementsByTagName('trk'), ...xml.getElementsByTagName('rte')];

    for (const track of tracks) {
      const name = track.getElementsByTagName('name')[0]?.textContent.trim() ?? '';
      const type = track.getElementsByTagName('type')[0]?.textContent.trim() ?? 'subarea';
      const style = AREA_STYLES[type] ?? AREA_STYLES.subarea;
      const points = [...track.getElementsByTagName('trkpt'), ...track.getElementsByTagName('rtept')]
        .map((pt) => [Number(pt.getAttribute('lat')), Number(pt.getAttribute('lon'))])
        .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));
      if (points.length < 2) continue;

      // Slutet spår (första = sista punkten) blir en yta, annars en linje.
      // interactive: false gör att man kan trycka "igenom" områdena för att rapportera.
      const [first, last] = [points[0], points[points.length - 1]];
      const closed = points.length > 3 && first[0] === last[0] && first[1] === last[1];
      const shape = closed
        ? L.polygon(points, { ...style, interactive: false })
        : L.polyline(points, { ...style, interactive: false });

      if (name && type !== 'border') {
        const label = type === 'forbidden' ? `⛔ ${name.replace(/^Förbjudet område\s*-\s*/i, '')}` : name;
        shape.bindTooltip(label, {
          permanent: true, direction: 'center', interactive: false, pane: 'areaLabels',
          className: `area-label ${type === 'forbidden' ? 'area-label-forbidden' : ''}`,
        });
      }
      (groups[type] ?? groups.subarea).addLayer(shape);
    }

    const overlays = [
      ['border', groups.border, '<span style="color:#e6b800">■</span> Yttergräns'],
      ['subarea', groups.subarea, '<span style="color:#ff8c1a">■</span> Delområden'],
      ['forbidden', groups.forbidden, '<span style="color:#e53935">■</span> Förbjudna områden'],
      ['labels', labels, '🔤 Namn på områden'],
    ];
    for (const [key, layer, title] of overlays) {
      if (layerPrefs[key]) layer.addTo(map);
      layersControl.addOverlay(layer, title);
    }
    const keyOf = (layer) => overlays.find(([, l]) => l === layer)?.[0];
    map.on('overlayadd overlayremove', (e) => {
      const key = keyOf(e.layer);
      if (key) saveLayerPrefs({ [key]: e.type === 'overlayadd' });
      if (key === 'labels') updateLabels();
    });

    // Namnen tar för mycket plats när man zoomar ut – visa dem bara när man är nära
    // Namnen döljs om man stängt av dem, eller när man zoomat ut långt (för plottrigt)
    function updateLabels() {
      map.getContainer().classList.toggle('hide-area-labels', !map.hasLayer(labels) || map.getZoom() < 13);
    }
    map.on('zoomend', updateLabels);
    updateLabels();
  } catch (err) {
    console.warn('Kunde inte läsa områdena:', err.message);
  }
}

function placeDraftMarker(latlng) {
  if (!draftMarker) {
    draftMarker = L.marker(latlng, { draggable: true, autoPan: true }).addTo(map);
  } else {
    draftMarker.setLatLng(latlng);
  }
}

function removeDraftMarker() {
  if (draftMarker) {
    draftMarker.remove();
    draftMarker = null;
  }
}

// Flera arter på samma plats: nålarna läggs i en ring runt punkten så att alla syns
function spreadAnchor(r) {
  const group = sightingGroup(r);
  const i = group.indexOf(r);
  if (group.length < 2 || i < 0) return [14, 14];
  const angle = (i / group.length) * 2 * Math.PI - Math.PI / 2;
  const radius = 12 + group.length * 2;
  return [14 - Math.round(Math.cos(angle) * radius), 14 - Math.round(Math.sin(angle) * radius)];
}

function renderMarkers(list) {
  if (!markerLayer) return;
  markerLayer.clearLayers();

  for (const r of list) {
    const type = REPORT_TYPES[typeOf(r)];
    const icon = type.emoji
      // Olycka/birdstrike: varningstriangel, liten prick i rapportörens färg
      ? L.divIcon({
        className: 'tri-wrap',
        html: triangleHtml(type.emoji, colorFor(r.user_id)).replace('class="tri"', 'class="tri" style="--tri-size:32px"'),
        iconSize: [32, 29],
        iconAnchor: [16, 16],
        popupAnchor: [0, -18],
      })
      : L.divIcon({
        className: 'pin-wrap',
        html: pinHtml(r),
        iconSize: [28, 28],
        iconAnchor: spreadAnchor(r),
        popupAnchor: [0, -16],
      });
    // Olyckor och birdstrikes ligger överst så att de inte göms under vanliga nålar
    const marker = L.marker([r.lat, r.lng], { icon, zIndexOffset: type.emoji ? 1000 : 0 });
    marker.bindPopup(() => popupHtml(r));
    marker.reportId = r.id;

    // Dator (mus): liten informationsruta när man håller musen över ikonen.
    // Mobil har ingen mus – där visas allt i rutan som öppnas när man trycker.
    if (CAN_HOVER) {
      marker.bindTooltip(() => tooltipHtml(r), { direction: 'top', offset: [0, -16], className: 'report-tip' });
      // Den lilla rutan behövs inte när den stora är öppen
      marker.on('popupopen', () => marker.closeTooltip());
      marker.on('tooltipopen', () => { if (marker.isPopupOpen()) marker.closeTooltip(); });
    }
    // Ikonen hamnar överst och växer medan man håller över den eller har den öppen
    const raise = () => marker.setZIndexOffset(2000);
    const lower = () => { if (!marker.isPopupOpen()) marker.setZIndexOffset(type.emoji ? 1000 : 0); };
    marker.on('mouseover', raise);
    marker.on('mouseout', lower);
    marker.on('popupopen', () => { raise(); marker.getElement()?.classList.add('marker-active'); });
    marker.on('popupclose', () => { marker.getElement()?.classList.remove('marker-active'); lower(); });
    markerLayer.addLayer(marker);
  }
}

// Finns det en mus (dator)? På mobil är svaret nej.
const CAN_HOVER = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

// Kort information när man håller musen över en ikon
function tooltipHtml(r) {
  return `
    <div class="tip">
      ${typeBadge(r)}
      <strong>${iconFor(r.species)} ${escapeHtml(r.species)} (${countText(r)})</strong>
      ${fieldsLine(r)}
      ${companionsLine(r)}
      <span>🕒 ${formatDateTime(r.observed_at)}</span>
      ${weatherLine(r)}
      <span><span style="color:${colorFor(r.user_id)}">●</span> ${escapeHtml(nameFor(r.user_id, r.reporter_email))}</span>
      ${r.comment ? `<span class="tip-comment">💬 ${escapeHtml(r.comment.length > 60 ? r.comment.slice(0, 60) + '…' : r.comment)}</span>` : ''}
      ${riskPill(r)}
      <span class="tip-hint">Klicka för mer</span>
    </div>`;
}

function popupHtml(r) {
  const own = canEdit(r);
  return `
    <div class="popup">
      ${typeBadge(r)}
      <h3>${iconFor(r.species)} ${escapeHtml(r.species)} (${countText(r)})</h3>
      ${fieldsLine(r, 'p')}
      ${companionsLine(r, 'p')}
      <p>🕒 ${formatDateTime(r.observed_at)}</p>
      <p>${weatherLine(r)}</p>
      <p><span style="color:${colorFor(r.user_id)}">●</span> ${escapeHtml(nameFor(r.user_id, r.reporter_email))}</p>
      ${r.comment ? `<p>💬 ${escapeHtml(r.comment)}</p>` : ''}
      <p>${riskPill(r)}</p>
      <div class="actions">
        <button class="btn btn-secondary" data-action="risk" data-id="${r.id}">📄 Detaljer, väder & risk</button>
      </div>
      ${own ? `
        <div class="actions">
          <button class="btn btn-secondary" data-action="edit" data-id="${r.id}">Redigera</button>
          <button class="btn btn-danger" data-action="delete" data-id="${r.id}">Ta bort</button>
        </div>` : ''}
    </div>`;
}

// ---------- Hämta rapporter ----------

async function loadReports() {
  const [reportsResult, profilesResult, speciesResult, zonesResult, actionsResult, configResult] = await Promise.all([
    db.from('reports').select('*').order('observed_at', { ascending: false }).limit(5000),
    db.from('profiles').select('user_id, color, email, full_name, is_admin, is_member'),
    db.from('custom_species').select('id, name, category').order('name'),
    db.from('risk_zones').select('id, name, zone_type, points').order('zone_type').order('name'),
    db.from('report_actions').select('id, report_id, action, comment, created_by, created_at').order('created_at'),
    db.from('risk_config').select('config, updated_by, updated_at').eq('id', 1).maybeSingle(),
  ]);

  if (reportsResult.error) {
    showToast(translateError(reportsResult.error));
    return;
  }
  // Färger och egna arter är "extra" – appen fungerar även om de inte går att hämta
  if (profilesResult.error) console.warn('Profiler:', profilesResult.error.message);
  else {
    profiles = profilesResult.data;
    userColors = new Map(profiles.filter((p) => p.color).map((p) => [p.user_id, p.color]));
  }
  if (speciesResult.error) console.warn('Egna arter:', speciesResult.error.message);
  else customSpecies = speciesResult.data;
  if (zonesResult.error) console.warn('Riskzoner:', zonesResult.error.message);
  else riskZones = zonesResult.data;
  if (actionsResult.error) console.warn('Åtgärder:', actionsResult.error.message);
  else reportActions = actionsResult.data;
  // Riskinställningar från admin läggs ovanpå standardvärdena i risk.js
  if (configResult.error) console.warn('Riskinställningar:', configResult.error.message);
  else {
    RISK.applyConfig(configResult.data?.config);
    riskConfigMeta = configResult.data;
  }
  drawRiskZones();

  reports = reportsResult.data;
  sightingMap = null;
  updateFilterOptions();
  render();
  backfillWeather();
}

// ---------- Filter ----------
// Samma filter gäller både kartan och listan. Det sparas i webbläsaren
// så att det finns kvar nästa gång man öppnar appen.

const FILTER_KEY = 'viltrapport-filter';
const EMPTY_FILTER = {
  type: '',         // '' = alla, 'observation', 'olycka' eller 'birdstrike'
  animal: null,     // { type: 'kind' | 'group' | 'species', value, label, icon }
  reporter: '',     // '' = alla, 'me' = bara mina, annars ett user_id
  quick: '',        // '' | 'today' | '7' | '30'
  from: '',
  to: '',
  tod: '',          // tid på dygnet: '' eller WEATHER.TIME_OF_DAY[].key
  light: '',        // ljus: '' | 'natt' | 'gryning' | 'dag' | 'skymning'
  wx: [],           // vädermarkörer som alla måste stämma, t.ex. ['regnat', 'blasigt']
  flock: '',        // '' | 'ja' (bara flockar) | 'nej' (fåglar som inte är flock)
  position: '',     // fågelns läge: '' eller nyckel i BIRD_POSITIONS
  habitat: '',      // biotop: '' eller nyckel i HABITATS
  multi: '',        // '' | 'ja' (flera arter på samma plats) | 'nej' (en art)
  sort: 'date-desc',
};
let filter = loadFilter();

function loadFilter() {
  try {
    const saved = { ...EMPTY_FILTER, ...JSON.parse(localStorage.getItem(FILTER_KEY) || '{}') };
    if (!Array.isArray(saved.wx)) saved.wx = [];
    return saved;
  } catch {
    return { ...EMPTY_FILTER };
  }
}

function saveFilter() {
  try { localStorage.setItem(FILTER_KEY, JSON.stringify(filter)); } catch { /* privat läge m.m. */ }
}

function setFilter(changes) {
  filter = { ...filter, ...changes };
  saveFilter();
  syncFilterForm();
  render();
}

// Djurgrupp och "däggdjur/fågel" för en art
function groupOf(speciesName) {
  return findKnownSpecies(speciesName)?.group ?? 'ovrigt';
}
function kindOf(speciesName) {
  return window.SPECIES_GROUPS[groupOf(speciesName)]?.kind ?? 'annat';
}

// Datumintervallet som gäller just nu (snabbval räknas från dagens datum)
function dateRange() {
  if (filter.quick) {
    const start = new Date();
    if (filter.quick !== 'today') start.setDate(start.getDate() - (Number(filter.quick) - 1));
    return { from: localDate(start), to: '' };
  }
  return { from: filter.from, to: filter.to };
}

function matchesFilter(r) {
  if (filter.type && typeOf(r) !== filter.type) return false;
  if (filter.tod || filter.light || filter.wx.length) {
    const c = contextOf(r);
    if (filter.tod && c.tod !== filter.tod) return false;
    if (filter.light && c.light !== filter.light) return false;
    if (filter.wx.length && (!c.wx || !filter.wx.every((t) => c.wx.tagSet.has(t)))) return false;
  }
  if (filter.flock === 'ja' && !r.is_flock) return false;
  if (filter.flock === 'nej' && (r.is_flock || kindOf(r.species) !== 'fagel')) return false;
  if (filter.position && r.bird_position !== filter.position) return false;
  if (filter.habitat && r.habitat !== filter.habitat) return false;
  if (filter.multi && (sightingGroup(r).length > 1) !== (filter.multi === 'ja')) return false;
  const a = filter.animal;
  if (a?.type === 'kind' && kindOf(r.species) !== a.value) return false;
  if (a?.type === 'group' && groupOf(r.species) !== a.value) return false;
  if (a?.type === 'species' && r.species.toLowerCase() !== a.value.toLowerCase()) return false;

  if (filter.reporter === 'me' && r.user_id !== currentUser?.id) return false;
  if (filter.reporter && filter.reporter !== 'me' && r.user_id !== filter.reporter) return false;

  const { from, to } = dateRange();
  const day = localDate(r.observed_at);
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

function getFilteredReports() {
  const byDate = (a, b) => new Date(b.observed_at) - new Date(a.observed_at);
  const sorters = {
    'date-desc': byDate,
    'date-asc': (a, b) => -byDate(a, b),
    'species': (a, b) => a.species.localeCompare(b.species, 'sv') || byDate(a, b),
    'reporter': (a, b) => nameFor(a.user_id, a.reporter_email).localeCompare(nameFor(b.user_id, b.reporter_email), 'sv') || byDate(a, b),
  };
  return reports.filter(matchesFilter).sort(sorters[filter.sort] ?? byDate);
}

// Vem som har rapporterat (för listan "Rapportör")
function reporterOptions() {
  const people = new Map();
  for (const r of reports) people.set(r.user_id, nameFor(r.user_id, r.reporter_email));
  return [...people].filter(([id]) => id !== currentUser?.id)
    .sort((a, b) => a[1].localeCompare(b[1], 'sv'));
}

function reporterLabel(id) {
  if (id === 'me') return 'Bara mina';
  return nameFor(id, reports.find((r) => r.user_id === id)?.reporter_email);
}

function updateFilterOptions() {
  const options = reporterOptions();
  const select = $('filter-reporter');
  select.innerHTML = '<option value="">Alla</option><option value="me">Bara mina</option>' +
    options.map(([id, email]) => `<option value="${escapeHtml(id)}">${escapeHtml(email)}</option>`).join('');
  // Finns den valda personen inte längre i listan: lägg till den ändå så att valet syns
  if (filter.reporter && ![...select.options].some((o) => o.value === filter.reporter)) {
    select.insertAdjacentHTML('beforeend',
      `<option value="${escapeHtml(filter.reporter)}">${escapeHtml(reporterLabel(filter.reporter))}</option>`);
  }
  select.value = filter.reporter;
}

function dateLabel() {
  const labels = { today: 'Idag', 7: '7 dagar', 30: '30 dagar' };
  if (filter.quick) return labels[filter.quick];
  if (filter.from && filter.to) return `${filter.from} – ${filter.to}`;
  if (filter.from) return `från ${filter.from}`;
  if (filter.to) return `till ${filter.to}`;
  return '';
}

function renderFilterBar(shown) {
  const chips = [];
  if (REPORT_TYPES[filter.type]) {
    const t = REPORT_TYPES[filter.type];
    chips.push(['type', `${t.emoji ? triangleHtml(t.emoji) : '👁️'} ${t.plural}`, true]);
  }
  if (filter.animal) chips.push(['animal', `${filter.animal.icon} ${filter.animal.label}`]);
  if (filter.reporter) {
    const dot = filter.reporter === 'me' ? '' : `<span style="color:${colorFor(filter.reporter)}">●</span> `;
    chips.push(['reporter', `${dot}👤 ${escapeHtml(reporterLabel(filter.reporter))}`, true]);
  }
  if (dateLabel()) chips.push(['date', `📅 ${dateLabel()}`]);
  if (filter.tod) {
    const t = WEATHER.TIME_OF_DAY.find((x) => x.key === filter.tod);
    if (t) chips.push(['tod', `${t.icon} ${t.label}`]);
  }
  if (WEATHER.LIGHT[filter.light]) chips.push(['light', `${WEATHER.LIGHT[filter.light].icon} ${WEATHER.LIGHT[filter.light].label}`]);
  for (const t of filter.wx) {
    if (WEATHER.TAGS[t]) chips.push([`wx:${t}`, `${WEATHER.TAGS[t].icon} ${WEATHER.TAGS[t].label}`]);
  }
  if (FLOCK_OPTIONS[filter.flock]) chips.push(['flock', FLOCK_OPTIONS[filter.flock]]);
  const pos = window.BIRD_POSITIONS[filter.position];
  if (pos) chips.push(['position', `${pos.icon} ${pos.label}`]);
  const hab = window.HABITATS[filter.habitat];
  if (hab) chips.push(['habitat', `${hab.icon} ${hab.label}`]);
  if (MULTI_OPTIONS[filter.multi]) chips.push(['multi', MULTI_OPTIONS[filter.multi]]);

  $('filter-chips').innerHTML = chips.map(([key, label, isHtml]) => `
    <button type="button" class="chip" data-clear="${key}" aria-label="Ta bort filtret">
      ${isHtml ? label : escapeHtml(label)}<span class="x" aria-hidden="true">✕</span>
    </button>`).join('');

  $('filter-count').hidden = chips.length === 0;
  $('filter-count').textContent = chips.length;
  $('filter-open').classList.toggle('active', chips.length > 0);
  $('result-count').textContent = chips.length ? `${shown} av ${reports.length}` : `${reports.length} st`;
  $('filter-done').textContent = `Visa ${shown} ${shown === 1 ? 'rapport' : 'rapporter'}`;
}

// Tryck på ✕ på en etikett = ta bort just det filtret
$('filter-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-clear]');
  if (!chip) return;
  if (chip.dataset.clear === 'type') setFilter({ type: '' });
  if (chip.dataset.clear === 'animal') setFilter({ animal: null });
  if (chip.dataset.clear === 'reporter') setFilter({ reporter: '' });
  if (chip.dataset.clear === 'date') setFilter({ quick: '', from: '', to: '' });
  if (chip.dataset.clear === 'tod') setFilter({ tod: '' });
  if (chip.dataset.clear === 'light') setFilter({ light: '' });
  if (chip.dataset.clear === 'flock') setFilter({ flock: '' });
  if (chip.dataset.clear === 'position') setFilter({ position: '' });
  if (chip.dataset.clear === 'habitat') setFilter({ habitat: '' });
  if (chip.dataset.clear === 'multi') setFilter({ multi: '' });
  if (chip.dataset.clear.startsWith('wx:')) setFilter({ wx: filter.wx.filter((t) => `wx:${t}` !== chip.dataset.clear) });
});

// Fyll i filterpanelen från det sparade filtret
function syncFilterForm() {
  if (document.activeElement !== $('filter-animal')) $('filter-animal').value = filter.animal?.label ?? '';
  $('filter-reporter').value = filter.reporter;
  $('filter-from').value = filter.quick ? '' : filter.from;
  $('filter-to').value = filter.quick ? '' : filter.to;
  $('sort').value = filter.sort;
  document.querySelectorAll('#filter-type [data-type]').forEach((b) => {
    b.classList.toggle('selected', b.dataset.type === filter.type);
  });
  document.querySelectorAll('#filter-tod [data-tod]').forEach((b) => b.classList.toggle('selected', b.dataset.tod === filter.tod));
  document.querySelectorAll('#filter-light [data-light]').forEach((b) => b.classList.toggle('selected', b.dataset.light === filter.light));
  document.querySelectorAll('#filter-wx [data-wx]').forEach((b) => b.classList.toggle('selected', filter.wx.includes(b.dataset.wx)));
  document.querySelectorAll('#filter-flock [data-flock]').forEach((b) => b.classList.toggle('selected', b.dataset.flock === filter.flock));
  document.querySelectorAll('#filter-position [data-position]').forEach((b) => b.classList.toggle('selected', b.dataset.position === filter.position));
  document.querySelectorAll('#filter-habitat [data-habitat]').forEach((b) => b.classList.toggle('selected', b.dataset.habitat === filter.habitat));
  document.querySelectorAll('#filter-multi [data-multi]').forEach((b) => b.classList.toggle('selected', b.dataset.multi === filter.multi));
  document.querySelectorAll('#filter-quick [data-quick]').forEach((b) => {
    b.classList.toggle('selected', b.dataset.quick === filter.quick && (filter.quick || (!filter.from && !filter.to)));
  });
}

function syncRiskZoneToggle() {
  const on = Boolean(riskLayer && map?.hasLayer(riskLayer));
  document.querySelectorAll('#filter-riskzones [data-zones]').forEach((b) => {
    b.classList.toggle('selected', (b.dataset.zones === 'on') === on);
  });
}

$('filter-riskzones').addEventListener('click', (e) => {
  const b = e.target.closest('[data-zones]');
  if (!b || !riskLayer || !map) return;
  // Samma lager som i lagerknappen – valet sparas där också
  if (b.dataset.zones === 'on') riskLayer.addTo(map);
  else riskLayer.remove();
  saveLayerPrefs({ risk: b.dataset.zones === 'on' });
  syncRiskZoneToggle();
});

function openFilter() {
  closeSheet();
  closeRisk();
  closeRiskConfig();
  syncRiskZoneToggle();
  closeSettings();
  updateFilterOptions();
  syncFilterForm();
  $('filter-sheet').hidden = false;
}

function closeFilter() {
  $('filter-sheet').hidden = true;
  hideAnimalSuggestions();
}

$('filter-open').addEventListener('click', () => ($('filter-sheet').hidden ? openFilter() : closeFilter()));
$('filter-done').addEventListener('click', closeFilter);
$('filter-clear').addEventListener('click', () => setFilter({ ...EMPTY_FILTER, sort: filter.sort }));

$('filter-reporter').addEventListener('change', (e) => setFilter({ reporter: e.target.value }));
$('sort').addEventListener('change', (e) => setFilter({ sort: e.target.value }));
$('filter-from').addEventListener('change', (e) => setFilter({ from: e.target.value, quick: '' }));
$('filter-to').addEventListener('change', (e) => setFilter({ to: e.target.value, quick: '' }));
// Knappar för tid på dygnet, ljus och väder
$('filter-tod').innerHTML = '<button type="button" data-tod="">Alla</button>' +
  WEATHER.TIME_OF_DAY.map((t) => `<button type="button" data-tod="${t.key}">${t.icon} ${t.label}</button>`).join('');
$('filter-light').innerHTML = '<button type="button" data-light="">Alla</button>' +
  Object.entries(WEATHER.LIGHT).map(([k, t]) => `<button type="button" data-light="${k}">${t.icon} ${t.label}</button>`).join('');
$('filter-wx').innerHTML = Object.entries(WEATHER.TAGS)
  .map(([k, t]) => `<button type="button" data-wx="${k}">${t.icon} ${t.label}</button>`).join('');
// Knappar för flock, fågelns läge och biotop
const FLOCK_OPTIONS = { ja: '🐦🐦🐦 Bara flockar', nej: '🐦 Fåglar utan flock' };
$('filter-flock').innerHTML = '<button type="button" data-flock="">Alla</button>' +
  Object.entries(FLOCK_OPTIONS).map(([k, label]) => `<button type="button" data-flock="${k}">${label}</button>`).join('');
$('filter-position').innerHTML = '<button type="button" data-position="">Alla</button>' +
  Object.entries(window.BIRD_POSITIONS).map(([k, t]) => `<button type="button" data-position="${k}">${t.icon} ${t.label}</button>`).join('');
$('filter-habitat').innerHTML = '<button type="button" data-habitat="">Alla</button>' +
  Object.entries(window.HABITATS).map(([k, t]) => `<button type="button" data-habitat="${k}">${t.icon} ${t.label}</button>`).join('');
const MULTI_OPTIONS = { ja: '👥 Flera arter samtidigt', nej: '🐾 En art' };
$('filter-multi').innerHTML = '<button type="button" data-multi="">Alla</button>' +
  Object.entries(MULTI_OPTIONS).map(([k, label]) => `<button type="button" data-multi="${k}">${label}</button>`).join('');
for (const key of ['flock', 'position', 'habitat', 'multi']) {
  $(`filter-${key}`).addEventListener('click', (e) => {
    const b = e.target.closest(`[data-${key}]`);
    if (b) setFilter({ [key]: b.dataset[key] });
  });
}
$('filter-tod').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tod]');
  if (b) setFilter({ tod: b.dataset.tod });
});
$('filter-light').addEventListener('click', (e) => {
  const b = e.target.closest('[data-light]');
  if (b) setFilter({ light: b.dataset.light });
});
$('filter-wx').addEventListener('click', (e) => {
  const b = e.target.closest('[data-wx]');
  if (!b) return;
  const t = b.dataset.wx;
  setFilter({ wx: filter.wx.includes(t) ? filter.wx.filter((x) => x !== t) : [...filter.wx, t] });
});

$('filter-type').addEventListener('click', (e) => {
  const b = e.target.closest('[data-type]');
  if (b) setFilter({ type: b.dataset.type });
});
$('filter-quick').addEventListener('click', (e) => {
  const b = e.target.closest('[data-quick]');
  if (b) setFilter({ quick: b.dataset.quick, from: '', to: '' });
});

// ---------- Filter: smart djurfält ----------
// Ett fält för allt: "fåglar" → alla fåglar, "rov" → rovfåglar, "älg" → bara älg.

const KIND_OPTIONS = [
  { type: 'kind', value: 'daggdjur', label: 'Alla däggdjur', icon: '🐾', words: 'däggdjur djur' },
  { type: 'kind', value: 'fagel', label: 'Alla fåglar', icon: '🐦', words: 'fåglar fågel' },
];

function animalOptions(query) {
  const q = query.trim().toLowerCase();
  if (!q) return KIND_OPTIONS;

  const shortLabel = (label) => label.split(' (')[0];
  const groups = Object.entries(window.SPECIES_GROUPS)
    .filter(([key]) => key !== 'ovrigt')
    .map(([key, g]) => ({
      type: 'group', value: key, label: shortLabel(g.label), icon: iconFor(null, key),
      words: g.label, sub: g.kind === 'fagel' ? 'fåglar' : 'däggdjur',
    }));
  // Alla kända arter + arter som finns i rapporterna men inte i listan
  const names = new Map([...speciesIndex().values()].map((sp) => [sp.name.toLowerCase(), sp.name]));
  for (const r of reports) if (!names.has(r.species.toLowerCase())) names.set(r.species.toLowerCase(), r.species);
  const species = [...names.values()].map((name) => ({
    type: 'species', value: name, label: name, icon: iconFor(name), words: name,
  }));

  const score = (o) => {
    const label = o.label.toLowerCase();
    const words = `${label} ${o.words.toLowerCase()}`.split(/[\s/(),-]+/);
    // "Alla fåglar/däggdjur" först så fort ett ord börjar som man skrivit
    if (o.type === 'kind') return words.some((w) => w.startsWith(q)) ? -1 : 99;
    if (label.startsWith(q)) return 0;
    if (words.some((w) => w.startsWith(q))) return 1;
    if (o.words.toLowerCase().includes(q)) return 2;
    return 99;
  };
  const typeOrder = { kind: 0, group: 1, species: 2 };
  // En grupp med samma namn som en art (t.ex. "Älg") behövs inte två gånger
  const speciesNames = new Set(species.map((o) => o.label.toLowerCase()));
  const uniqueGroups = groups.filter((g) => !speciesNames.has(g.label.toLowerCase()));
  return [...KIND_OPTIONS, ...uniqueGroups, ...species]
    .map((o) => ({ ...o, score: score(o) }))
    .filter((o) => o.score < 99)
    .sort((a, b) => a.score - b.score || typeOrder[a.type] - typeOrder[b.type] || a.label.localeCompare(b.label, 'sv'))
    .slice(0, 10);
}

let animalMatches = [];
let activeAnimal = -1;

function showAnimalSuggestions() {
  animalMatches = animalOptions($('filter-animal').value);
  activeAnimal = -1;
  const box = $('filter-animal-suggestions');
  const typeText = { kind: '', group: '<span class="sub">grupp</span>', species: '' };
  box.innerHTML = [
    '<li role="option" data-index="-1">🌍 Alla djur</li>',
    ...animalMatches.map((o, i) => `
      <li role="option" data-index="${i}" class="${o.type === 'kind' ? 'kind' : ''}">
        ${o.icon} ${escapeHtml(o.label)} ${typeText[o.type]}
      </li>`),
  ].join('');
  box.hidden = false;
}

function hideAnimalSuggestions() {
  $('filter-animal-suggestions').hidden = true;
}

function chooseAnimal(index) {
  const o = animalMatches[index];
  hideAnimalSuggestions();
  $('filter-animal').blur();
  setFilter({ animal: o ? { type: o.type, value: o.value, label: o.label, icon: o.icon } : null });
}

$('filter-animal').addEventListener('focus', (e) => {
  e.target.select();
  showAnimalSuggestions();
});
$('filter-animal').addEventListener('input', showAnimalSuggestions);
$('filter-animal').addEventListener('blur', () => setTimeout(() => {
  hideAnimalSuggestions();
  $('filter-animal').value = filter.animal?.label ?? '';
}, 150));
$('filter-animal-suggestions').addEventListener('mousedown', (e) => e.preventDefault());
$('filter-animal-suggestions').addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (li) chooseAnimal(Number(li.dataset.index));
});
$('filter-animal').addEventListener('keydown', (e) => {
  const items = [...$('filter-animal-suggestions').children];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    activeAnimal = (activeAnimal + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items.forEach((li, i) => li.classList.toggle('active', i === activeAnimal));
  } else if (e.key === 'Enter') {
    e.preventDefault();
    // Enter utan markering = första förslaget
    const li = items[activeAnimal] ?? items[1] ?? items[0];
    if (li) chooseAnimal(Number(li.dataset.index));
  } else if (e.key === 'Escape') {
    hideAnimalSuggestions();
  }
});

// ---------- Visa karta och lista ----------

function render() {
  const list = getFilteredReports();
  renderMarkers(list);
  renderList(list);
  renderRisk(list);
  renderStats(list);
  renderFilterBar(list.length);
  // Filterraden kan ändra höjd – då måste kartan räkna om sin storlek
  map?.invalidateSize();
}

function renderList(list) {
  $('report-list').innerHTML = list.map((r) => {
    const own = r.user_id === currentUser?.id;
    return `
      <li class="report-card ${own ? 'own' : ''}" style="border-left-color:${colorFor(r.user_id)}">
        ${typeBadge(r)}
        <h3><span class="card-icon${r.is_flock ? ' pin-flock' : ''}" style="background:${colorFor(r.user_id)};--c:${colorFor(r.user_id)}">${iconFor(r.species)}</span>
            ${escapeHtml(r.species)} (${countText(r)})</h3>
        ${fieldsLine(r, 'p')}
        ${companionsLine(r, 'p')}
        <p>🕒 ${formatDateTime(r.observed_at)}</p>
        <p>${weatherLine(r)}</p>
        <p>👤 ${escapeHtml(nameFor(r.user_id, r.reporter_email))}${own ? ' (du)' : ''}</p>
        ${r.comment ? `<p class="comment">💬 ${escapeHtml(r.comment)}</p>` : ''}
        <p>${riskPill(r)}</p>
        <div class="actions">
          <button class="btn btn-secondary" data-action="risk" data-id="${r.id}">📄 Detaljer</button>
          <button class="btn btn-secondary" data-action="show" data-id="${r.id}">Visa på kartan</button>
          ${canEdit(r) ? `
            <button class="btn btn-secondary" data-action="edit" data-id="${r.id}">Redigera</button>
            <button class="btn btn-danger" data-action="delete" data-id="${r.id}">Ta bort</button>` : ''}
        </div>
      </li>`;
  }).join('') || `<li class="hint">${reports.length ? 'Inga rapporter matchar filtret.' : 'Inga rapporter än.'}</li>`;
}

// ---------- Väder, ljus och tid på dygnet ----------
// Beräkningarna finns i weather.js. Vädret sparas i rapporten när den skapas.

const contextCache = new Map();

// Ljus, tid på dygnet och väder för en rapport (sparas i minnet)
function contextOf(r) {
  const key = `${r.id}|${r.observed_at}|${r.lat}|${r.lng}|${r.weather?.fetched ?? ''}`;
  let c = contextCache.get(key);
  if (!c) {
    const light = WEATHER.lightPhase(r.observed_at, r.lat, r.lng);
    c = { light: light.key, sunAlt: light.altitude, tod: WEATHER.timeOfDay(r.observed_at)?.key, wx: WEATHER.analyze(r.weather) };
    contextCache.set(key, c);
  }
  return c;
}

// Kort rad: "🌅 Gryning · 🌧️ Lätt regn · 8° · 6 m/s (byar 11)"
function weatherLine(r) {
  const c = contextOf(r);
  const light = WEATHER.LIGHT[c.light];
  return `<span class="wx-line">${light.icon} ${light.label} · ${c.wx ? escapeHtml(WEATHER.shortText(c.wx)) : '<em>väder saknas</em>'}</span>`;
}

// Utfällbar vädersektion i händelsevyn
function weatherDetailsHtml(r) {
  const c = contextOf(r);
  const light = WEATHER.LIGHT[c.light];
  const tod = WEATHER.TIME_OF_DAY.find((t) => t.key === c.tod);
  const lightText = `${light.icon} ${light.label} (solen ${Math.round(c.sunAlt)}°) · ${tod.icon} ${tod.label}`;
  if (!c.wx) {
    return `<div class="wx-details"><div class="wx-body" style="padding-top:10px">
      <strong>🌦️ Väder</strong><br>${lightText}<br><span class="hint">Väder saknas för den här rapporten – det hämtas automatiskt när det går.</span></div></div>`;
  }
  const a = c.wx;
  const n = a.now;
  const f = WEATHER.format;
  const hourFmt = (t) => new Date(t).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
  const rows = r.weather.hours.map((h, i, all) => {
    const info = WEATHER.codeInfo(h.code, h.day !== 0);
    return `<tr class="${i === all.length - 1 ? 'obs' : ''}">
      <td>${hourFmt(h.t)}</td><td title="${escapeHtml(info.text)}">${info.icon}</td><td>${f.temp(h.temp)}</td>
      <td>${f.r1(h.precip)}</td><td>${h.wind == null ? '–' : Math.round(h.wind)}/${h.gust == null ? '–' : Math.round(h.gust)}</td>
      <td>${h.cloud ?? '–'}</td><td>${h.vis == null ? '–' : h.vis >= 10000 ? '10+' : f.r1(h.vis / 1000)}</td></tr>`;
  }).join('');
  const change = (x, unit) => (x == null ? '–' : `${x > 0 ? '+' : ''}${f.r1(x)} ${unit}`);
  return `
    <details class="wx-details">
      <summary>🌦️ Väder: ${escapeHtml(WEATHER.shortText(a))}<small>${lightText} · tryck för detaljer</small></summary>
      <div class="wx-body">
        <div class="wx-tags">${a.tags.map((t) => `<span class="wx-tag">${WEATHER.TAGS[t].icon} ${WEATHER.TAGS[t].label}</span>`).join('') || '<span class="hint">Inga särskilda vädermarkörer</span>'}</div>
        <div class="wx-facts">
          <div><span>Temperatur</span><span>${f.temp(n.temp)}</span></div>
          <div><span>Luftfuktighet</span><span>${n.hum ?? '–'} %</span></div>
          <div><span>Vind</span><span>${f.r1(n.wind)} m/s ${WEATHER.windDir(n.dir)}</span></div>
          <div><span>Byar (max 4 h)</span><span>${f.r1(a.maxGust)} m/s</span></div>
          <div><span>Nederbörd timmen</span><span>${f.r1(a.precipNow)} mm</span></div>
          <div><span>Nederbörd 4 h före</span><span>${f.r1(a.precipBefore)} mm</span></div>
          <div><span>Moln</span><span>${n.cloud ?? '–'} %</span></div>
          <div><span>Sikt</span><span>${n.vis == null ? '–' : `${f.r1(n.vis / 1000)} km`}</span></div>
          <div><span>Sol senaste 4 h</span><span>${a.sunMinutes} min</span></div>
          <div><span>Lufttryck</span><span>${n.pres == null ? '–' : Math.round(n.pres)} hPa</span></div>
          <div><span>Tryckändring 4 h</span><span>${change(a.pressureChange, 'hPa')}</span></div>
          <div><span>Temperaturändring 4 h</span><span>${change(a.tempChange, '°')}</span></div>
        </div>
        <table class="wx-hours">
          <tr><th>Tid</th><th></th><th>Temp</th><th>mm</th><th>Vind/byar</th><th>Moln %</th><th>Sikt km</th></tr>
          ${rows}
        </table>
        <p class="hint wx-credit">Värden per timme, sista raden = observationen. Väderdata: Open-Meteo.com (CC BY 4.0).</p>
      </div>
    </details>`;
}

// Hämtar väder, men ger upp efter 8 sekunder (rapporten sparas ändå)
async function fetchWeatherSafe(lat, lng, observedAt) {
  try {
    return await Promise.race([
      WEATHER.fetchFor(lat, lng, observedAt),
      new Promise((resolve) => { setTimeout(() => resolve(null), 8000); }),
    ]);
  } catch (err) {
    console.warn('Väder:', err.message);
    return null;
  }
}

// Fyller i väder på rapporter som saknar det (t.ex. gamla eller sparade utan nät)
const weatherFailed = new Set();
let backfillRunning = false;
async function backfillWeather() {
  if (backfillRunning || !navigator.onLine) return;
  const missing = reports.filter((r) => !r.weather && !weatherFailed.has(r.id)
    && new Date(r.observed_at).getTime() < Date.now() + 3600000).slice(0, 40);
  if (!missing.length) return;
  backfillRunning = true;
  let changed = 0;
  for (const r of missing) {
    const w = await fetchWeatherSafe(r.lat, r.lng, r.observed_at);
    if (!w) { weatherFailed.add(r.id); continue; }
    const { data, error } = await db.rpc('set_report_weather', { p_report_id: r.id, p_weather: w });
    if (error) {
      console.warn('Kunde inte spara väder:', error.message);
      weatherFailed.add(r.id);
      if (/function|schema cache/i.test(error.message)) break;  // databasen inte uppdaterad
      continue;
    }
    if (data) { r.weather = w; changed++; }
  }
  backfillRunning = false;
  if (changed) render();
}

// ---------- Statistik ----------
// Alla grupperingar. key(r) ger en nyckel (eller keys(r) flera), name(k) visningsnamn,
// order = fast ordning, filter(k) = vad som händer när man trycker på stapeln.
// Lägg gärna till fler grupperingar här när vi kommer på bra markörer.

const WEEKDAYS = ['Måndag', 'Tisdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lördag', 'Söndag'];
const MONTHS = ['Januari', 'Februari', 'Mars', 'April', 'Maj', 'Juni', 'Juli', 'Augusti', 'September', 'Oktober', 'November', 'December'];
const MISSING = '__saknas';
const swedishParts = (d) => {
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', weekday: 'long', month: 'numeric' })
    .formatToParts(new Date(d));
  return { weekday: parts.find((x) => x.type === 'weekday').value, month: Number(parts.find((x) => x.type === 'month').value) };
};
const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);

// Antal djur per rapport, i grupper
const COUNT_BANDS = [
  { label: '1', max: 1 }, { label: '2–5', max: 5 }, { label: '6–20', max: 20 },
  { label: '21–50', max: 50 }, { label: 'Över 50', max: Infinity },
];
const FLOCK_UNKNOWN_BAND = 'Flock, okänt antal';
COUNT_BANDS.push({ label: FLOCK_UNKNOWN_BAND, max: NaN });
function countBand(r) {
  if (r.animal_count == null) return r.is_flock ? FLOCK_UNKNOWN_BAND : null;
  return COUNT_BANDS.find((b) => r.animal_count <= b.max)?.label ?? null;
}

const STAT_DIMS = {
  species:   { label: 'Art', icon: '🐾', top: 12, key: (r) => r.species, name: (k) => `${iconFor(k)} ${k}`,
    filter: (k) => ({ animal: { type: 'species', value: k, label: k, icon: iconFor(k) } }) },
  kind:      { label: 'Fåglar / däggdjur', icon: '🦆', key: (r) => kindOf(r.species), order: ['fagel', 'daggdjur', 'annat'],
    name: (k) => ({ fagel: '🐦 Fåglar', daggdjur: '🐾 Däggdjur', annat: '❓ Annat' })[k],
    filter: (k) => (k === 'annat' ? null : { animal: { type: 'kind', value: k, label: k === 'fagel' ? 'Alla fåglar' : 'Alla däggdjur', icon: k === 'fagel' ? '🐦' : '🐾' } }) },
  group:     { label: 'Djurgrupp', icon: '🗂️', top: 12, key: (r) => groupOf(r.species),
    name: (k) => `${iconFor(null, k)} ${(window.SPECIES_GROUPS[k]?.label ?? k).split(' (')[0]}`,
    filter: (k) => ({ animal: { type: 'group', value: k, label: (window.SPECIES_GROUPS[k]?.label ?? k).split(' (')[0], icon: iconFor(null, k) } }) },
  tod:       { label: 'Tid på dygnet', icon: '🕒', key: (r) => contextOf(r).tod, order: WEATHER.TIME_OF_DAY.map((t) => t.key),
    name: (k) => { const t = WEATHER.TIME_OF_DAY.find((x) => x.key === k); return `${t.icon} ${t.label}`; }, filter: (k) => ({ tod: k }) },
  light:     { label: 'Ljus', icon: '🌅', key: (r) => contextOf(r).light, order: Object.keys(WEATHER.LIGHT),
    name: (k) => `${WEATHER.LIGHT[k].icon} ${WEATHER.LIGHT[k].label}`, filter: (k) => ({ light: k }) },
  hour:      { label: 'Klockslag', icon: '🕰️', key: (r) => String(WEATHER.localHour(r.observed_at)).padStart(2, '0'),
    order: Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')), name: (k) => `${k}–${String((Number(k) + 1) % 24).padStart(2, '0')}`, hideEmpty: true },
  condition: { label: 'Väderlek', icon: '🌦️', key: (r) => contextOf(r).wx?.condition ?? null, order: Object.keys(WEATHER.CONDITIONS),
    name: (k) => `${WEATHER.CONDITIONS[k].icon} ${WEATHER.CONDITIONS[k].label}` },
  wxtag:     { label: 'Vädermarkörer', icon: '🏷️', note: 'en rapport kan ha flera', keys: (r) => (contextOf(r).wx ? [...contextOf(r).wx.tagSet] : null),
    order: Object.keys(WEATHER.TAGS), name: (k) => `${WEATHER.TAGS[k].icon} ${WEATHER.TAGS[k].label}`,
    filter: (k) => ({ wx: filter.wx.includes(k) ? filter.wx : [...filter.wx, k] }) },
  temp:      { label: 'Temperatur', icon: '🌡️', key: (r) => WEATHER.bandFor(WEATHER.TEMP_BANDS, contextOf(r).wx?.now.temp),
    order: WEATHER.TEMP_BANDS.map((b) => b.label), name: (k) => k },
  wind:      { label: 'Vind', icon: '💨', key: (r) => WEATHER.bandFor(WEATHER.WIND_BANDS, contextOf(r).wx?.now.wind),
    order: WEATHER.WIND_BANDS.map((b) => b.label), name: (k) => k },
  weekday:   { label: 'Veckodag', icon: '📅', key: (r) => cap(swedishParts(r.observed_at).weekday), order: WEEKDAYS, name: (k) => k },
  month:     { label: 'Månad', icon: '🗓️', key: (r) => MONTHS[swedishParts(r.observed_at).month - 1], order: MONTHS, name: (k) => k, hideEmpty: true },
  type:      { label: 'Rapporttyp', icon: '⚠️', key: (r) => typeOf(r), order: Object.keys(REPORT_TYPES),
    name: (k) => REPORT_TYPES[k].label, filter: (k) => ({ type: k }) },
  zone:      { label: 'Läge', icon: '📍', key: (r) => assessReport(r).zone.zone, order: Object.keys(RISK.ZONES),
    name: (k) => RISK.ZONES[k]?.label ?? k },
  level:     { label: 'Risknivå (från början)', icon: '🚦', key: (r) => assessReport(r).baseLevel.key, order: RISK.LEVELS.map((l) => l.key),
    name: (k) => RISK.LEVELS.find((l) => l.key === k)?.label ?? k },
  habitat:   { label: 'Biotop', icon: '🌾', key: (r) => r.habitat, order: Object.keys(window.HABITATS), missing: 'Inte angiven',
    name: (k) => `${window.HABITATS[k].icon} ${window.HABITATS[k].label}`, filter: (k) => ({ habitat: k }) },
  position:  { label: 'Fågelns läge', icon: '☁️', onlyIf: (r) => kindOf(r.species) === 'fagel', key: (r) => r.bird_position,
    order: Object.keys(window.BIRD_POSITIONS), missing: 'Inte angivet',
    name: (k) => `${window.BIRD_POSITIONS[k].icon} ${window.BIRD_POSITIONS[k].label}`, filter: (k) => ({ position: k }) },
  flock:     { label: 'Flock eller inte (fåglar)', icon: '🐦', onlyIf: (r) => kindOf(r.species) === 'fagel',
    key: (r) => (r.is_flock ? 'ja' : 'nej'), order: ['ja', 'nej'],
    name: (k) => ({ ja: '🐦🐦🐦 Flock', nej: '🐦 Inte flock' })[k], filter: (k) => ({ flock: k }) },
  together:  { label: 'Sågs tillsammans med', icon: '👥', top: 12, note: 'arter på samma plats och tid',
    onlyIf: (r) => sightingGroup(r).length > 1, keys: (r) => [...new Set(companions(r).map((x) => x.species))],
    name: (k) => `${iconFor(k)} ${k}` },
  multi:     { label: 'Antal arter samtidigt', icon: '👥', key: (r) => { const n = sightingGroup(r).length; return n >= 4 ? '4 eller fler' : `${n}`; },
    order: ['1', '2', '3', '4 eller fler'], name: (k) => (k === '1' ? '1 art' : `${k} arter`),
    filter: (k) => ({ multi: k === '1' ? 'nej' : 'ja' }) },
  count:     { label: 'Antal djur per rapport', icon: '🔢', key: countBand, order: COUNT_BANDS.map((b) => b.label), name: (k) => k },
  reporter:  { label: 'Rapportör', icon: '👤', top: 12, key: (r) => r.user_id, name: (k) => nameFor(k), filter: (k) => ({ reporter: k }) },
};
// Korten som visas (i den här ordningen)
const STAT_CARDS = ['species', 'kind', 'habitat', 'position', 'flock', 'count', 'multi', 'together', 'tod', 'light', 'condition', 'wxtag', 'temp', 'wind', 'hour', 'weekday', 'month', 'type', 'zone', 'level', 'group', 'reporter'];

const STATS_KEY = 'viltrapport-stats';
let statsPrefs = (() => {
  try { return { metric: 'reports', rows: 'species', cols: 'tod', ...JSON.parse(localStorage.getItem(STATS_KEY) || '{}') }; } catch { return { metric: 'reports', rows: 'species', cols: 'tod' }; }
})();
function saveStatsPrefs(changes) {
  statsPrefs = { ...statsPrefs, ...changes };
  try { localStorage.setItem(STATS_KEY, JSON.stringify(statsPrefs)); } catch { /* ignoreras */ }
}

const weightOf = (r) => (statsPrefs.metric === 'animals' ? (Number(r.animal_count) || 1) : 1);
const keysOf = (dim, r) => {
  const d = STAT_DIMS[dim];
  if (d.onlyIf && !d.onlyIf(r)) return [];   // räknas inte alls (t.ex. däggdjur i "Fågelns läge")
  const k = d.keys ? d.keys(r) : [d.key(r)];
  return k == null || k[0] == null ? [MISSING] : k;
};
const dimName = (dim, k) => (k === MISSING
  ? (STAT_DIMS[dim].missing ?? (['condition', 'wxtag', 'temp', 'wind'].includes(dim) ? 'Väder saknas' : 'Okänt'))
  : STAT_DIMS[dim].name(k));

// Räknar per nyckel. Ger [[nyckel, värde], …] sorterat.
function tally(dim, list) {
  const d = STAT_DIMS[dim];
  const counts = new Map();
  for (const r of list) for (const k of keysOf(dim, r)) counts.set(k, (counts.get(k) ?? 0) + weightOf(r));
  let rows = [...counts];
  if (d.order) {
    rows = [...d.order.map((k) => [k, counts.get(k) ?? 0]).filter(([, v]) => v || !d.hideEmpty),
      ...rows.filter(([k]) => !d.order.includes(k))];
  } else {
    rows.sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), 'sv'));
  }
  return rows;
}

function renderStats(list) {
  if (!$('stats-cards') || $('stats-view').hidden) return;
  const metricWord = statsPrefs.metric === 'animals' ? 'djur' : 'rapporter';
  document.querySelectorAll('#stats-metric [data-metric]').forEach((b) => b.classList.toggle('selected', b.dataset.metric === statsPrefs.metric));

  // Nyckeltal
  const animals = list.reduce((sum, r) => sum + (Number(r.animal_count) || 0), 0);
  const withWx = list.filter((r) => contextOf(r).wx).length;
  const kpis = [
    [list.length, 'rapporter'], [animals, 'djur'], [new Set(list.map((r) => r.species)).size, 'arter'],
    [list.filter((r) => typeOf(r) === 'olycka').length, 'olyckor'], [list.filter((r) => typeOf(r) === 'birdstrike').length, 'birdstrikes'],
    [list.length ? `${Math.round((withWx / list.length) * 100)} %` : '–', 'med väder'],
  ];
  $('stats-kpis').innerHTML = kpis.map(([v, l]) => `<div class="kpi"><strong>${v}</strong><span>${l}</span></div>`).join('');

  // Korta slutsatser
  const top = (dim) => tally(dim, list).filter(([k]) => k !== MISSING).sort((a, b) => b[1] - a[1])[0];
  const total = list.reduce((sum, r) => sum + weightOf(r), 0);
  const pct = (v) => (total ? Math.round((v / total) * 100) : 0);
  const insights = [];
  if (list.length) {
    const sp = top('species'); const td = top('tod'); const li = top('light'); const co = top('condition');
    if (sp) insights.push(`Flest ${metricWord}: <strong>${escapeHtml(dimName('species', sp[0]))}</strong> (${sp[1]}, ${pct(sp[1])} %)`);
    if (td) insights.push(`Vanligaste tid på dygnet: <strong>${dimName('tod', td[0])}</strong> (${pct(td[1])} %)`);
    if (li) insights.push(`Ljus: oftast <strong>${dimName('light', li[0])}</strong> (${pct(li[1])} %)`);
    if (co) insights.push(`Vanligaste väder: <strong>${dimName('condition', co[0])}</strong> (${pct(co[1])} %)`);
  }
  $('stats-insights').innerHTML = insights.map((x) => `<p>💡 ${x}</p>`).join('');

  // Stapeldiagram
  $('stats-cards').innerHTML = STAT_CARDS.map((dim) => {
    const d = STAT_DIMS[dim];
    let rows = tally(dim, list);
    if (d.top && rows.length > d.top) {
      const rest = rows.slice(d.top).reduce((sum, [, v]) => sum + v, 0);
      rows = [...rows.slice(0, d.top), ['__ovriga', rest]];
    }
    const maxV = Math.max(1, ...rows.map(([, v]) => v));
    const bars = rows.map(([k, v]) => {
      const label = k === '__ovriga' ? 'Övriga' : dimName(dim, k);
      const clickable = d.filter && k !== MISSING && k !== '__ovriga' && d.filter(k);
      const tag = clickable ? 'button' : 'div';
      const tip = `${label}: ${v} ${metricWord} (${pct(v)} %)`;
      return `<${tag} ${clickable ? `type="button" data-stat-dim="${dim}" data-stat-key="${escapeHtml(k)}"` : ''}
          class="bar-row ${k === MISSING || k === '__ovriga' ? 'muted' : ''}" title="${escapeHtml(tip)}">
        <span class="bar-label">${escapeHtml(label)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${(v / maxV) * 100}%"></span></span>
        <span class="bar-value">${v}<small>${pct(v)} %</small></span>
      </${tag}>`;
    }).join('') || '<p class="hint">Inga data.</p>';
    return `<div class="stat-card"><h3>${d.icon} ${d.label}${d.note ? `<small>${d.note}</small>` : ''}</h3>${bars}</div>`;
  }).join('');

  renderCompare(list);
}

// Jämförelsetabell: rader × kolumner, färgstyrka efter antal
const SEQ_BLUE = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];
function renderCompare(list) {
  const options = STAT_CARDS.map((k) => `<option value="${k}">${STAT_DIMS[k].label}</option>`).join('');
  for (const [id, key] of [['compare-rows', 'rows'], ['compare-cols', 'cols']]) {
    if (!$(id).options.length) $(id).innerHTML = options;
    $(id).value = statsPrefs[key];
  }
  const rDim = statsPrefs.rows;
  const cDim = statsPrefs.cols;
  const rowKeys = tally(rDim, list).filter(([, v]) => v).slice(0, 15).map(([k]) => k);
  const colKeys = tally(cDim, list).filter(([, v]) => v).slice(0, 10).map(([k]) => k);
  if (!rowKeys.length || !colKeys.length) {
    $('compare-table').innerHTML = '<p class="hint">Inga data att jämföra.</p>';
    return;
  }
  const cell = new Map();
  for (const r of list) {
    for (const a of keysOf(rDim, r)) for (const b of keysOf(cDim, r)) {
      const key = `${a}\u0000${b}`;
      cell.set(key, (cell.get(key) ?? 0) + weightOf(r));
    }
  }
  const maxV = Math.max(1, ...cell.values());
  const shade = (v) => {
    if (!v) return 'background:transparent;color:var(--muted)';
    const i = Math.min(SEQ_BLUE.length - 1, Math.floor((v / maxV) * (SEQ_BLUE.length - 1) + 0.0001));
    return `background:${SEQ_BLUE[i]};color:${i >= 3 ? '#fff' : '#17181c'}`;
  };
  const head = `<tr><th></th>${colKeys.map((k) => `<th>${escapeHtml(dimName(cDim, k))}</th>`).join('')}</tr>`;
  const body = rowKeys.map((rk) => `<tr><th class="row-head" title="${escapeHtml(dimName(rDim, rk))}">${escapeHtml(dimName(rDim, rk))}</th>${
    colKeys.map((ck) => { const v = cell.get(`${rk}\u0000${ck}`) ?? 0;
      return `<td style="${shade(v)}" title="${escapeHtml(`${dimName(rDim, rk)} + ${dimName(cDim, ck)}: ${v}`)}">${v || '·'}</td>`; }).join('')}</tr>`).join('');
  $('compare-table').innerHTML = `<table class="compare-table">${head}${body}</table>`;
}

$('stats-metric').addEventListener('click', (e) => {
  const b = e.target.closest('[data-metric]');
  if (!b) return;
  saveStatsPrefs({ metric: b.dataset.metric });
  render();
});
$('compare-rows').addEventListener('change', (e) => { saveStatsPrefs({ rows: e.target.value }); render(); });
$('compare-cols').addEventListener('change', (e) => { saveStatsPrefs({ cols: e.target.value }); render(); });
$('stats-cards').addEventListener('click', (e) => {
  const b = e.target.closest('[data-stat-dim]');
  if (!b) return;
  const change = STAT_DIMS[b.dataset.statDim].filter(b.dataset.statKey);
  if (change) {
    setFilter(change);
    showToast('Filtret är uppdaterat');
  }
});

// ---------- Riskanalys ----------
// Beräkningen finns i risk.js. Här visas den och här registreras åtgärder.

let riskStatus = 'active';   // vilka som visas i riskfliken: active, resolved, all
let openRiskId = null;       // rapporten som visas i riskrutan

function assessReport(r) {
  return RISK.assess({
    species: r.species,
    groupKey: groupOf(r.species),
    kind: kindOf(r.species),
    count: riskCount(r),
    lat: r.lat,
    lng: r.lng,
    zones: riskZones,
    reportType: typeOf(r),
    observedAt: r.observed_at,
  });
}

function actionsFor(reportId) {
  return reportActions.filter((a) => a.report_id === reportId);
}

// Senaste åtgärden som "stänger" risken (skrämt bort, avlivat …), annars null
function closingAction(reportId) {
  return actionsFor(reportId).filter((a) => RISK.ACTIONS[a.action]?.closes).pop() ?? null;
}

function riskPill(r) {
  const a = assessReport(r);
  const done = closingAction(r.id);
  if (a.expired && !done) return '<span class="risk-pill resolved">⏳ Inaktuell risk</span>';
  return `<span class="risk-pill ${done ? 'resolved' : ''}" style="--level:${a.level.color}">
    ⚠️ ${a.score} · ${a.level.label}${done ? ' · hanterad' : ''}</span>`;
}

// "2 dygn" / "5 tim" – hur gammal observationen är
function ageText(hours) {
  return hours >= 48 ? `${Math.floor(hours / 24)} dygn` : hours >= 24 ? '1 dygn' : `${Math.max(0, Math.floor(hours))} tim`;
}

function renderRisk(list) {
  if (!$('risk-list')) return;
  const rows = list.map((r) => ({ r, a: assessReport(r), done: closingAction(r.id) }));

  // Sammanfattning: antal aktiva per nivå (inaktuella och hanterade räknas inte)
  const isActive = (x) => !x.done && !x.a.expired;
  const active = rows.filter(isActive);
  $('risk-summary').innerHTML = RISK.LEVELS.map((l) => `
    <div class="risk-count" style="--level:${l.color}">
      <strong>${active.filter((x) => x.a.level.key === l.key).length}</strong>${l.label}
    </div>`).join('');

  document.querySelectorAll('#risk-status [data-status]').forEach((b) => {
    b.classList.toggle('selected', b.dataset.status === riskStatus);
  });
  $('risk-nozones').hidden = riskZones.length > 0;

  const shown = rows
    .filter((x) => riskStatus === 'all' || (riskStatus === 'active' ? isActive(x) : x.done))
    .sort((x, y) => y.a.score - x.a.score || new Date(y.r.observed_at) - new Date(x.r.observed_at));

  $('risk-list').innerHTML = shown.map(({ r, a, done }) => `
    <li class="report-card risk-card" data-action="risk" data-id="${r.id}" style="border-left-color:${a.expired && !done ? 'var(--muted)' : a.level.color}">
      ${a.expired && !done
        ? '<div class="risk-score resolved">⏳<small>Inaktuell</small></div>'
        : `<div class="risk-score ${done ? 'resolved' : ''}" style="--level:${a.level.color}">${a.score}<small>${a.level.label}</small></div>`}
      <div class="risk-card-body">
        <h3>${iconFor(r.species)} ${escapeHtml(r.species)} (${countText(r)}) ${typeBadge(r)}</h3>
        <p>📍 ${escapeHtml(a.zone.name)}</p>
        <p>🕒 ${formatDateTime(r.observed_at)} · ${escapeHtml(nameFor(r.user_id, r.reporter_email))}</p>
        ${done ? `<p>✅ ${RISK.ACTIONS[done.action].label}</p>` : ''}
        ${!done && a.stepsDown && !a.expired ? `<p>⏬ Sänkt ${a.stepsDown} ${a.stepsDown === 1 ? 'nivå' : 'nivåer'} (${ageText(a.ageHours)} gammal)</p>` : ''}
      </div>
      <span class="chev">›</span>
    </li>`).join('') || `<li class="hint">${
      riskStatus === 'active' ? 'Inga aktiva risker. 👍' : 'Inga rapporter att visa.'}</li>`;

  renderZoneList();
}

$('risk-status').addEventListener('click', (e) => {
  const b = e.target.closest('[data-status]');
  if (!b) return;
  riskStatus = b.dataset.status;
  render();
});

// ---------- Riskrapport för en rapport ----------

function openRisk(report) {
  closeRiskConfig();
  closeSheet();
  closeFilter();
  closeSettings();
  map?.closePopup();
  openRiskId = report.id;
  $('action-comment').value = '';
  $('risk-message').textContent = '';
  renderRiskSheet();
  $('risk-sheet').hidden = false;
  $('risk-sheet').scrollTop = 0;
}

function closeRisk() {
  $('risk-sheet').hidden = true;
  openRiskId = null;
}

function renderRiskSheet() {
  const r = reports.find((x) => x.id === openRiskId);
  if (!r) return closeRisk();
  const a = assessReport(r);
  const done = closingAction(r.id);
  const kind = kindOf(r.species);
  const kindText = kind === 'fagel' ? 'fågel' : kind === 'daggdjur' ? 'däggdjur' : 'okänt djur';
  const raw = a.severity * 10 * a.zoneFactor * a.flock;
  const otherZones = a.hits.filter((h) => h !== a.zone).map((h) => h.name);

  const expired = a.expired && !done;
  $('risk-content').innerHTML = `
    <div class="risk-head">
      ${expired
        ? '<div class="risk-score big resolved">⏳<small>inaktuell</small></div>'
        : `<div class="risk-score big ${done ? 'resolved' : ''}" style="--level:${a.level.color}">${a.score}<small>av 100</small></div>`}
      <div>
        <h3 style="color:${expired ? 'var(--muted)' : a.level.color}">${expired ? 'Inaktuell' : `${a.level.label} risk`}</h3>
        <p>${expired
          ? `Observationen är ${ageText(a.ageHours)} gammal och ingår inte längre i klassningen.`
          : `<strong>Rekommenderad åtgärd:</strong> ${a.level.action}`}</p>
      </div>
    </div>
    <div class="risk-status-line ${done || expired ? 'resolved' : 'active'}">
      ${done
        ? `✅ Hanterad: ${RISK.ACTIONS[done.action].label} – ${escapeHtml(nameFor(done.created_by))}, ${formatDateTime(done.created_at)}`
        : expired
          ? '⏳ Inaktuell – risken har sjunkit en nivå per dygn och är nu under Låg.'
          : `🔴 Aktiv – finns kvar tills en åtgärd registrerats (eller sjunker en nivå per dygn).`}
    </div>

    <h4 class="risk-section">Så räknades poängen</h4>
    <table class="risk-table">
      <tr><td>Djur: ${iconFor(r.species)} ${escapeHtml(r.species)} (${kindText})${fieldsText(r) ? `<br><small>${escapeHtml(fieldsText(r))}</small>` : ''}</td><td>${a.severity} / 10</td></tr>
      <tr><td>Läge: ${escapeHtml(a.zone.name)}<br><small>${RISK.ZONES[a.zone.zone].label}${
        otherZones.length ? ` · även: ${escapeHtml(otherZones.join(', '))}` : ''}</small></td><td>× ${a.zoneFactor}</td></tr>
      <tr><td>Antal: ${countText(r)}${r.is_flock && !r.animal_count ? `<br><small>flock utan antal räknas som ${RISK.FLOCK_UNKNOWN_COUNT}</small>` : ''}</td><td>× ${a.flock}</td></tr>
      <tr ${a.raisedByType || a.stepsDown ? '' : 'class="total"'}><td>${a.severity} × 10 × ${a.zoneFactor} × ${a.flock} = ${Math.round(raw)}${raw > 100 ? ' (max 100)' : ''}</td><td>${a.calculated}</td></tr>
      ${a.raisedByType ? `<tr ${a.stepsDown ? '' : 'class="total"'}><td>${REPORT_TYPES[typeOf(r)].label} är alltid minst ${RISK.levelFor(a.minScore).label} (${a.minScore})</td><td>${a.baseScore}</td></tr>` : ''}
      ${a.stepsDown ? `<tr class="total"><td>Ålder ${ageText(a.ageHours)}: sänkt ${a.stepsDown} ${a.stepsDown === 1 ? 'nivå' : 'nivåer'}
        (${a.baseLevel.label} → ${a.expired ? 'inaktuell' : a.level.label})</td><td>${a.expired ? '–' : a.score}</td></tr>` : ''}
    </table>

    ${weatherDetailsHtml(r)}

    <h4 class="risk-section">Rapporten</h4>
    <p>${typeBadge(r) || '👁️ Observation'} · 🕒 ${formatDateTime(r.observed_at)} · 👤 ${escapeHtml(nameFor(r.user_id, r.reporter_email))}</p>
    ${r.comment ? `<p>💬 ${escapeHtml(r.comment)}</p>` : ''}

    <h4 class="risk-section">Åtgärdslogg</h4>
    <ul class="action-log">${actionsFor(r.id).map((x) => `
      <li>
        <span>${RISK.ACTIONS[x.action]?.icon ?? ''} <strong>${RISK.ACTIONS[x.action]?.label ?? x.action}</strong>
          ${x.comment ? ` – ${escapeHtml(x.comment)}` : ''}
          <small>${escapeHtml(nameFor(x.created_by))} · ${formatDateTime(x.created_at)}</small></span>
        ${x.created_by === currentUser?.id || isAdmin
          ? `<button type="button" class="btn btn-danger" data-action-delete="${x.id}">Ta bort</button>` : ''}
      </li>`).join('') || '<li><span class="hint">Inga åtgärder registrerade än.</span></li>'}
    </ul>`;

  // Knappar för att registrera åtgärd
  const entries = Object.entries(RISK.ACTIONS);
  const btn = ([key, x]) => `<button type="button" class="${x.closes ? 'closes' : ''}" data-register="${key}">${x.icon} ${x.label}</button>`;
  $('action-grid').innerHTML =
    '<div class="grid-title">Hanterar risken</div>' + entries.filter(([, x]) => x.closes).map(btn).join('') +
    '<div class="grid-title">Loggas utan att stänga</div>' + entries.filter(([, x]) => !x.closes).map(btn).join('');
}

$('action-grid').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-register]');
  if (!b || !openRiskId) return;
  const action = b.dataset.register;
  const comment = $('action-comment').value.trim() || null;
  b.disabled = true;
  const { error } = await db.from('report_actions').insert({ report_id: openRiskId, action, comment });
  b.disabled = false;
  if (error) {
    $('risk-message').textContent = translateError(error);
    return;
  }
  $('action-comment').value = '';
  showToast(`${RISK.ACTIONS[action].label} registrerat`);
  await loadReports();
  renderRiskSheet();
});

$('risk-content').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-action-delete]');
  if (!b || !confirm('Ta bort åtgärden?')) return;
  const { error } = await db.from('report_actions').delete().eq('id', b.dataset.actionDelete);
  if (error) {
    $('risk-message').textContent = translateError(error);
    return;
  }
  await loadReports();
  renderRiskSheet();
});

$('risk-close').addEventListener('click', closeRisk);
$('risk-show-map').addEventListener('click', () => {
  const r = reports.find((x) => x.id === openRiskId);
  closeRisk();
  if (r) showOnMap(r);
});

// ---------- Riskinställningar (admin) ----------
// Alla kan se hur risken räknas. Admin kan ändra och spara (tabellen risk_config).

function openRiskConfig() {
  closeRisk();
  closeFilter();
  closeSheet();
  $('riskcfg-message').textContent = '';
  $('riskcfg-title').textContent = isAdmin ? 'Riskinställningar' : 'Så räknas risken';
  $('riskcfg-save').hidden = !isAdmin;
  $('riskcfg-reset').hidden = !isAdmin;
  $('riskcfg-cancel').textContent = isAdmin ? 'Avbryt' : 'Stäng';
  $('riskcfg-meta').textContent = riskConfigMeta?.updated_by
    ? `Senast ändrad av ${nameFor(riskConfigMeta.updated_by)}, ${formatDateTime(riskConfigMeta.updated_at)}.`
    : 'Standardinställningar används.';
  $('species-datalist').innerHTML = [...speciesIndex().values()].map((sp) => `<option value="${escapeHtml(sp.name)}">`).join('');
  renderRiskConfigForm(RISK.currentConfig());
  $('riskcfg-sheet').hidden = false;
  $('riskcfg-sheet').scrollTop = 0;
}

function closeRiskConfig() {
  $('riskcfg-sheet').hidden = true;
}

// Bygger formuläret från en config
function renderRiskConfigForm(c) {
  const ro = isAdmin ? '' : 'disabled';
  const n = (attrs, value, step = 1, min = 0, max = 100) =>
    `<input type="number" inputmode="decimal" ${attrs} value="${value}" step="${step}" min="${min}" max="${max}" ${ro}>`;
  const section = (title, hint, inner, open = false) => `
    <details class="cfg-section" ${open ? 'open' : ''}>
      <summary>${title}</summary>
      <div class="cfg-inner">${hint ? `<p class="hint">${hint}</p>` : ''}${inner}</div>
    </details>`;

  const groups = Object.entries(window.SPECIES_GROUPS).map(([key, g]) => `
    <div class="cfg-row"><span class="cfg-label">${g.icon} ${escapeHtml(g.label)}</span>
      ${n(`data-group="${key}"`, c.GROUP_SEVERITY[key] ?? 5, 1, 1, 10)}</div>`).join('');

  const speciesRow = (name, value) => `
    <div class="cfg-row" data-species-row>
      <input type="text" list="species-datalist" value="${escapeHtml(name)}" placeholder="Art" maxlength="100" ${ro}>
      ${n('data-species-value', value, 1, 1, 10)}
      ${isAdmin ? '<button type="button" class="btn btn-danger" data-species-remove>✕</button>' : ''}
    </div>`;
  const species = Object.entries(c.SPECIES_SEVERITY).map(([k, v]) => speciesRow(k, v)).join('') +
    (isAdmin ? '<button type="button" class="btn btn-secondary btn-block" id="cfg-add-species">+ Lägg till art</button>' : '');

  const zones = '<div class="cfg-head"><span>Läge</span><span>Fågel</span><span>Däggdjur</span></div>' +
    Object.entries(c.ZONES).map(([key, z]) => `
    <div class="cfg-row"><span class="cfg-label">${escapeHtml(RISK.ZONES[key]?.label ?? key)}</span>
      ${n(`data-zone="${key}" data-kind="bird"`, z.bird, 0.05, 0, 1)}
      ${n(`data-zone="${key}" data-kind="mammal"`, z.mammal, 0.05, 0, 1)}</div>`).join('');

  const steps = c.FLOCK.filter((f) => f.min > 1).sort((a, b) => a.min - b.min);
  while (steps.length < 4) steps.push({ min: '', factor: '' });
  const flock = '<div class="cfg-head"><span>Från antal djur</span><span>Antal</span><span>Faktor</span></div>' +
    '<div class="cfg-row"><span class="cfg-label">1 djur</span><input type="number" value="1" disabled><input type="number" value="1" disabled></div>' +
    steps.map((f, i) => `
    <div class="cfg-row"><span class="cfg-label">Steg ${i + 1}</span>
      ${n(`data-flock-min="${i}"`, f.min, 1, 2, 100000)}
      ${n(`data-flock-factor="${i}"`, f.factor, 0.1, 0.1, 10)}</div>`).join('') +
    `<div class="cfg-row"><span class="cfg-label">Fågelflock utan antal räknas som (djur)</span>${n('data-flock-unknown', c.FLOCK_UNKNOWN_COUNT, 1, 2, 100000)}</div>`;

  const levels = c.LEVELS.map((l) => `
    <div class="cfg-row cfg-level">
      <div class="cfg-line"><span class="cfg-label" style="color:${l.color}">● ${l.label}</span>
        ${l.key === 'lag' ? '<span class="hint">från 0</span>' : `<span class="hint">från</span>${n(`data-level-min="${l.key}"`, l.min, 1, 1, 100)}`}</div>
      <input type="text" data-level-action="${l.key}" value="${escapeHtml(l.action)}" maxlength="200" placeholder="Rekommenderad åtgärd" ${ro}>
    </div>`).join('');

  const types = Object.entries(c.MIN_SCORE_BY_TYPE).map(([key, v]) => `
    <div class="cfg-row"><span class="cfg-label">${REPORT_TYPES[key]?.label ?? key} är alltid minst</span>
      ${n(`data-min-type="${key}"`, v, 1, 0, 100)}</div>`).join('');

  const dist = [
    ['APPROACH_LENGTH', 'In-/utflygning ut från banände (m)', 100, 0, 20000],
    ['RUNWAY_HALF_WIDTH', 'Banområde på var sida om mittlinjen (m)', 10, 10, 1000],
    ['RUNWAY_END_EXTRA', 'Banområde förbi banänden (m)', 10, 0, 1000],
    ['APPROACH_SPREAD', 'Inflygningen vidgas per meter (0,15 = 15 %)', 0.01, 0, 1],
    ['TAXIWAY_HALF_WIDTH', 'Taxibana på var sida om mittlinjen (m)', 5, 5, 500],
    ['NEAR_FENCE', '"Nära stängslet" inom (m)', 50, 0, 5000],
  ].map(([key, label, step, min, max]) => `
    <div class="cfg-row"><span class="cfg-label">${label}</span>${n(`data-dist="${key}"`, c[key], step, min, max)}</div>`).join('');

  $('riskcfg-body').innerHTML =
    `<p class="hint">Poäng = djurets vikt × 10 × lägesfaktor × flockfaktor (max 100). Sedan sänks nivån med tiden.</p>` +
    section('🐾 Djurens vikt (1–10)', 'Standard per djurgrupp. Minsta fågel = 1, älg = 10.', groups, true) +
    section('🎯 Enskilda arter', 'Arter som ska ha en annan vikt än sin grupp.', species) +
    section('📍 Läge (faktor 0–1)', 'Hur farligt läget är. Den högsta zonen djuret befinner sig i gäller.', zones) +
    section('🐦‍⬛ Flock', 'Fler djur ger högre risk. Lämna tomt för att ta bort ett steg.', flock) +
    section('🚦 Nivåer och åtgärder', 'Gränserna måste vara Kritisk > Hög > Medel.', levels) +
    section('✈️ Rapporttyp', 'Lägsta poäng oavsett uträkning (0 = ingen).', types) +
    section('⏳ Nedtrappning', 'Risken sjunker en nivå per så här många timmar. 0 = ingen nedtrappning.',
      `<div class="cfg-row"><span class="cfg-label">Timmar per nivå</span>${n('data-decay', c.DECAY_HOURS, 1, 0, 8760)}</div>`) +
    section('📏 Avstånd för zonerna', '', dist);
}

// Läser formuläret till en config. Kastar ett fel med förklaring om något är fel.
function collectRiskConfig() {
  const body = $('riskcfg-body');
  const val = (sel) => body.querySelector(sel)?.value;
  const cfg = RISK.currentConfig();

  body.querySelectorAll('[data-group]').forEach((el) => { cfg.GROUP_SEVERITY[el.dataset.group] = Number(el.value); });

  cfg.SPECIES_SEVERITY = {};
  body.querySelectorAll('[data-species-row]').forEach((row) => {
    const name = row.querySelector('input[type="text"]').value.trim();
    if (name) cfg.SPECIES_SEVERITY[name] = Number(row.querySelector('[data-species-value]').value);
  });

  body.querySelectorAll('[data-zone]').forEach((el) => { cfg.ZONES[el.dataset.zone][el.dataset.kind] = Number(el.value); });

  cfg.FLOCK = [{ min: 1, factor: 1 }];
  for (let i = 0; i < 4; i++) {
    const min = val(`[data-flock-min="${i}"]`);
    const factor = val(`[data-flock-factor="${i}"]`);
    if (min === '' && factor === '') continue;
    if (!(Number(min) >= 2) || !(Number(factor) > 0)) throw new Error(`Flock steg ${i + 1}: fyll i antal (minst 2) och faktor.`);
    cfg.FLOCK.push({ min: Number(min), factor: Number(factor) });
  }

  for (const l of cfg.LEVELS) {
    if (l.key !== 'lag') l.min = Number(val(`[data-level-min="${l.key}"]`));
    l.action = val(`[data-level-action="${l.key}"]`) || l.action;
  }
  const lv = Object.fromEntries(cfg.LEVELS.map((l) => [l.key, l.min]));
  if (!(lv.kritisk > lv.hog && lv.hog > lv.medel && lv.medel > 0)) {
    throw new Error('Nivågränserna måste vara Kritisk > Hög > Medel > 0.');
  }

  body.querySelectorAll('[data-min-type]').forEach((el) => { cfg.MIN_SCORE_BY_TYPE[el.dataset.minType] = Number(el.value); });
  cfg.DECAY_HOURS = Number(val('[data-decay]'));
  cfg.FLOCK_UNKNOWN_COUNT = Number(val('[data-flock-unknown]'));
  body.querySelectorAll('[data-dist]').forEach((el) => { cfg[el.dataset.dist] = Number(el.value); });

  for (const [k, v] of Object.entries(cfg)) {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(`Ogiltigt värde: ${k}`);
  }
  return cfg;
}

$('riskcfg-open').addEventListener('click', openRiskConfig);
$('riskcfg-cancel').addEventListener('click', closeRiskConfig);

$('riskcfg-body').addEventListener('click', (e) => {
  if (e.target.id === 'cfg-add-species') {
    e.target.insertAdjacentHTML('beforebegin', `
      <div class="cfg-row" data-species-row>
        <input type="text" list="species-datalist" placeholder="Art" maxlength="100">
        <input type="number" inputmode="decimal" data-species-value value="5" step="1" min="1" max="10">
        <button type="button" class="btn btn-danger" data-species-remove>✕</button>
      </div>`);
    e.target.previousElementSibling.querySelector('input').focus();
  }
  const remove = e.target.closest('[data-species-remove]');
  if (remove) remove.closest('[data-species-row]').remove();
});

async function saveRiskConfig(config, successText) {
  const { error } = await db.from('risk_config').update({ config }).eq('id', 1);
  if (error) {
    $('riskcfg-message').textContent = translateError(error);
    return false;
  }
  showToast(successText);
  closeRiskConfig();
  await loadReports();
  return true;
}

$('riskcfg-save').addEventListener('click', async () => {
  $('riskcfg-message').textContent = '';
  let cfg;
  try {
    cfg = collectRiskConfig();
  } catch (err) {
    $('riskcfg-message').textContent = err.message;
    return;
  }
  // Kör igenom samma kontroll som när den läses in, så att det sparade alltid är giltigt
  RISK.applyConfig(cfg);
  await saveRiskConfig(RISK.currentConfig(), 'Riskinställningarna är sparade – poängen räknas om');
});

$('riskcfg-reset').addEventListener('click', async () => {
  if (!confirm('Återställa alla riskinställningar till standard?')) return;
  await saveRiskConfig({}, 'Standardinställningarna gäller igen');
});

// ---------- Export till Excel ----------
// Använder biblioteket SheetJS (laddas bara när man exporterar).

const XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';

function loadScript(url) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${url}"]`)) return resolve();
    const el = document.createElement('script');
    el.src = url;
    el.onload = resolve;
    el.onerror = () => reject(new Error('Kunde inte ladda Excel-biblioteket. Kontrollera uppkopplingen.'));
    document.head.appendChild(el);
  });
}

// Ett ark från rader (objekt) med kolumnbredder och filter på rubrikraden
function makeSheet(rows, widths) {
  const ws = XLSX.utils.json_to_sheet(rows, { cellDates: true, dateNF: 'yyyy-mm-dd hh:mm' });
  // Datum visas som "2026-09-23 10:05" i Excel
  for (const cell of Object.values(ws)) {
    if (cell && cell.v instanceof Date) cell.z = 'yyyy-mm-dd hh:mm';
  }
  const headers = Object.keys(rows[0] ?? {});
  ws['!cols'] = headers.map((h) => ({ wch: widths?.[h] ?? Math.max(10, Math.min(40, h.length + 2)) }));
  if (rows.length) ws['!autofilter'] = { ref: ws['!ref'] };
  return ws;
}

// Väder, ljus och tid på dygnet som kolumner i exporten
function weatherColumns(r) {
  const c = contextOf(r);
  const a = c.wx;
  const n = a?.now;
  const v = (x) => (x == null ? '' : Math.round(x * 10) / 10);
  return {
    'Ljus': WEATHER.LIGHT[c.light].label,
    'Solhöjd (°)': Math.round(c.sunAlt),
    'Tid på dygnet': WEATHER.TIME_OF_DAY.find((t) => t.key === c.tod)?.label ?? '',
    'Väder': a ? a.info.text : 'Saknas',
    'Temperatur (°C)': v(n?.temp),
    'Vind (m/s)': v(n?.wind),
    'Byar max 4 h (m/s)': a ? v(a.maxGust) : '',
    'Vindriktning': n ? WEATHER.windDir(n.dir) : '',
    'Moln (%)': n?.cloud ?? '',
    'Sikt (m)': n?.vis ?? '',
    'Nederbörd timmen (mm)': a ? v(a.precipNow) : '',
    'Nederbörd 4 h före (mm)': a ? v(a.precipBefore) : '',
    'Sol 4 h (min)': a ? a.sunMinutes : '',
    'Lufttrycksändring 4 h (hPa)': a ? v(a.pressureChange) : '',
    'Vädermarkörer': a ? a.tags.map((t) => WEATHER.TAGS[t].label).join(', ') : '',
  };
}

// Datum till Excel (tomt om det saknas)
const xlDate = (value) => (value ? new Date(value) : '');

async function exportExcel(onlyFiltered) {
  const message = $('export-message');
  message.className = 'message';
  message.textContent = 'Skapar Excel-filen …';
  try {
    await loadScript(XLSX_URL);
  } catch (err) {
    message.textContent = err.message;
    return;
  }
  const list = onlyFiltered ? getFilteredReports() : [...reports].sort((a, b) => new Date(b.observed_at) - new Date(a.observed_at));
  const now = new Date();
  const kindText = { fagel: 'Fågel', daggdjur: 'Däggdjur', annat: 'Annat' };

  // Rapporter med riskdata
  const reportRows = list.map((r) => {
    const a = assessReport(r);
    const done = closingAction(r.id);
    const group = window.SPECIES_GROUPS[groupOf(r.species)];
    const status = done ? 'Hanterad' : a.expired ? 'Inaktuell' : 'Aktiv';
    return {
      'ID': r.id,
      'Typ': REPORT_TYPES[typeOf(r)].label,
      'Sedd': xlDate(r.observed_at),
      'Djurslag': r.species,
      'Djurgrupp': group ? group.label : 'Annat',
      'Fågel/däggdjur': kindText[kindOf(r.species)] ?? '',
      'Antal': r.animal_count ?? '',
      'Flock': r.is_flock ? 'Ja' : kindOf(r.species) === 'fagel' ? 'Nej' : '',
      'Fågelns läge': window.BIRD_POSITIONS[r.bird_position]?.label ?? '',
      'Biotop': window.HABITATS[r.habitat]?.label ?? '',
      'Observation (id)': r.sighting_id ? r.sighting_id.slice(0, 8) : '',
      'Arter samtidigt': sightingGroup(r).length,
      'Tillsammans med': companions(r).map((x) => `${x.species} (${countText(x)})`).join(', '),
      'Rapportör': nameFor(r.user_id, r.reporter_email),
      'Rapportörens e-post': r.reporter_email,
      'Kommentar': r.comment ?? '',
      'Latitud': r.lat,
      'Longitud': r.lng,
      'Zon': a.zone.name,
      'Läge': RISK.ZONES[a.zone.zone]?.label ?? '',
      'Djurets vikt (1-10)': a.severity,
      'Lägesfaktor': a.zoneFactor,
      'Flockfaktor': a.flock,
      'Uträknad poäng': a.calculated,
      'Grundpoäng': a.baseScore,
      'Grundnivå': a.baseLevel.label,
      'Ålder (timmar)': Math.round(a.ageHours),
      'Sänkta nivåer': a.stepsDown,
      'Aktuell poäng': a.expired ? '' : a.score,
      'Aktuell nivå': a.expired ? 'Inaktuell' : a.level.label,
      'Status': status,
      'Hanterad med': done ? RISK.ACTIONS[done.action]?.label ?? done.action : '',
      'Hanterad av': done ? nameFor(done.created_by) : '',
      'Hanterad': done ? xlDate(done.created_at) : '',
      'Antal åtgärder': actionsFor(r.id).length,
      'Registrerad': xlDate(r.created_at),
      'Senast ändrad': xlDate(r.updated_at),
      'Karta': `https://www.google.com/maps?q=${r.lat},${r.lng}`,
      ...weatherColumns(r),
    };
  });

  // Åtgärder
  const ids = new Set(list.map((r) => r.id));
  const actionRows = reportActions.filter((x) => ids.has(x.report_id)).map((x) => {
    const r = reports.find((y) => y.id === x.report_id);
    return {
      'Rapport-ID': x.report_id,
      'Djurslag': r?.species ?? '',
      'Rapporttyp': r ? REPORT_TYPES[typeOf(r)].label : '',
      'Sedd': r ? xlDate(r.observed_at) : '',
      'Åtgärd': RISK.ACTIONS[x.action]?.label ?? x.action,
      'Hanterar risken': RISK.ACTIONS[x.action]?.closes ? 'Ja' : 'Nej',
      'Kommentar': x.comment ?? '',
      'Registrerad av': nameFor(x.created_by),
      'Tid': xlDate(x.created_at),
    };
  });

  // Riskzoner
  const zoneRows = riskZones.map((z) => ({
    'Namn': z.name,
    'Typ': RISK.ZONE_TYPES[z.zone_type]?.label ?? z.zone_type,
    'Antal punkter': z.points.length,
    'Koordinater (lat, lng)': z.points.map((p) => p.join(', ')).join(' | '),
  }));

  // Sammanfattning
  const count = (fn) => reportRows.filter(fn).length;
  const summaryRows = [
    { 'Uppgift': 'Exporterad', 'Värde': now },
    { 'Uppgift': 'Exporterad av', 'Värde': nameFor(currentUser.id, currentUser.email) },
    { 'Uppgift': 'Urval', 'Värde': onlyFiltered ? 'Det filtret visar' : 'Allt' },
    { 'Uppgift': 'Antal rapporter', 'Värde': reportRows.length },
    ...Object.values(REPORT_TYPES).map((t) => ({ 'Uppgift': `Typ: ${t.label}`, 'Värde': count((x) => x['Typ'] === t.label) })),
    ...['Aktiv', 'Hanterad', 'Inaktuell'].map((st) => ({ 'Uppgift': `Status: ${st}`, 'Värde': count((x) => x['Status'] === st) })),
    ...RISK.LEVELS.map((l) => ({ 'Uppgift': `Aktiva med nivå ${l.label}`, 'Värde': count((x) => x['Status'] === 'Aktiv' && x['Aktuell nivå'] === l.label) })),
    { 'Uppgift': 'Antal djur totalt', 'Värde': reportRows.reduce((sum, x) => sum + x['Antal'], 0) },
    { 'Uppgift': 'Antal åtgärder', 'Värde': actionRows.length },
  ];
  // Vanligaste arterna
  const bySpecies = {};
  for (const x of reportRows) {
    bySpecies[x['Djurslag']] ??= { rapporter: 0, djur: 0 };
    bySpecies[x['Djurslag']].rapporter += 1;
    bySpecies[x['Djurslag']].djur += x['Antal'];
  }
  const speciesRows = Object.entries(bySpecies)
    .sort((a, b) => b[1].rapporter - a[1].rapporter)
    .map(([name, v]) => ({ 'Djurslag': name, 'Antal rapporter': v.rapporter, 'Antal djur': v.djur }));

  // Inställningarna som gällde
  const c = RISK.currentConfig();
  const settingsRows = [
    ...Object.entries(c.GROUP_SEVERITY).map(([k, v]) => ({ 'Inställning': `Vikt: ${window.SPECIES_GROUPS[k]?.label ?? k}`, 'Värde': v })),
    ...Object.entries(c.SPECIES_SEVERITY).map(([k, v]) => ({ 'Inställning': `Vikt (art): ${k}`, 'Värde': v })),
    ...Object.entries(c.ZONES).flatMap(([k, z]) => [
      { 'Inställning': `Läge fågel: ${RISK.ZONES[k]?.label ?? k}`, 'Värde': z.bird },
      { 'Inställning': `Läge däggdjur: ${RISK.ZONES[k]?.label ?? k}`, 'Värde': z.mammal }]),
    ...c.FLOCK.map((f) => ({ 'Inställning': `Flock från ${f.min} djur`, 'Värde': f.factor })),
    ...c.LEVELS.map((l) => ({ 'Inställning': `Nivå ${l.label} från`, 'Värde': l.min, 'Åtgärd': l.action })),
    ...Object.entries(c.MIN_SCORE_BY_TYPE).map(([k, v]) => ({ 'Inställning': `Lägsta poäng: ${REPORT_TYPES[k]?.label ?? k}`, 'Värde': v })),
    { 'Inställning': 'Flock utan antal räknas som (djur)', 'Värde': c.FLOCK_UNKNOWN_COUNT },
    { 'Inställning': 'Nedtrappning (timmar per nivå)', 'Värde': c.DECAY_HOURS },
    { 'Inställning': 'In-/utflygning (m)', 'Värde': c.APPROACH_LENGTH },
    { 'Inställning': 'Banområde halv bredd (m)', 'Värde': c.RUNWAY_HALF_WIDTH },
    { 'Inställning': 'Taxibana halv bredd (m)', 'Värde': c.TAXIWAY_HALF_WIDTH },
    { 'Inställning': 'Nära stängslet (m)', 'Värde': c.NEAR_FENCE },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, makeSheet(reportRows, { 'Sedd': 17, 'Kommentar': 40, 'Zon': 26, 'Karta': 45, 'Registrerad': 17, 'Senast ändrad': 17, 'Hanterad': 17 }), 'Rapporter');
  XLSX.utils.book_append_sheet(wb, makeSheet(actionRows.length ? actionRows : [{ 'Info': 'Inga åtgärder' }], { 'Sedd': 17, 'Tid': 17, 'Kommentar': 40 }), 'Åtgärder');
  // Vädret timme för timme (4 h före + observationstimmen)
  const wxRows = list.flatMap((r) => (r.weather?.hours ?? []).map((h, i, all) => ({
    'Rapport-ID': r.id,
    'Djurslag': r.species,
    'Timme': xlDate(h.t),
    'Timmar före obs': all.length - 1 - i,
    'Väder': WEATHER.codeInfo(h.code, h.day !== 0).text,
    'Temperatur (°C)': h.temp ?? '',
    'Nederbörd (mm)': h.precip ?? '',
    'Snö (cm)': h.snow ?? '',
    'Vind (m/s)': h.wind ?? '',
    'Byar (m/s)': h.gust ?? '',
    'Vindriktning (°)': h.dir ?? '',
    'Moln (%)': h.cloud ?? '',
    'Sikt (m)': h.vis ?? '',
    'Lufttryck (hPa)': h.pres ?? '',
    'Sol (min)': h.sun == null ? '' : Math.round(h.sun / 60),
  })));
  XLSX.utils.book_append_sheet(wb, makeSheet(wxRows.length ? wxRows : [{ 'Info': 'Inget väder sparat' }], { 'Timme': 17 }), 'Väder per timme');
  XLSX.utils.book_append_sheet(wb, makeSheet(summaryRows, { 'Uppgift': 32, 'Värde': 22 }), 'Sammanfattning');
  XLSX.utils.book_append_sheet(wb, makeSheet(speciesRows.length ? speciesRows : [{ 'Info': 'Inga rapporter' }], { 'Djurslag': 28 }), 'Per djurslag');
  XLSX.utils.book_append_sheet(wb, makeSheet(zoneRows.length ? zoneRows : [{ 'Info': 'Inga riskzoner ritade' }], { 'Namn': 24, 'Koordinater (lat, lng)': 80 }), 'Riskzoner');
  XLSX.utils.book_append_sheet(wb, makeSheet(settingsRows, { 'Inställning': 44, 'Åtgärd': 40 }), 'Riskinställningar');

  const file = `viltrapport-${localDate(now)}${onlyFiltered ? '-urval' : ''}.xlsx`;
  XLSX.writeFile(wb, file, { compression: true });
  message.className = 'message ok';
  message.textContent = `✅ ${file} är nedladdad (${reportRows.length} rapporter).`;
}

$('export-all').addEventListener('click', () => exportExcel(false));
$('export-filtered').addEventListener('click', () => exportExcel(true));

// ---------- Riskzoner på kartan ----------

function drawRiskZones() {
  if (!riskLayer) return;
  riskLayer.clearLayers();
  for (const z of riskZones) {
    const t = RISK.ZONE_TYPES[z.zone_type];
    if (!t || !Array.isArray(z.points)) continue;
    const opts = { color: t.color, interactive: false };
    if (z.zone_type === 'runway' && z.points.length >= 2) {
      const shapes = RISK.runwayShapes(z.points[0], z.points[z.points.length - 1]);
      riskLayer.addLayer(L.polygon(shapes.approachA, { ...opts, weight: 1.5, dashArray: '6 6', fillOpacity: 0.08 }));
      riskLayer.addLayer(L.polygon(shapes.approachB, { ...opts, weight: 1.5, dashArray: '6 6', fillOpacity: 0.08 }));
      riskLayer.addLayer(L.polygon(shapes.strip, { ...opts, weight: 2, fillOpacity: 0.25 }));
      riskLayer.addLayer(L.polyline(z.points, { ...opts, weight: 3 }));
    } else if (z.zone_type === 'taxiway') {
      riskLayer.addLayer(L.polyline(z.points, { ...opts, weight: 8, opacity: 0.45 }));
    } else if (z.zone_type === 'airside') {
      riskLayer.addLayer(L.polygon(z.points, { ...opts, weight: 3, fillOpacity: 0.05 }));
    }
  }
}

function renderZoneList() {
  $('draw-start').hidden = !isAdmin;
  $('riskcfg-open').textContent = isAdmin ? '⚙️ Ändra riskinställningar' : '📋 Visa riskinställningar';
  $('zone-list').innerHTML = riskZones.map((z) => {
    const t = RISK.ZONE_TYPES[z.zone_type] ?? { label: z.zone_type, color: '#999' };
    return `<li>
      <span><span class="zone-dot" style="background:${t.color}"></span><strong>${escapeHtml(z.name)}</strong>
        <small style="color:var(--muted)"> · ${t.label}</small></span>
      ${isAdmin ? `<button type="button" class="btn btn-danger" data-zone-delete="${z.id}">Ta bort</button>` : ''}
    </li>`;
  }).join('') || '<li><span class="hint">Inga zoner ritade än.</span></li>';
}

$('zone-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-zone-delete]');
  if (!b) return;
  const z = riskZones.find((x) => String(x.id) === b.dataset.zoneDelete);
  if (!confirm(`Ta bort zonen "${z?.name}"? Riskpoängen räknas om direkt.`)) return;
  const { error } = await db.from('risk_zones').delete().eq('id', b.dataset.zoneDelete);
  if (error) {
    showToast(translateError(error));
    return;
  }
  showToast('Zonen är borttagen');
  loadReports();
});

// ---------- Rita riskzon (admin) ----------

let drawing = null;   // { type, points: [[lat, lng], …] } medan admin ritar

function startDraw() {
  closeSheet();
  closeFilter();
  closeRisk();
  switchTab('map-view');
  drawing = { type: 'runway', points: [] };
  $('draw-name').value = '';
  $('draw-message').textContent = '';
  document.body.classList.add('drawing');
  $('map-hint').textContent = 'Ritläge: tryck på kartan för att sätta punkter';
  $('draw-panel').hidden = false;
  // Snabba tryck ska bli punkter, inte zooma kartan
  map.doubleClickZoom.disable();
  updateDraw();
  // Visa zonerna medan man ritar
  if (riskLayer && !map.hasLayer(riskLayer)) riskLayer.addTo(map);
}

function endDraw() {
  drawing = null;
  document.body.classList.remove('drawing');
  $('map-hint').textContent = 'Tryck på kartan där du såg djuret';
  $('draw-panel').hidden = true;
  map?.doubleClickZoom.enable();
  if (drawPreview) { drawPreview.remove(); drawPreview = null; }
}

let drawPreview = null;

function addDrawPoint(latlng) {
  const pt = [Number(latlng.lat.toFixed(6)), Number(latlng.lng.toFixed(6))];
  // En bana har bara två punkter (ändarna) – en tredje ersätter den andra
  if (drawing.type === 'runway' && drawing.points.length >= 2) drawing.points[1] = pt;
  else drawing.points.push(pt);
  updateDraw();
}

function updateDraw() {
  const t = RISK.ZONE_TYPES[drawing.type];
  document.querySelectorAll('#draw-type [data-zone-type]').forEach((b) => {
    b.classList.toggle('selected', b.dataset.zoneType === drawing.type);
  });
  const need = { runway: 2, taxiway: 2, airside: 3 }[drawing.type];
  $('draw-hint').textContent = `${t.hint} (${drawing.points.length} ${drawing.points.length === 1 ? 'punkt' : 'punkter'}, minst ${need})`;

  if (drawPreview) drawPreview.remove();
  drawPreview = L.layerGroup().addTo(map);
  const pts = drawing.points;
  const opts = { color: t.color, interactive: false };
  pts.forEach((p) => L.circleMarker(p, { ...opts, radius: 6, weight: 2, fillColor: '#fff', fillOpacity: 1 }).addTo(drawPreview));
  if (pts.length >= 2) {
    if (drawing.type === 'airside' && pts.length >= 3) L.polygon(pts, { ...opts, weight: 3, fillOpacity: 0.1, dashArray: '6 4' }).addTo(drawPreview);
    else L.polyline(pts, { ...opts, weight: 4, dashArray: '6 4' }).addTo(drawPreview);
    if (drawing.type === 'runway') {
      const shapes = RISK.runwayShapes(pts[0], pts[1]);
      [shapes.strip, shapes.approachA, shapes.approachB].forEach((poly) =>
        L.polygon(poly, { ...opts, weight: 1, dashArray: '4 4', fillOpacity: 0.08 }).addTo(drawPreview));
    }
  }
}

$('draw-start').addEventListener('click', startDraw);
$('draw-name').addEventListener('input', () => { $('draw-message').textContent = ''; });
$('draw-cancel').addEventListener('click', endDraw);
$('draw-undo').addEventListener('click', () => {
  drawing?.points.pop();
  if (drawing) updateDraw();
});
$('draw-type').addEventListener('click', (e) => {
  const b = e.target.closest('[data-zone-type]');
  if (!b || !drawing) return;
  drawing.type = b.dataset.zoneType;
  if (drawing.type === 'runway') drawing.points = drawing.points.slice(0, 2);
  updateDraw();
});
$('draw-save').addEventListener('click', async () => {
  const need = { runway: 2, taxiway: 2, airside: 3 }[drawing.type];
  const name = $('draw-name').value.trim();
  if (!name) { $('draw-message').textContent = 'Ge zonen ett namn, t.ex. "Bana 01L/19R".'; return; }
  if (drawing.points.length < need) { $('draw-message').textContent = `Sätt minst ${need} punkter.`; return; }
  const { error } = await db.from('risk_zones').insert({ name, zone_type: drawing.type, points: drawing.points });
  if (error) { $('draw-message').textContent = translateError(error); return; }
  showToast(`Zonen "${name}" är sparad`);
  endDraw();
  loadReports();
});

// ---------- Flikar ----------

function switchTab(viewId) {
  if (drawing && viewId !== 'map-view') endDraw();
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== viewId; });
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === viewId));
  if (viewId === 'stats-view') render();
  if (viewId === 'map-view') {
    map?.invalidateSize();
  } else {
    closeSheet();
  }
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => switchTab(tab.dataset.view));
});

// ---------- Knappar i popup och lista ----------

document.addEventListener('click', (e) => {
  const button = e.target.closest('[data-action]');
  if (!button) return;
  const report = reports.find((r) => String(r.id) === button.dataset.id);
  if (!report) return;

  if (button.dataset.action === 'show') showOnMap(report);
  if (button.dataset.action === 'risk') openRisk(report);
  if (button.dataset.action === 'edit') startEdit(report);
  if (button.dataset.action === 'delete') deleteReport(report);
});

function showOnMap(report) {
  switchTab('map-view');
  map.setView([report.lat, report.lng], Math.max(map.getZoom(), 16));
  markerLayer.eachLayer((m) => {
    if (m.reportId === report.id) m.openPopup();
  });
}

// ---------- Formuläret ----------

function openSheet(report = null) {
  editingId = report?.id ?? null;
  setReportType(report ? typeOf(report) : 'observation');
  $('species').value = report?.species ?? '';
  $('is-flock').checked = Boolean(report?.is_flock);
  $('animal-count').value = report ? (report.animal_count ?? '') : 1;
  selectedPosition = report?.bird_position ?? '';
  selectedHabitat = report?.habitat ?? '';
  renderChoiceChips();
  $('quick-picks-wrap').open = false;
  $('extra-species').innerHTML = '';
  $('observed-at').value = toLocalInput(report?.observed_at ?? new Date());
  $('comment').value = report?.comment ?? '';
  $('form-message').textContent = '';
  $('category').value = '';
  hideSuggestions();
  updateCategoryVisibility();
  closeSettings();
  closeFilter();
  closeRisk();
  $('sheet').hidden = false;
  $('map-hint').hidden = true;
}

function closeSheet() {
  $('sheet').hidden = true;
  $('map-hint').hidden = false;
  editingId = null;
  removeDraftMarker();
}

function startEdit(report) {
  switchTab('map-view');
  map.closePopup();
  map.setView([report.lat, report.lng], Math.max(map.getZoom(), 16));
  placeDraftMarker([report.lat, report.lng]);
  openSheet(report);
}

$('cancel-btn').addEventListener('click', closeSheet);

// + och − för antal
document.querySelectorAll('[data-step]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const input = $('animal-count');
    const value = (parseInt(input.value, 10) || 0) + Number(btn.dataset.step);
    // Flock: − från 1 tömmer fältet (= okänt antal)
    if (value < 1 && $('is-flock').checked && !$('flock-wrap').hidden) { input.value = ''; return; }
    input.value = Math.min(10000, Math.max(1, value));
  });
});

$('report-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const message = $('form-message');
  message.textContent = '';

  if (!draftMarker) {
    message.textContent = 'Tryck på kartan för att visa var djuret sågs.';
    return;
  }

  // Använd artens "riktiga" stavning om den finns i listan (t.ex. "rådjur" → "Rådjur")
  const typed = $('species').value.trim();
  const known = findKnownSpecies(typed);
  const speciesName = known ? known.name : typed.charAt(0).toUpperCase() + typed.slice(1);

  if (!known && !$('category').value) {
    hideSuggestions();
    message.textContent = 'Det här är en ny art – välj vilken sorts djur det är.';
    $('category').focus();
    return;
  }

  const bird = formIsBird();
  const flock = bird && $('is-flock').checked;
  const countRaw = $('animal-count').value.trim();
  const count = countRaw === '' ? null : parseInt(countRaw, 10);
  if (count === null ? !flock : !(count >= 1 && count <= 10000)) {
    message.textContent = flock ? 'Antalet måste vara 1–10 000, eller tomt.' : 'Fyll i antal (1–10 000).';
    $('animal-count').focus();
    return;
  }

  const extras = collectExtras();
  if (extras.error) {
    message.textContent = extras.error;
    extras.focus?.focus();
    return;
  }

  const position = draftMarker.getLatLng();
  const payload = {
    report_type: selectedType,
    species: speciesName,
    animal_count: count,
    is_flock: flock,
    bird_position: bird ? selectedPosition || null : null,
    habitat: selectedHabitat || null,
    observed_at: new Date($('observed-at').value).toISOString(),
    comment: $('comment').value.trim() || null,
    lat: position.lat,
    lng: position.lng,
  };

  const saveBtn = $('save-btn');
  saveBtn.disabled = true;

  // Väder: hämtas för nya rapporter, och när tid eller plats ändrats
  const old = editingId ? reports.find((r) => r.id === editingId) : null;
  const moved = !old
    || new Date(old.observed_at).getTime() !== new Date(payload.observed_at).getTime()
    || Math.abs(old.lat - payload.lat) > 0.0005 || Math.abs(old.lng - payload.lng) > 0.0005;
  if (moved || !old.weather) {
    saveBtn.textContent = 'Hämtar väder…';
    payload.weather = await fetchWeatherSafe(payload.lat, payload.lng, payload.observed_at);
  }
  saveBtn.textContent = 'Sparar…';

  // Nya arter: spara dem i listan så att alla får dem som förslag
  if (!known) await saveCustomSpecies(speciesName, $('category').value);
  for (const x of extras.list) if (x.newCategory) await saveCustomSpecies(x.species, x.newCategory);

  // Fler arter: egna rapporter med samma plats, tid, biotop, väder och kommentar
  let extraRows = [];
  if (extras.list.length) {
    payload.sighting_id = old?.sighting_id ?? newSightingId();
    const shared = {
      report_type: payload.report_type, observed_at: payload.observed_at, comment: payload.comment,
      lat: payload.lat, lng: payload.lng, habitat: payload.habitat,
      weather: 'weather' in payload ? payload.weather : old?.weather ?? null,
      sighting_id: payload.sighting_id,
    };
    extraRows = extras.list.map(({ newCategory, ...x }) => ({ ...shared, ...x }));
  }

  let error;
  if (editingId) {
    ({ error } = await db.from('reports').update(payload).eq('id', editingId));
    if (!error && extraRows.length) ({ error } = await db.from('reports').insert(extraRows));
  } else {
    ({ error } = await db.from('reports').insert(extraRows.length ? [payload, ...extraRows] : payload));
  }

  saveBtn.disabled = false;
  saveBtn.textContent = 'Spara';

  if (error) {
    message.textContent = translateError(error);
    return;
  }
  const total = extraRows.length + 1;
  showToast(extraRows.length ? `${editingId ? 'Uppdaterad och sparad' : 'Sparad'}: ${total} arter på samma plats`
    : editingId ? 'Rapporten är uppdaterad'
      : selectedType === 'observation' ? 'Rapporten är sparad' : `${REPORT_TYPES[selectedType].label} sparad`);
  closeSheet();
  loadReports();
});

async function deleteReport(report) {
  if (!confirm(`Vill du ta bort rapporten "${report.species}"?`)) return;
  map?.closePopup();

  const { error } = await db.from('reports').delete().eq('id', report.id);
  if (error) {
    showToast(translateError(error));
    return;
  }
  showToast('Rapporten är borttagen');
  loadReports();
}

// ---------- Förslag på djurslag ----------

let activeSuggestion = -1;

function findSpecies(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const names = [...speciesIndex().values()].map((s) => s.name);
  const starts = names.filter((s) => s.toLowerCase().startsWith(q));
  const contains = names.filter((s) => !s.toLowerCase().startsWith(q) && s.toLowerCase().includes(q));
  return [...starts, ...contains].slice(0, 8);
}

function hideSuggestions() {
  $('species-suggestions').hidden = true;
  activeSuggestion = -1;
  updateCategoryVisibility();
}

function showSuggestions() {
  const matches = findSpecies($('species').value);
  const box = $('species-suggestions');
  // Visa inte förslag om man redan skrivit exakt en art
  if (!matches.length || (matches.length === 1 && matches[0].toLowerCase() === $('species').value.trim().toLowerCase())) {
    hideSuggestions();
    return;
  }
  activeSuggestion = -1;
  box.innerHTML = matches.map((s) => `<li role="option" data-name="${escapeHtml(s)}">${iconFor(s)} ${escapeHtml(s)}</li>`).join('');
  box.hidden = false;
  updateCategoryVisibility();
}

function chooseSuggestion(text) {
  $('species').value = text;
  hideSuggestions();
  updateCategoryVisibility();
}

$('species').addEventListener('input', showSuggestions);
$('species').addEventListener('blur', () => setTimeout(hideSuggestions, 150));

$('species-suggestions').addEventListener('mousedown', (e) => e.preventDefault());
$('species-suggestions').addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (li) chooseSuggestion(li.dataset.name);
});

$('species').addEventListener('keydown', (e) => {
  const box = $('species-suggestions');
  if (box.hidden) return;
  const items = [...box.children];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    activeSuggestion = (activeSuggestion + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items.forEach((li, i) => li.classList.toggle('active', i === activeSuggestion));
  } else if (e.key === 'Enter' && activeSuggestion >= 0) {
    e.preventDefault();
    chooseSuggestion(items[activeSuggestion].dataset.name);
  } else if (e.key === 'Escape') {
    hideSuggestions();
  }
});

// ---------- Uppkoppling och uppdatering ----------

function updateOnlineStatus() {
  $('offline-banner').hidden = navigator.onLine;
}
window.addEventListener('online', () => { updateOnlineStatus(); if (currentUser) loadReports(); });
window.addEventListener('offline', updateOnlineStatus);
updateOnlineStatus();

// Hämta nya rapporter när man kommer tillbaka till appen
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentUser && !needsNewPassword) loadReports();
});

// ---------- Service worker (gör appen installerbar) ----------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Service worker:', err));
  });
}

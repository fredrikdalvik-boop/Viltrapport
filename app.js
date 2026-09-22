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
  closeFilter();
  $('user-email').textContent = (currentUser?.email ?? '') + (isAdmin ? ' (admin)' : '');
  $('settings-message').textContent = '';
  renderColorPicker();
  $('admin-section').hidden = !isAdmin;
  if (isAdmin) renderAdmin();
  $('settings-sheet').hidden = false;
}

// ---------- Admin ----------

async function renderAdmin() {
  // Inbjudningskoden
  const { data, error } = await db.from('app_settings').select('value').eq('key', 'signup_code').maybeSingle();
  $('admin-code').value = error ? '' : (data?.value ?? '');

  // Användare
  const members = profiles.filter((p) => p.is_member)
    .sort((a, b) => (a.email ?? '').localeCompare(b.email ?? '', 'sv'));
  $('admin-users').innerHTML = members.map((p) => `
    <li>
      <span><span style="color:${colorFor(p.user_id)}">●</span> ${escapeHtml(p.email ?? 'okänd')}
        ${p.is_admin ? '<strong>👑 admin</strong>' : ''}</span>
      ${p.user_id === currentUser.id ? '' : `
        <button type="button" class="btn ${p.is_admin ? 'btn-danger' : 'btn-secondary'}"
                data-admin-toggle="${p.user_id}" data-make="${!p.is_admin}">
          ${p.is_admin ? 'Ta bort admin' : 'Gör till admin'}
        </button>`}
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
  const button = e.target.closest('[data-admin-toggle]');
  if (!button) return;
  const makeAdmin = button.dataset.make === 'true';
  const person = profiles.find((p) => p.user_id === button.dataset.adminToggle);
  const question = makeAdmin
    ? `Göra ${person?.email} till admin? Admin kan ändra och ta bort allas rapporter.`
    : `Ta bort admin för ${person?.email}?`;
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
  const full = `${n.line1} ${n.line2}${n.line3}`;
  document.title = full;
  document.querySelectorAll('[data-app-name]').forEach((el) => {
    el.textContent = el.dataset.appName === 'full' ? full : n[el.dataset.appName];
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
  $('signup-email').focus();
});

$('signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  clearErrors();
  const okEmail = validateEmail($('signup-email'));
  const okPw = validatePassword($('signup-password'), 8);
  const okCode = Boolean($('signup-code').value.trim());
  if (!okCode) setFieldError($('signup-code'), 'Fyll i inbjudningskoden.');
  if (!okEmail || !okPw || !okCode) return;

  setLoading(form, true, 'Skapar konto…');
  const { data, error } = await db.auth.signUp({
    email: $('signup-email').value.trim(),
    password: $('signup-password').value,
    options: { data: { signup_code: $('signup-code').value.trim() } },
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

  markerLayer = L.layerGroup().addTo(map);

  // Tryck på kartan = placera (eller flytta) nålen
  map.on('click', (e) => {
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
        html: `<div class="pin" style="background:${colorFor(r.user_id)}">${iconFor(r.species)}</div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
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
      <strong>${iconFor(r.species)} ${escapeHtml(r.species)} (${r.animal_count} st)</strong>
      <span>🕒 ${formatDateTime(r.observed_at)}</span>
      <span><span style="color:${colorFor(r.user_id)}">●</span> ${escapeHtml(r.reporter_email.split('@')[0])}</span>
      ${r.comment ? `<span class="tip-comment">💬 ${escapeHtml(r.comment.length > 60 ? r.comment.slice(0, 60) + '…' : r.comment)}</span>` : ''}
      <span class="tip-hint">Klicka för mer</span>
    </div>`;
}

function popupHtml(r) {
  const own = canEdit(r);
  return `
    <div class="popup">
      ${typeBadge(r)}
      <h3>${iconFor(r.species)} ${escapeHtml(r.species)} (${r.animal_count} st)</h3>
      <p>🕒 ${formatDateTime(r.observed_at)}</p>
      <p><span style="color:${colorFor(r.user_id)}">●</span> ${escapeHtml(r.reporter_email)}</p>
      ${r.comment ? `<p>💬 ${escapeHtml(r.comment)}</p>` : ''}
      ${own ? `
        <div class="actions">
          <button class="btn btn-secondary" data-action="edit" data-id="${r.id}">Redigera</button>
          <button class="btn btn-danger" data-action="delete" data-id="${r.id}">Ta bort</button>
        </div>` : ''}
    </div>`;
}

// ---------- Hämta rapporter ----------

async function loadReports() {
  const [reportsResult, profilesResult, speciesResult] = await Promise.all([
    db.from('reports').select('*').order('observed_at', { ascending: false }).limit(5000),
    db.from('profiles').select('user_id, color, email, is_admin, is_member'),
    db.from('custom_species').select('id, name, category').order('name'),
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

  reports = reportsResult.data;
  updateFilterOptions();
  render();
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
  sort: 'date-desc',
};
let filter = loadFilter();

function loadFilter() {
  try {
    return { ...EMPTY_FILTER, ...JSON.parse(localStorage.getItem(FILTER_KEY) || '{}') };
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
    'reporter': (a, b) => a.reporter_email.localeCompare(b.reporter_email, 'sv') || byDate(a, b),
  };
  return reports.filter(matchesFilter).sort(sorters[filter.sort] ?? byDate);
}

// Vem som har rapporterat (för listan "Rapportör")
function reporterOptions() {
  const people = new Map();
  for (const r of reports) people.set(r.user_id, r.reporter_email);
  return [...people].filter(([id]) => id !== currentUser?.id)
    .sort((a, b) => a[1].localeCompare(b[1], 'sv'));
}

function reporterLabel(id) {
  if (id === 'me') return 'Bara mina';
  return reports.find((r) => r.user_id === id)?.reporter_email
    ?? profiles.find((p) => p.user_id === id)?.email ?? 'okänd';
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
    chips.push(['reporter', `${dot}👤 ${escapeHtml(reporterLabel(filter.reporter).split('@')[0])}`, true]);
  }
  if (dateLabel()) chips.push(['date', `📅 ${dateLabel()}`]);

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
  document.querySelectorAll('#filter-quick [data-quick]').forEach((b) => {
    b.classList.toggle('selected', b.dataset.quick === filter.quick && (filter.quick || (!filter.from && !filter.to)));
  });
}

function openFilter() {
  closeSheet();
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
        <h3><span class="card-icon" style="background:${colorFor(r.user_id)}">${iconFor(r.species)}</span>
            ${escapeHtml(r.species)} (${r.animal_count} st)</h3>
        <p>🕒 ${formatDateTime(r.observed_at)}</p>
        <p>👤 ${escapeHtml(r.reporter_email)}${own ? ' (du)' : ''}</p>
        ${r.comment ? `<p class="comment">💬 ${escapeHtml(r.comment)}</p>` : ''}
        <div class="actions">
          <button class="btn btn-secondary" data-action="show" data-id="${r.id}">Visa på kartan</button>
          ${canEdit(r) ? `
            <button class="btn btn-secondary" data-action="edit" data-id="${r.id}">Redigera</button>
            <button class="btn btn-danger" data-action="delete" data-id="${r.id}">Ta bort</button>` : ''}
        </div>
      </li>`;
  }).join('') || `<li class="hint">${reports.length ? 'Inga rapporter matchar filtret.' : 'Inga rapporter än.'}</li>`;
}

// ---------- Flikar ----------

function switchTab(viewId) {
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== viewId; });
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === viewId));
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
  $('animal-count').value = report?.animal_count ?? 1;
  $('observed-at').value = toLocalInput(report?.observed_at ?? new Date());
  $('comment').value = report?.comment ?? '';
  $('form-message').textContent = '';
  $('category').value = '';
  hideSuggestions();
  updateCategoryVisibility();
  closeSettings();
  closeFilter();
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

  const position = draftMarker.getLatLng();
  const payload = {
    report_type: selectedType,
    species: speciesName,
    animal_count: parseInt($('animal-count').value, 10),
    observed_at: new Date($('observed-at').value).toISOString(),
    comment: $('comment').value.trim() || null,
    lat: position.lat,
    lng: position.lng,
  };

  const saveBtn = $('save-btn');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Sparar…';

  // Ny art: spara den i listan så att alla får den som förslag
  if (!known) {
    const category = $('category').value || 'ovrigt';
    const { error: speciesError } = await db.from('custom_species').insert({ name: speciesName, category });
    // 23505 = arten finns redan (någon annan hann före) – det gör inget
    if (speciesError && speciesError.code !== '23505') console.warn('Kunde inte spara ny art:', speciesError.message);
    if (!speciesError) customSpecies.push({ name: speciesName, category });
  }

  const query = editingId
    ? db.from('reports').update(payload).eq('id', editingId)
    : db.from('reports').insert(payload);
  const { error } = await query;

  saveBtn.disabled = false;
  saveBtn.textContent = 'Spara';

  if (error) {
    message.textContent = translateError(error);
    return;
  }
  showToast(editingId ? 'Rapporten är uppdaterad'
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

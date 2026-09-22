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

function iconFor(speciesName) {
  const known = findKnownSpecies(speciesName);
  const group = window.SPECIES_GROUPS[known?.group] ?? window.SPECIES_GROUPS.ovrigt;
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

  streets.addTo(map);
  L.control.layers({ 'Karta': streets, 'Satellit': satellite }, null, { collapsed: true }).addTo(map);

  markerLayer = L.layerGroup().addTo(map);

  // Tryck på kartan = placera (eller flytta) nålen
  map.on('click', (e) => {
    placeDraftMarker(e.latlng);
    if ($('sheet').hidden) openSheet();
  });
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
    const marker = L.marker([r.lat, r.lng], {
      icon: L.divIcon({
        className: 'pin-wrap',
        html: `<div class="pin" style="background:${colorFor(r.user_id)}">${iconFor(r.species)}</div>`,
        iconSize: [38, 38],
        iconAnchor: [19, 19],
        popupAnchor: [0, -18],
      }),
    });
    marker.bindPopup(() => popupHtml(r));
    marker.reportId = r.id;
    markerLayer.addLayer(marker);
  }
}

function popupHtml(r) {
  const own = canEdit(r);
  return `
    <div class="popup">
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

// ---------- Filter och lista ----------

function fillSelect(select, values) {
  const current = select.value;
  select.innerHTML = '<option value="">Alla</option>' +
    values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
  select.value = values.includes(current) ? current : '';
}

function updateFilterOptions() {
  const sortSv = (a, b) => a.localeCompare(b, 'sv');
  fillSelect($('filter-species'), [...new Set(reports.map((r) => r.species))].sort(sortSv));
  fillSelect($('filter-reporter'), [...new Set(reports.map((r) => r.reporter_email))].sort(sortSv));
}

function getFilteredReports() {
  const species = $('filter-species').value;
  const reporter = $('filter-reporter').value;
  const from = $('filter-from').value;
  const to = $('filter-to').value;
  const sort = $('sort').value;

  const list = reports.filter((r) => {
    if (species && r.species !== species) return false;
    if (reporter && r.reporter_email !== reporter) return false;
    const day = localDate(r.observed_at);
    if (from && day < from) return false;
    if (to && day > to) return false;
    return true;
  });

  const byDate = (a, b) => new Date(b.observed_at) - new Date(a.observed_at);
  const sorters = {
    'date-desc': byDate,
    'date-asc': (a, b) => -byDate(a, b),
    'species': (a, b) => a.species.localeCompare(b.species, 'sv') || byDate(a, b),
    'reporter': (a, b) => a.reporter_email.localeCompare(b.reporter_email, 'sv') || byDate(a, b),
  };
  return list.sort(sorters[sort]);
}

function isFilterActive() {
  return ['filter-species', 'filter-reporter', 'filter-from', 'filter-to'].some((id) => $(id).value);
}

function render() {
  const list = getFilteredReports();
  renderMarkers(list);
  renderList(list);

  const chip = $('filter-chip');
  chip.hidden = !isFilterActive();
  chip.textContent = `Filter på: visar ${list.length} av ${reports.length} – ändra`;
}

function renderList(list) {
  $('list-count').textContent = isFilterActive()
    ? `Visar ${list.length} av ${reports.length} rapporter`
    : `${reports.length} rapporter`;

  $('report-list').innerHTML = list.map((r) => {
    const own = r.user_id === currentUser?.id;
    return `
      <li class="report-card ${own ? 'own' : ''}" style="border-left-color:${colorFor(r.user_id)}">
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
  }).join('') || '<li class="hint">Inga rapporter att visa.</li>';
}

$('filter-form').addEventListener('input', render);
$('filter-form').addEventListener('change', render);
$('filter-form').addEventListener('reset', () => setTimeout(render, 0));
$('filter-chip').addEventListener('click', () => switchTab('list-view'));

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
  $('sheet-title').textContent = report ? 'Redigera rapport' : 'Ny rapport';
  $('species').value = report?.species ?? '';
  $('animal-count').value = report?.animal_count ?? 1;
  $('observed-at').value = toLocalInput(report?.observed_at ?? new Date());
  $('comment').value = report?.comment ?? '';
  $('form-message').textContent = '';
  $('category').value = '';
  hideSuggestions();
  updateCategoryVisibility();
  closeSettings();
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
  showToast(editingId ? 'Rapporten är uppdaterad' : 'Rapporten är sparad');
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

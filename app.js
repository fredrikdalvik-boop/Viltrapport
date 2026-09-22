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
  return 'Något gick fel: ' + msg;
}

// ---------- Inloggning ----------

function showView(name) {
  $('login-view').hidden = name !== 'login';
  $('password-view').hidden = name !== 'password';
  $('app-view').hidden = name !== 'app';
}

db.auth.onAuthStateChange((event, session) => {
  if (event === 'PASSWORD_RECOVERY') needsNewPassword = true;
  // Vänta ett ögonblick så att Supabase hinner klart innan vi gör nya anrop
  setTimeout(() => handleSession(session), 0);
});

function handleSession(session) {
  currentUser = session?.user ?? null;

  if (!currentUser) {
    reports = [];
    showView('login');
    return;
  }
  if (needsNewPassword) {
    showView('password');
    return;
  }

  showView('app');
  $('user-email').textContent = currentUser.email;
  initMap();
  loadReports();
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = e.submitter;
  const message = $('login-message');
  message.className = 'message';
  message.textContent = '';
  button.disabled = true;

  const { error } = await db.auth.signInWithPassword({
    email: $('login-email').value.trim(),
    password: $('login-password').value,
  });

  button.disabled = false;
  if (error) message.textContent = translateError(error);
});

$('forgot-btn').addEventListener('click', async () => {
  const email = $('login-email').value.trim();
  const message = $('login-message');
  message.className = 'message';
  if (!email) {
    message.textContent = 'Skriv din e-post först, tryck sedan på "Glömt lösenordet?".';
    return;
  }
  const { error } = await db.auth.resetPasswordForEmail(email, {
    redirectTo: location.origin + location.pathname,
  });
  if (error) {
    message.textContent = translateError(error);
  } else {
    message.className = 'message ok';
    message.textContent = 'Om adressen finns har ett mejl skickats med en länk.';
  }
});

$('password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = e.submitter;
  const message = $('password-message');
  button.disabled = true;

  const { data, error } = await db.auth.updateUser({ password: $('new-password').value });

  button.disabled = false;
  if (error) {
    message.textContent = translateError(error);
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
    const own = r.user_id === currentUser?.id;
    const marker = L.circleMarker([r.lat, r.lng], {
      radius: 10,
      weight: 3,
      color: '#fff',
      fillColor: own ? '#e8660c' : '#1f6fd1',
      fillOpacity: 0.95,
    });
    marker.bindPopup(() => popupHtml(r));
    marker.reportId = r.id;
    markerLayer.addLayer(marker);
  }
}

function popupHtml(r) {
  const own = r.user_id === currentUser?.id;
  return `
    <div class="popup">
      <h3>${escapeHtml(r.species)} (${r.animal_count} st)</h3>
      <p>🕒 ${formatDateTime(r.observed_at)}</p>
      <p>👤 ${escapeHtml(r.reporter_email)}</p>
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
  const { data, error } = await db
    .from('reports')
    .select('*')
    .order('observed_at', { ascending: false })
    .limit(5000);

  if (error) {
    showToast(translateError(error));
    return;
  }
  reports = data;
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
      <li class="report-card ${own ? 'own' : ''}">
        <h3>${escapeHtml(r.species)} (${r.animal_count} st)</h3>
        <p>🕒 ${formatDateTime(r.observed_at)}</p>
        <p>👤 ${escapeHtml(r.reporter_email)}${own ? ' (du)' : ''}</p>
        ${r.comment ? `<p class="comment">💬 ${escapeHtml(r.comment)}</p>` : ''}
        <div class="actions">
          <button class="btn btn-secondary" data-action="show" data-id="${r.id}">Visa på kartan</button>
          ${own ? `
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
  hideSuggestions();
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

  const position = draftMarker.getLatLng();
  const payload = {
    species: $('species').value.trim(),
    animal_count: parseInt($('animal-count').value, 10),
    observed_at: new Date($('observed-at').value).toISOString(),
    comment: $('comment').value.trim() || null,
    lat: position.lat,
    lng: position.lng,
  };

  const saveBtn = $('save-btn');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Sparar…';

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
  const starts = window.SPECIES.filter((s) => s.toLowerCase().startsWith(q));
  const contains = window.SPECIES.filter((s) => !s.toLowerCase().startsWith(q) && s.toLowerCase().includes(q));
  return [...starts, ...contains].slice(0, 8);
}

function hideSuggestions() {
  $('species-suggestions').hidden = true;
  activeSuggestion = -1;
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
  box.innerHTML = matches.map((s) => `<li role="option">${escapeHtml(s)}</li>`).join('');
  box.hidden = false;
}

function chooseSuggestion(text) {
  $('species').value = text;
  hideSuggestions();
}

$('species').addEventListener('input', showSuggestions);
$('species').addEventListener('blur', () => setTimeout(hideSuggestions, 150));

$('species-suggestions').addEventListener('mousedown', (e) => e.preventDefault());
$('species-suggestions').addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (li) chooseSuggestion(li.textContent);
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
    chooseSuggestion(items[activeSuggestion].textContent);
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

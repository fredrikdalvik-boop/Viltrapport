// =============================================================
// Väder, ljus och tid på dygnet för en observation
// =============================================================
// Vädret hämtas från Open-Meteo (https://open-meteo.com, CC BY 4.0) när en rapport sparas
// och lagras i rapporten (kolumnen weather). Ljus (natt/gryning/dag/skymning) och tid på
// dygnet räknas ut direkt från tid och plats – det behöver inget väder.
// Gränsvärdena nedan går att justera.

window.WEATHER = {
  HOURS_BEFORE: 4,          // hur många timmar före observationen som hämtas

  // Gränser för vädermarkörerna
  LIMITS: {
    RAIN_NOW: 0.2,          // mm den timmen = regnar
    RAIN_BEFORE: 0.3,       // mm totalt under timmarna före = har regnat
    SUNNY_CLOUD: 30,        // % moln eller mindre (dagtid) = soligt
    SUNNY_MINUTES: 30,      // …eller minst så många minuter sol den timmen
    CLOUDY: 80,             // % moln eller mer = mulet
    FOG_VISIBILITY: 1000,   // m sikt eller mindre = dimma
    WINDY: 8,               // m/s medelvind = blåsigt
    WINDY_GUST: 14,         // m/s byar = blåsigt
    STORMY: 13,             // m/s medelvind = mycket blåsigt
    STORMY_GUST: 20,        // m/s byar = mycket blåsigt
    CALM: 2,                // m/s eller mindre = lugnt
    WARM: 20,               // °C eller mer = varmt
    PRESSURE_DROP: 3,       // hPa lägre än 4 h före = fallande lufttryck
    WEATHER_SHIFT_TEMP: 4,  // °C förändring på 4 h = väderomslag
  },

  // Vädermarkörer (en observation kan ha flera). Ordningen styr visningen.
  TAGS: {
    regn_nu:        { label: 'Regnar',               icon: '🌧️' },
    regnat:         { label: 'Har regnat (4 h)',     icon: '💧' },
    sno:            { label: 'Snö',                  icon: '🌨️' },
    soligt:         { label: 'Soligt',               icon: '☀️' },
    mulet:          { label: 'Mulet',                icon: '☁️' },
    dimma:          { label: 'Dimma/dålig sikt',     icon: '🌫️' },
    lugnt:          { label: 'Lugnt',                icon: '🍃' },
    blasigt:        { label: 'Blåsigt',              icon: '💨' },
    mycket_blasigt: { label: 'Mycket blåsigt',       icon: '🌪️' },
    minusgrader:    { label: 'Minusgrader',          icon: '🥶' },
    varmt:          { label: 'Varmt (20°+)',         icon: '🥵' },
    aska:           { label: 'Åska',                 icon: '⛈️' },
    tryckfall:      { label: 'Fallande lufttryck',   icon: '📉' },
    omslag:         { label: 'Väderomslag (4 h)',    icon: '🔄' },
  },

  // Ljus utifrån solens höjd
  LIGHT: {
    natt:     { label: 'Natt',     icon: '🌙' },
    gryning:  { label: 'Gryning',  icon: '🌅' },
    dag:      { label: 'Dag',      icon: '🌞' },
    skymning: { label: 'Skymning', icon: '🌇' },
  },

  // Tid på dygnet (svensk tid). from = timme då perioden börjar.
  TIME_OF_DAY: [
    { key: 'natt',        label: 'Natt',        from: 22, to: 5,  icon: '🌌' },
    { key: 'morgon',      label: 'Morgon',      from: 5,  to: 9,  icon: '🌄' },
    { key: 'formiddag',   label: 'Förmiddag',   from: 9,  to: 12, icon: '🕘' },
    { key: 'eftermiddag', label: 'Eftermiddag', from: 12, to: 17, icon: '🕒' },
    { key: 'kvall',       label: 'Kväll',       from: 17, to: 22, icon: '🌆' },
  ],

  // Väderlek (en huvudkategori per observation, från vädrets kod)
  CONDITIONS: {
    klart:    { label: 'Klart',     icon: '☀️' },
    halvklart:{ label: 'Halvklart', icon: '⛅' },
    mulet:    { label: 'Mulet',     icon: '☁️' },
    dimma:    { label: 'Dimma',     icon: '🌫️' },
    duggregn: { label: 'Duggregn',  icon: '🌦️' },
    regn:     { label: 'Regn',      icon: '🌧️' },
    sno:      { label: 'Snö',       icon: '🌨️' },
    aska:     { label: 'Åska',      icon: '⛈️' },
  },

  TEMP_BANDS: [
    { max: -10, label: 'Under −10°' }, { max: 0, label: '−10 till 0°' }, { max: 10, label: '0 till 10°' },
    { max: 20, label: '10 till 20°' }, { max: Infinity, label: 'Över 20°' },
  ],
  WIND_BANDS: [
    { max: 2, label: 'Lugnt (0–2 m/s)' }, { max: 5, label: 'Svag (2–5)' }, { max: 8, label: 'Måttlig (5–8)' },
    { max: 13, label: 'Blåsigt (8–13)' }, { max: Infinity, label: 'Hård (13+)' },
  ],
};

(function () {
  const W = window.WEATHER;
  const TZ = 'Europe/Stockholm';

  // ---------- Väderkod (WMO) → text ----------
  W.codeInfo = function (code, isDay = true) {
    const c = Number(code);
    const t = (text, icon, cond) => ({ text, icon, cond });
    if (c === 0) return t(isDay ? 'Klart' : 'Klart', isDay ? '☀️' : '🌙', 'klart');
    if (c === 1) return t('Mestadels klart', isDay ? '🌤️' : '🌙', 'klart');
    if (c === 2) return t('Halvklart', '⛅', 'halvklart');
    if (c === 3) return t('Mulet', '☁️', 'mulet');
    if (c === 45 || c === 48) return t('Dimma', '🌫️', 'dimma');
    if (c >= 51 && c <= 57) return t(c >= 56 ? 'Underkylt duggregn' : 'Duggregn', '🌦️', 'duggregn');
    if (c === 61) return t('Lätt regn', '🌧️', 'regn');
    if (c === 63) return t('Regn', '🌧️', 'regn');
    if (c === 65) return t('Kraftigt regn', '🌧️', 'regn');
    if (c === 66 || c === 67) return t('Underkylt regn', '🌧️', 'regn');
    if (c >= 71 && c <= 77) return t(c === 75 ? 'Kraftigt snöfall' : 'Snöfall', '🌨️', 'sno');
    if (c >= 80 && c <= 82) return t(c === 82 ? 'Kraftiga regnskurar' : 'Regnskurar', '🌦️', 'regn');
    if (c === 85 || c === 86) return t('Snöbyar', '🌨️', 'sno');
    if (c >= 95) return t(c >= 96 ? 'Åska med hagel' : 'Åska', '⛈️', 'aska');
    return t('Okänt', '❔', null);
  };

  W.windDir = function (deg) {
    if (deg == null) return '';
    return ['N', 'NO', 'O', 'SO', 'S', 'SV', 'V', 'NV'][Math.round(((deg % 360) + 360) % 360 / 45) % 8];
  };

  // ---------- Solens höjd (grader) – förenklad astronomisk formel ----------
  W.sunAltitude = function (date, lat, lng) {
    const rad = Math.PI / 180;
    const d = new Date(date).getTime() / 86400000 - 10957.5;  // dagar sedan 2000-01-01 12:00 UTC
    const g = (357.529 + 0.98560028 * d) * rad;
    const q = 280.459 + 0.98564736 * d;
    const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
    const e = (23.439 - 0.00000036 * d) * rad;
    const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
    const dec = Math.asin(Math.sin(e) * Math.sin(L));
    const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
    const ha = (gmst * 15 + lng) * rad - ra;
    return Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(ha)) / rad;
  };

  // Natt (solen mer än 6° under horisonten), gryning/skymning (0 till −6°), dag
  W.lightPhase = function (date, lat, lng) {
    const alt = W.sunAltitude(date, lat, lng);
    if (alt >= -0.833) return { key: 'dag', altitude: alt };  // soluppgång/nedgång räknas vid −0,83°
    if (alt < -6) return { key: 'natt', altitude: alt };
    const rising = W.sunAltitude(new Date(new Date(date).getTime() + 10 * 60000), lat, lng) > alt;
    return { key: rising ? 'gryning' : 'skymning', altitude: alt };
  };

  const hourFmt = new Intl.DateTimeFormat('sv-SE', { hour: 'numeric', hourCycle: 'h23', timeZone: TZ });
  W.localHour = (date) => Number(hourFmt.format(new Date(date)));

  W.timeOfDay = function (date) {
    const h = W.localHour(date);
    return W.TIME_OF_DAY.find((p) => (p.from < p.to ? h >= p.from && h < p.to : h >= p.from || h < p.to));
  };

  // ---------- Hämta väder från Open-Meteo ----------
  const VARS = ['temperature_2m', 'relative_humidity_2m', 'precipitation', 'rain', 'snowfall', 'weather_code',
    'cloud_cover', 'visibility', 'wind_speed_10m', 'wind_gusts_10m', 'wind_direction_10m', 'pressure_msl',
    'sunshine_duration', 'is_day'];
  const cache = new Map();
  const isoDate = (d) => d.toISOString().slice(0, 10);

  function fetchHourly(lat, lng, startDate, endDate, archive) {
    const vars = archive ? VARS.filter((v) => v !== 'visibility') : VARS;  // arkivet saknar sikt
    const base = archive ? 'https://archive-api.open-meteo.com/v1/archive' : 'https://api.open-meteo.com/v1/forecast';
    const url = `${base}?latitude=${lat}&longitude=${lng}&hourly=${vars.join(',')}`
      + `&start_date=${startDate}&end_date=${endDate}&timezone=GMT&wind_speed_unit=ms`;
    if (!cache.has(url)) {
      cache.set(url, fetch(url).then((res) => {
        if (!res.ok) throw new Error(`Väder: HTTP ${res.status}`);
        return res.json();
      }).catch((err) => { cache.delete(url); throw err; }));
    }
    return cache.get(url);
  }

  // Ger en väderpost för observationen, eller null om det inte gick
  W.fetchFor = async function (lat, lng, observedAt) {
    const t = new Date(observedAt);
    if (Number.isNaN(t.getTime())) return null;
    // Närmaste hela timme (UTC)
    const hour = new Date(Math.round(t.getTime() / 3600000) * 3600000);
    const first = new Date(hour.getTime() - W.HOURS_BEFORE * 3600000);
    const ageDays = (Date.now() - hour.getTime()) / 86400000;
    const glat = Math.round(lat * 100) / 100;
    const glng = Math.round(lng * 100) / 100;
    // Senaste ~3 månaderna finns i prognos-API:t, äldre i arkivet
    const archive = ageDays > 80;
    const data = await fetchHourly(glat, glng, isoDate(first), isoDate(hour), archive);
    const h = data.hourly;
    if (!h || !Array.isArray(h.time)) return null;

    const hours = [];
    for (let i = 0; i <= W.HOURS_BEFORE; i++) {
      const at = new Date(first.getTime() + i * 3600000);
      const key = at.toISOString().slice(0, 13) + ':00';
      const idx = h.time.indexOf(key);
      if (idx < 0) return null;
      const v = (name) => (h[name] ? h[name][idx] : null);
      hours.push({
        t: at.toISOString(),
        temp: v('temperature_2m'), hum: v('relative_humidity_2m'),
        precip: v('precipitation'), rain: v('rain'), snow: v('snowfall'),
        code: v('weather_code'), cloud: v('cloud_cover'), vis: v('visibility'),
        wind: v('wind_speed_10m'), gust: v('wind_gusts_10m'), dir: v('wind_direction_10m'),
        pres: v('pressure_msl'), sun: v('sunshine_duration'), day: v('is_day'),
      });
    }
    if (hours[hours.length - 1].temp == null) return null;
    return { v: 1, src: archive ? 'open-meteo-archive' : 'open-meteo', lat: glat, lng: glng, fetched: new Date().toISOString(), hours };
  };

  // ---------- Tolka en sparad väderpost ----------
  const sum = (arr) => arr.reduce((a, b) => a + (Number(b) || 0), 0);
  const max = (arr) => arr.reduce((a, b) => Math.max(a, Number(b) || 0), 0);

  // Sammanfattning + vädermarkörer. null om vädret saknas.
  W.analyze = function (weather) {
    if (!weather || !Array.isArray(weather.hours) || !weather.hours.length) return null;
    const L = W.LIMITS;
    const hrs = weather.hours;
    const now = hrs[hrs.length - 1];
    const before = hrs.slice(1, -1);            // timmarna mellan första och observationstimmen
    const period = hrs.slice(1);                // nederbörd för hela perioden (varje värde = timmen innan)
    const info = W.codeInfo(now.code, now.day !== 0);
    const out = {
      now, info, condition: info.cond,
      precipNow: Number(now.precip) || 0,
      precipBefore: sum(before.map((x) => x.precip)),
      precipPeriod: sum(period.map((x) => x.precip)),
      snowPeriod: sum(period.map((x) => x.snow)),
      maxGust: max(hrs.map((x) => x.gust)),
      maxWind: max(hrs.map((x) => x.wind)),
      sunMinutes: Math.round(sum(period.map((x) => x.sun)) / 60),
      pressureChange: now.pres != null && hrs[0].pres != null ? now.pres - hrs[0].pres : null,
      tempChange: now.temp != null && hrs[0].temp != null ? now.temp - hrs[0].temp : null,
    };
    const tags = [];
    const snowing = out.snowPeriod > 0 || info.cond === 'sno';
    if (out.precipNow >= L.RAIN_NOW && !snowing) tags.push('regn_nu');
    if (out.precipBefore >= L.RAIN_BEFORE && !snowing) tags.push('regnat');
    if (snowing) tags.push('sno');
    if (now.day !== 0 && ((now.cloud ?? 100) <= L.SUNNY_CLOUD || (now.sun ?? 0) >= L.SUNNY_MINUTES * 60)) tags.push('soligt');
    if ((now.cloud ?? 0) >= L.CLOUDY) tags.push('mulet');
    if ((now.vis != null && now.vis <= L.FOG_VISIBILITY) || info.cond === 'dimma') tags.push('dimma');
    if ((now.wind ?? 99) <= L.CALM && out.maxGust < L.WINDY_GUST / 2) tags.push('lugnt');
    const stormy = (now.wind ?? 0) >= L.STORMY || out.maxGust >= L.STORMY_GUST;
    if (stormy) tags.push('mycket_blasigt');
    else if ((now.wind ?? 0) >= L.WINDY || out.maxGust >= L.WINDY_GUST) tags.push('blasigt');
    if ((now.temp ?? 99) < 0) tags.push('minusgrader');
    if ((now.temp ?? -99) >= L.WARM) tags.push('varmt');
    if (info.cond === 'aska') tags.push('aska');
    if (out.pressureChange != null && out.pressureChange <= -L.PRESSURE_DROP) tags.push('tryckfall');
    if (out.tempChange != null && Math.abs(out.tempChange) >= L.WEATHER_SHIFT_TEMP) tags.push('omslag');
    out.tags = tags;
    // "Blåsigt" räknas även när det är "mycket blåsigt" (för filter och statistik)
    out.tagSet = new Set(stormy ? [...tags, 'blasigt'] : tags);
    return out;
  };

  W.bandFor = function (bands, value) {
    if (value == null || Number.isNaN(Number(value))) return null;
    return bands.find((b) => value < b.max || b.max === Infinity)?.label ?? null;
  };

  const r1 = (x) => (x == null ? '–' : Math.round(x * 10) / 10);
  W.format = { r1, temp: (x) => (x == null ? '–' : `${Math.round(x)}°`) };

  // Kort rad, t.ex. "🌧️ Lätt regn · 8° · 6 m/s (byar 11)"
  W.shortText = function (a) {
    if (!a) return '';
    const n = a.now;
    return `${a.info.icon} ${a.info.text} · ${W.format.temp(n.temp)} · ${Math.round(n.wind ?? 0)} m/s`
      + (n.gust != null ? ` (byar ${Math.round(n.gust)})` : '');
  };
})();

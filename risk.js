// =============================================================
// Riskanalys – inställningar och beräkning
// =============================================================
// Risk (0–100) = djurets allvarlighet (1–10) × 10 × lägesfaktor × flockfaktor
// Alla siffror nedan går att justera.

window.RISK = {
  // ---------- Djurets allvarlighet 1–10 (storlek/vikt/skada vid kollision) ----------
  // Standard per djurgrupp (se species.js). Minsta fågel = 1, älg = 10.
  GROUP_SEVERITY: {
    // Fåglar
    smafagel: 1, mellanfagel: 3, krakfagel: 3, fagel: 3, vitfagel: 5, and: 5,
    honsfagel: 5, uggla: 5, rovfagel: 6, gas: 7, storfagel: 8, svan: 9,
    // Däggdjur
    smadjur: 1, fladdermus: 1, igelkott: 2, ekorre: 2, katt: 3, hare: 4, mard: 4,
    rav: 5, hund: 5, vattendjur: 5, daggdjur: 5, sal: 6, lodjur: 7, hjort: 8,
    varg: 8, vildsvin: 9, bjorn: 10, alg: 10,
    // Okänt
    ovrigt: 5,
  },
  // Enskilda arter som avviker från sin grupp
  SPECIES_SEVERITY: {
    'Rådjur': 7, 'Kronhjort': 9, 'Havsörn': 9, 'Kungsörn': 9, 'Berguv': 7,
    'Tjäder': 7, 'Orre': 5, 'Havstrut': 6, 'Gråtrut': 6, 'Storskarv': 6,
    'Gråhäger': 7, 'Trana': 8, 'Korp': 4, 'Stadsduva': 3, 'Ringduva': 4,
    'Fågelflock (okänd art)': 5, 'Okänd fågel': 3, 'Okänt däggdjur': 5,
  },

  // ---------- Läge: hur farligt det är var djuret befinner sig ----------
  // bird = fåglar, mammal = däggdjur. Högsta faktorn av alla zoner djuret är i gäller.
  ZONES: {
    runway:   { label: 'På bana',                       bird: 1.0,  mammal: 1.0 },
    taxiway:  { label: 'På taxibana',                   bird: 0.85, mammal: 0.95 },
    approach: { label: 'I in-/utflygning',              bird: 0.9,  mammal: 0.2 },
    airside:  { label: 'Innanför stängslet',            bird: 0.6,  mammal: 0.9 },
    near:     { label: 'Nära stängslet (utanför)',      bird: 0.3,  mammal: 0.25 },
    outside:  { label: 'Utanför flygplatsen',           bird: 0.1,  mammal: 0.05 },
  },

  // Mått i meter för zonerna som räknas ut från banorna
  RUNWAY_HALF_WIDTH: 150,    // banområde på var sida om banans mittlinje
  RUNWAY_END_EXTRA: 60,      // banområdet fortsätter lite förbi banänden
  APPROACH_LENGTH: 3000,     // in-/utflygning ut från varje banände
  APPROACH_SPREAD: 0.15,     // korridoren vidgas 15 % per meter ut (som ICAO)
  TAXIWAY_HALF_WIDTH: 45,    // taxibana på var sida om mittlinjen
  NEAR_FENCE: 500,           // "nära stängslet" = inom så här många meter utanför

  // ---------- Flock: fler djur = större risk ----------
  FLOCK: [
    { min: 51, factor: 2.2 },
    { min: 21, factor: 1.9 },
    { min: 6,  factor: 1.6 },
    { min: 2,  factor: 1.3 },
    { min: 1,  factor: 1.0 },
  ],

  // ---------- Nivåer och rekommenderad åtgärd ----------
  LEVELS: [
    { min: 70, key: 'kritisk', label: 'Kritisk', color: '#b71c1c', action: 'Kontakta tornet direkt.' },
    { min: 45, key: 'hog',     label: 'Hög',     color: '#e65100', action: 'Skräm bort och informera driften.' },
    { min: 20, key: 'medel',   label: 'Medel',   color: '#f9a825', action: 'Bevaka och kontrollera området.' },
    { min: 0,  key: 'lag',     label: 'Låg',     color: '#2e7d32', action: 'Notera.' },
  ],

  // ---------- Åtgärder som kan registreras ----------
  // closes: true = risken räknas som hanterad
  ACTIONS: {
    bortskramt:    { label: 'Skrämt bort',          icon: '📣', closes: true },
    skramselskott: { label: 'Skrämselskott',        icon: '💥', closes: true },
    avlivat:       { label: 'Avlivat',              icon: '🎯', closes: true },
    ej_bekraftat:  { label: 'Kunde inte bekräfta',  icon: '❔', closes: true },
    borta:         { label: 'Borta vid kontroll',   icon: '✅', closes: true },
    bevakas:       { label: 'Bevakas',              icon: '👀', closes: false },
    tornet:        { label: 'Tornet informerat',    icon: '📡', closes: false },
    ovrigt:        { label: 'Övrig notering',       icon: '📝', closes: false },
  },

  // Zontyper som admin kan rita
  ZONE_TYPES: {
    runway:  { label: 'Bana',      color: '#1565c0', hint: 'Tryck på banans två ändar (mitt på banan).' },
    taxiway: { label: 'Taxibana',  color: '#6a1b9a', hint: 'Tryck längs taxibanans mittlinje, punkt för punkt.' },
    airside: { label: 'Stängsel',  color: '#00838f', hint: 'Tryck runt hela området innanför stängslet.' },
  },
};

// =============================================================
// Geometri – räknar i meter kring en punkt (räcker gott för en flygplats)
// =============================================================

(function () {
  const R = window.RISK;

  function projector(lat0, lng0) {
    const kx = Math.cos(lat0 * Math.PI / 180) * 111320;
    const ky = 110540;
    return ([lat, lng]) => [(lng - lng0) * kx, (lat - lat0) * ky];
  }

  function distToSegment(p, a, b) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  }

  function insidePolygon(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function distToPolygonEdge(p, poly) {
    let best = Infinity;
    for (let i = 0; i < poly.length; i++) best = Math.min(best, distToSegment(p, poly[i], poly[(i + 1) % poly.length]));
    return best;
  }

  // Var på/runt en bana ligger punkten? Ger 'runway', 'approach' eller null.
  function runwayRelation(p, a, b) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (!len) return null;
    const ux = dx / len;
    const uy = dy / len;
    const along = (p[0] - a[0]) * ux + (p[1] - a[1]) * uy;  // längs banan från ände A
    const side = Math.abs(-(p[0] - a[0]) * uy + (p[1] - a[1]) * ux); // avstånd från mittlinjen

    if (along >= -R.RUNWAY_END_EXTRA && along <= len + R.RUNWAY_END_EXTRA && side <= R.RUNWAY_HALF_WIDTH) return 'runway';
    const beyond = along < 0 ? -along : along - len;  // meter ut från närmaste banände
    if (beyond > 0 && beyond <= R.APPROACH_LENGTH && side <= R.RUNWAY_HALF_WIDTH + R.APPROACH_SPREAD * beyond) return 'approach';
    return null;
  }

  // Alla zoner som punkten ligger i, t.ex. [{ zone: 'runway', name: 'Bana 01L/19R' }, …]
  R.zonesAt = function (lat, lng, zones) {
    const proj = projector(lat, lng);
    const p = [0, 0];
    const hits = [];
    let hasFence = false;
    for (const z of zones) {
      const pts = (z.points || []).map(proj);
      if (z.zone_type === 'runway' && pts.length >= 2) {
        const rel = runwayRelation(p, pts[0], pts[pts.length - 1]);
        if (rel) hits.push({ zone: rel, name: rel === 'approach' ? `In-/utflygning ${z.name}` : z.name });
      } else if (z.zone_type === 'taxiway' && pts.length >= 2) {
        for (let i = 0; i < pts.length - 1; i++) {
          if (distToSegment(p, pts[i], pts[i + 1]) <= R.TAXIWAY_HALF_WIDTH) { hits.push({ zone: 'taxiway', name: z.name }); break; }
        }
      } else if (z.zone_type === 'airside' && pts.length >= 3) {
        hasFence = true;
        if (insidePolygon(p, pts)) hits.push({ zone: 'airside', name: z.name });
        else if (distToPolygonEdge(p, pts) <= R.NEAR_FENCE) hits.push({ zone: 'near', name: `Nära ${z.name}` });
      }
    }
    // Djur i in-/utflygningen men innanför stängslet räknas också som innanför
    if (!hits.length) hits.push({ zone: 'outside', name: hasFence ? 'Utanför flygplatsen' : 'Ingen zon (inga zoner ritade)' });
    return hits;
  };

  // Punkter för att rita banområde och in-/utflygning på kartan
  R.runwayShapes = function (a, b) {
    const proj = projector(a[0], a[1]);
    const kx = Math.cos(a[0] * Math.PI / 180) * 111320;
    const ky = 110540;
    const unproj = ([x, y]) => [a[0] + y / ky, a[1] + x / kx];
    const A = proj(a);
    const B = proj(b);
    const len = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
    const u = [(B[0] - A[0]) / len, (B[1] - A[1]) / len];
    const n = [-u[1], u[0]];
    const at = (along, side) => unproj([A[0] + u[0] * along + n[0] * side, A[1] + u[1] * along + n[1] * side]);
    const w = R.RUNWAY_HALF_WIDTH;
    const e = R.RUNWAY_END_EXTRA;
    const L = R.APPROACH_LENGTH;
    const far = w + R.APPROACH_SPREAD * L;
    return {
      strip: [at(-e, -w), at(len + e, -w), at(len + e, w), at(-e, w)],
      approachA: [at(0, -w), at(-L, -far), at(-L, far), at(0, w)],
      approachB: [at(len, -w), at(len + L, -far), at(len + L, far), at(len, w)],
    };
  };

  // ---------- Poäng ----------

  R.severityFor = function (speciesName, groupKey) {
    const name = String(speciesName || '').trim();
    const exact = Object.keys(R.SPECIES_SEVERITY).find((k) => k.toLowerCase() === name.toLowerCase());
    if (exact) return R.SPECIES_SEVERITY[exact];
    return R.GROUP_SEVERITY[groupKey] ?? R.GROUP_SEVERITY.ovrigt;
  };

  R.flockFactor = function (count) {
    return (R.FLOCK.find((f) => count >= f.min) || R.FLOCK[R.FLOCK.length - 1]).factor;
  };

  R.levelFor = function (score) {
    return R.LEVELS.find((l) => score >= l.min) || R.LEVELS[R.LEVELS.length - 1];
  };

  // kind = 'fagel', 'daggdjur' eller 'annat'
  R.assess = function ({ species, groupKey, kind, count, lat, lng, zones }) {
    const severity = R.severityFor(species, groupKey);
    const hits = R.zonesAt(lat, lng, zones || []);
    const factorOf = (zoneKey) => {
      const z = R.ZONES[zoneKey];
      if (kind === 'fagel') return z.bird;
      if (kind === 'daggdjur') return z.mammal;
      return Math.max(z.bird, z.mammal);  // okänt djur: räkna med det värsta
    };
    const best = hits.reduce((a, b) => (factorOf(b.zone) > factorOf(a.zone) ? b : a));
    const zoneFactor = factorOf(best.zone);
    const flock = R.flockFactor(Math.max(1, Number(count) || 1));
    const score = Math.min(100, Math.round(severity * 10 * zoneFactor * flock));
    return { score, level: R.levelFor(score), severity, zone: best, zoneFactor, flock, hits };
  };
})();

// Inställningar för appen.
// Här får BARA den publika nyckeln (publishable/anon) finnas.
// Lägg ALDRIG in secret- eller service_role-nyckeln här.
window.CONFIG = {
  // ===== APPENS NAMN =====
  // Byt namn här – det slår igenom överallt i appen (rubrik, flik, startsida).
  // OBS: namnet på hemskärmen står i manifest.json ("name" och "short_name") – byt även där.
  APP_NAME: {
    line1: 'Charlies',          // rad 1 på startsidan
    line2: 'mega-ultra-',       // rad 2 (kursiv)
    line3: 'viltrapport-app',   // rad 3
  },

  SUPABASE_URL: 'https://xkerpguqjzigoycllkwo.supabase.co',
  SUPABASE_KEY: 'sb_publishable_BvwJ7TJs0YV3vCw0SzGK9w_E_EIohBt',

  // Kartans startläge (flygplatsen)
  MAP_CENTER: [59.64695117088159, 17.938746172440855],
  MAP_ZOOM: 14,
};

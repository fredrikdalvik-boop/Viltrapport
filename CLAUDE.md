# Charlies mega-ultra-viltrapport-app – projektbeskrivning

Appens namn är **"Charlies mega-ultra-viltrapport-app"** (repo: Viltrapport). Namnet är på skoj och kan bytas:
det finns på ETT ställe, `CONFIG.APP_NAME` i `config.js` (tre rader). JS fyller i alla element med
`data-app-name="line1|line2|line3|full"` och `document.title`. Undantag som måste bytas för hand:
`manifest.json` (`name`, `short_name`) och reservtexten i `index.html` (`<title>`, `apple-mobile-web-app-title`).

PWA där personal på en flygplats (Arlanda, 59.6470, 17.9387) rapporterar
var de sett vilt genom att markera platsen på en karta. Alla inloggade ser
allas rapporter. Man kan redigera och ta bort bara sina egna.

## Om användaren
- Ny på programmering. Förklara på **svenska**, enkelt, **ett steg i taget**,
  och vänta på bekräftelse innan nästa steg.
- När användaren ska göra något i Supabase eller GitHub: beskriv exakt var man klickar.
- Påminn gärna om säkerhet (se nedan).

## Teknik
- Vanlig HTML/CSS/JS, **inget byggsteg, inget ramverk**.
- Bibliotek från CDN: Leaflet 1.9.4 (cdnjs), supabase-js v2 (jsdelivr, UMD → `window.supabase`).
- Kartor: OpenStreetMap och Esri World Imagery (satellit), valbara via lagerknappen.
- Supabase (gratisnivå) för databas och inloggning (e-post och lösenord).
- Hosting: **Cloudflare Pages** (projekt `viltrapport`, production branch `claude/wildlife-reporting-pwa-hawg43`, ingen build). GitHub Pages finns också kvar. Alla sökvägar är relativa (`./`) så båda fungerar.

## Filer
| Fil | Innehåll |
|---|---|
| `index.html` | Vyer: inloggning, välj lösenord, app (karta, lista, formulär) |
| `style.css` | Mobil först, stora knappar |
| `app.js` | All logik: auth, karta, CRUD, filter/sortering, artförslag |
| `config.js` | Supabase-URL, publishable-nyckel, kartans centrum och zoom |
| `risk.js` | `window.RISK`: alla riskinställningar (allvarlighet per grupp/art, zonfaktorer, flock, nivåer, åtgärder, zontyper) + geometri och `RISK.assess()` |
| `species.js` | `SPECIES_GROUPS` (grupp → etikett + emoji-ikon, ev. `fallback`) och `SPECIES` (`[namn, grupp]`, ca 300 arter) |
| `icons/hero-scene.svg` | Startsidans illustration från Claude Design (viewBox 480×440, `xMidYMax slice`). Används som den är. Himlens gradient ligger på `.hero` i CSS |
| `sw.js` | Service worker. Egna filer: network-first. CDN: cache-first. Supabase och kartbilder cachas inte |
| `manifest.json`, `icons/` | PWA-installation |
| `supabase.sql` | Tabell, trigger och RLS-policies. Klistras in i Supabase SQL Editor |

## Databas (`public.reports`)
`id, user_id, reporter_email, report_type, species, animal_count, observed_at, comment, lat, lng, created_at, updated_at`
- `report_type`: `observation` (standard), `olycka` (fordon) eller `birdstrike` (flygplan). Check-constraint i SQL.
- Trigger `reports_set_owner` sätter `user_id` och `reporter_email` från den
  inloggades JWT vid insert och låser dem vid update. Appen skickar dem aldrig.
- RLS är på. Medlemmar (`is_member()`): select alla, insert egna. Update/delete: ägaren eller admin (`is_admin()`). `anon`: ingen åtkomst.

## Tema och utseende
- Ljust/mörkt tema med CSS-variabler i `style.css` (`--bg`, `--surface`, `--text`, `--muted`, `--border`, `--green`/`--green-ink`/`--green-light`, …).
  Mörka värden finns två gånger: `:root[data-theme="dark"]` och `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])` – ändra båda.
- Val under ⚙️ (Auto/Ljust/Mörkt) sparas i `localStorage` (`viltrapport-theme`). Ett litet skript i `<head>` sätter `data-theme` innan sidan ritas.
- Vanliga kartan (`className: 'tiles-streets'`) inverteras i mörkt tema; satellit lämnas orörd.
- Toppen (`.topbar`, `--topbar-bg`) är mörk i båda temana: logga (inline-SVG) + `brand-kicker` (line1) + `brand-name` (`data-app-name="rest"` = line2+line3).
- Paneler (`.sheet`): tät layout, rubriken (`h2`) och knappraden (`.sheet-buttons`) är `position: sticky` så att Avbryt/Spara alltid syns.

## Design (inloggning)
- Inloggningsvyn följer designpaketet från Claude Design: bakgrund `#101218`, kolumn max 480px, hero 440px,
  kort `#fbfaf7` som överlappar heron med 44px. Typsnitt: EB Garamond (rubriker), Source Sans 3 (UI).
  Färger: primär `#c8603d`, länk `#1f5b3c`, fel `#b3261e`.
- Allt inloggningsrelaterat ligger i `#auth-view` som paneler (`data-panel`): login, forgot, signup, code, password.
  `showView()`/`showPanel()` i app.js växlar. Egen validering (`novalidate`) med fel under fälten.

## Övriga tabeller
- `profiles (user_id, email, full_name, color, is_member, is_admin, code_attempts)`: skapas av triggern `handle_new_user` på `auth.users` (tar `full_name` från signUp-metadata). Användaren får bara uppdatera `color` och `full_name` (kolumnrättighet). `is_admin` ändras bara via `set_admin()`, andras namn via `set_full_name()` (admin).
- Namn visas överallt via `nameFor(user_id, fallbackEmail)` i app.js: `full_name` om det finns, annars e-post. `reports.reporter_email` finns kvar som reserv.
- `custom_species (id, name, category)`: arter som användare lagt till. Unik på `lower(btrim(name))`. Medlemmar läser och lägger till, admin tar bort.
- `app_settings (key, value)`: `signup_code` = inbjudningskoden. Bara admin kan läsa. Byts via `set_signup_code()`.

## Konton, kod och admin
- Vem som helst kan skapa ett konto (Supabase: "Allow new users to sign up" PÅ), men utan rätt inbjudningskod blir man inte medlem och ser ingenting.
- Koden skickas i `signUp` som `options.data.signup_code`. Triggern jämför den (skiftlägesokänsligt). Fel kod → vyn "Inbjudningskod" → `redeem_signup_code()` (max 10 felförsök, sedan 'locked').
- Auto-admin: `is_auto_admin_email()` (i dag `charlie.ledin@swedavia.se`) blir admin när kontot får giltig kod.
- Alla ser under ⚙️: eget namn (kan ändras) och färg. Admin ser dessutom: koden (kan bytas), användarlista (ändra namn, gör till/ta bort admin), egna arter (ta bort).
- Registrering kräver för- och efternamn (minst ett mellanslag, 2–80 tecken).
- `supabase.sql` innehåller allt och är idempotent. Första körningen med `is_member` gör alla dåvarande användare till medlemmar.

## Ikoner och färger
- Nålen = cirkel (28px) i rapportörens färg med djurgruppens emoji. Triangeln för olycka/birdstrike är 32px.
- Ikonen växer (`scale(1.45)`) vid hovring och när dess ruta är öppen (`.marker-active`). På dator (`CAN_HOVER`) visas en kort informationsruta (`tooltipHtml()`) vid hovring; klick öppnar den vanliga rutan. På mobil visas bara den vanliga rutan vid tryck.
- Emoji som äldre telefoner saknar (🫎, 🪿, 🐦‍⬛) kontrolleras med canvas och byts mot `fallback`.
- Skriver man en okänd art visas "Ny art!" med val av grupp. Arten sparas i `custom_species`.
- Varje grupp i `SPECIES_GROUPS` har `kind`: `daggdjur`, `fagel` eller `annat`.

## Riskanalys
- Poäng 0–100 = allvarlighet (1–10, `GROUP_SEVERITY`/`SPECIES_SEVERITY`) × 10 × lägesfaktor × flockfaktor, max 100.
  Nivåer: Låg <20, Medel 20–44, Hög 45–69, Kritisk ≥70 (`RISK.LEVELS`, med rekommenderad åtgärd).
- Nedtrappning: risken sjunker en nivå per `RISK.DECAY_HOURS` (24 h) räknat från `observed_at`. Poängen kapas till nya nivåns tak.
  Efter Låg blir den `expired` ("Inaktuell") och räknas inte i aktiva/sammanfattning. Hanterade (åtgärd) räknas som hanterade oavsett ålder.
- `RISK.MIN_SCORE_BY_TYPE`: lägsta poäng per rapporttyp. Birdstrike = alltid minst 45 (Hög). Riskrapporten visar när poängen höjts av typen.
- Läge (`RISK.ZONES`, olika för fågel/däggdjur): runway 1.0/1.0, taxiway 0.85/0.95, approach 0.9/0.2, airside 0.6/0.9, near 0.3/0.25, outside 0.1/0.05. Högsta zonen gäller.
- Zoner i tabellen `risk_zones (name, zone_type, points jsonb)`, ritas av admin i appen (`startDraw()`, ritpanelen `#draw-panel`):
  `runway` = 2 punkter (banändar) → banområde ±150 m och in-/utflygning 3 km som vidgas 15 % (`RISK.runwayShapes`);
  `taxiway` = linje ±45 m; `airside` = yta innanför stängslet, "nära" = inom 500 m utanför.
- Åtgärder i `report_actions (report_id, action, comment, created_by, created_at)`. `RISK.ACTIONS[x].closes` = hanterar risken
  (skrämt bort, skrämselskott, avlivat, kunde inte bekräfta, borta vid kontroll). Risken sjunker inte av tid – bara av åtgärd.
- Fliken "⚠️ Risk" (`#risk-view`): sammanfattning, Aktiva/Hanterade/Alla, lista sorterad på poäng, zonlista. Riskrapport i `#risk-sheet`.
- **Riskinställningar i appen:** tabellen `risk_config` (en rad, id = 1, `config jsonb`). Alla medlemmar läser, admin uppdaterar (`update (config)`); trigger sätter `updated_by/updated_at`.
  `RISK.DEFAULTS` = standardvärdena i risk.js; `RISK.applyConfig(cfg)` lägger sparad config ovanpå (validerar/begränsar värden); `RISK.currentConfig()`.
  Redigerbara nycklar: `RISK.CONFIG_KEYS`. Panelen `#riskcfg-sheet` (Risk-fliken → "Ändra/Visa riskinställningar"). Tom config `{}` = standard ("Återställ").
- Riskzonerna är ett eget lager på kartan ("⚠️ Riskzoner"), kan också slås av/på i filterpanelen (`#filter-riskzones`, sparas i `layerPrefs.risk`).

## Export till Excel
- ⚙️ → "Exportera till Excel": Allt eller det filtret visar. SheetJS (`xlsx@0.18.5` från jsdelivr) laddas först vid export (`loadScript`).
- Flikar: Rapporter (32 kolumner inkl. riskdata, status, kartlänk), Åtgärder, Sammanfattning, Per djurslag, Riskzoner, Riskinställningar.
- Datum skrivs som Excel-datum (`yyyy-mm-dd hh:mm`, webbläsarens lokala tid). Saknade värden blir tomma (`xlDate`).

## Rapporttyper
- `REPORT_TYPES` i app.js. Väljs överst i formuläret (`#type-picker`). Vid olycka/birdstrike heter fältet "Viltslag".
- Olycka/birdstrike ritas som gul varningstriangel (`triangleHtml()`, inline-SVG) med 🚗/✈️ och en prick i rapportörens färg,
  `zIndexOffset: 1000` så att de ligger överst. Emojin har `z-index: 1` (Leaflet lägger annars svg:n överst).
- Filtret har "Typ" (`filter.type`).

## Områden (GPX)
- `data/omraden.gpx` (export från WeHunt, offentliga gränser) ritas ovanpå kartan av `loadAreas()`. Sökväg i `CONFIG.AREAS_GPX`.
- `<type>` styr stilen (`AREA_STYLES`): `border` = gul yttergräns, `subarea` = orange delområde med namn,
  `forbidden` = röd streckad yta, namn med ⛔. Lagerknappen har: Yttergräns, Delområden, Förbjudna områden,
  Namn på områden (tomt lager som bara styr klassen `hide-area-labels`).
- Valen i lagerknappen (även Karta/Satellit) sparas i `localStorage` (`viltrapport-layers`, `layerPrefs`).
- Ytorna är `interactive: false` så att kartklick går igenom (man kan rapportera inne i ett område).
- Namnen ligger i panen `areaLabels` (under nålarna) och döljs vid zoom < 13.
- Uppdatera gränser: byt filen i `data/` och öka versionen i `sw.js`/`index.html`.

## Filter
- Ett gemensamt filter för karta och lista: filterraden (`.filter-bar`) under toppen, panelen `#filter-sheet`.
- State i `filter` (app.js), sparas i `localStorage` (`viltrapport-filter`): `animal {type: kind|group|species, value, label, icon}`,
  `reporter` (''/'me'/user_id), `quick` (''/'today'/'7'/'30'), `from`, `to`, `sort`. Ändra alltid via `setFilter()`.
- Smarta djurfältet: `animalOptions(q)` ger "Alla däggdjur/fåglar" först, sedan grupper, sedan arter.
- Aktiva filter visas som etiketter (`.chip`) med ✕.

## Inloggning
- Konton skapas i appen med inbjudningskod. Admin kan också skapa användare i Supabase
  (Authentication → Users → Add user). De får då ange koden vid första inloggningen.
- Inbjudnings- och återställningslänkar (`#...type=invite|recovery`) visar
  vyn "Välj lösenord". Kräver att Site URL/Redirect URLs i Supabase pekar på appens adress (Cloudflare Pages).

## Säkerhetsregler
- Bara den publika nyckeln (`sb_publishable_...`/anon) får finnas i koden.
- **Secret-/service_role-nyckeln får ALDRIG hamna i koden eller på GitHub.**
- All användartext visas via `escapeHtml()` (skydd mot XSS).

## Utveckling
- Testa lokalt: `python3 -m http.server 8000` och öppna http://localhost:8000
- Vid varje ändring: öka `?v=` på css/js i `index.html` och `CACHE` i `sw.js` (samma nummer). Annars kan gamla filer ligga kvar i webbläsaren.
- Git-gren för arbete: `claude/wildlife-reporting-pwa-hawg43`.

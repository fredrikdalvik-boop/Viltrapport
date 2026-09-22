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

## Design (inloggning)
- Inloggningsvyn följer designpaketet från Claude Design: bakgrund `#101218`, kolumn max 480px, hero 440px,
  kort `#fbfaf7` som överlappar heron med 44px. Typsnitt: EB Garamond (rubriker), Source Sans 3 (UI).
  Färger: primär `#c8603d`, länk `#1f5b3c`, fel `#b3261e`.
- Allt inloggningsrelaterat ligger i `#auth-view` som paneler (`data-panel`): login, forgot, signup, code, password.
  `showView()`/`showPanel()` i app.js växlar. Egen validering (`novalidate`) med fel under fälten.

## Övriga tabeller
- `profiles (user_id, email, color, is_member, is_admin, code_attempts)`: skapas av triggern `handle_new_user` på `auth.users`. Användaren får bara uppdatera `color` (kolumnrättighet). `is_admin` ändras bara via `set_admin()`.
- `custom_species (id, name, category)`: arter som användare lagt till. Unik på `lower(btrim(name))`. Medlemmar läser och lägger till, admin tar bort.
- `app_settings (key, value)`: `signup_code` = inbjudningskoden. Bara admin kan läsa. Byts via `set_signup_code()`.

## Konton, kod och admin
- Vem som helst kan skapa ett konto (Supabase: "Allow new users to sign up" PÅ), men utan rätt inbjudningskod blir man inte medlem och ser ingenting.
- Koden skickas i `signUp` som `options.data.signup_code`. Triggern jämför den (skiftlägesokänsligt). Fel kod → vyn "Inbjudningskod" → `redeem_signup_code()` (max 10 felförsök, sedan 'locked').
- Auto-admin: `is_auto_admin_email()` (i dag `charlie.ledin@swedavia.se`) blir admin när kontot får giltig kod.
- Admin ser under ⚙️: koden (kan bytas), användarlista (gör till/ta bort admin), egna arter (ta bort).
- `supabase.sql` innehåller allt och är idempotent. Första körningen med `is_member` gör alla dåvarande användare till medlemmar.

## Ikoner och färger
- Nålen = cirkel (28px) i rapportörens färg med djurgruppens emoji. Triangeln för olycka/birdstrike är 32px.
- Ikonen växer (`scale(1.45)`) vid hovring och när dess ruta är öppen (`.marker-active`). På dator (`CAN_HOVER`) visas en kort informationsruta (`tooltipHtml()`) vid hovring; klick öppnar den vanliga rutan. På mobil visas bara den vanliga rutan vid tryck.
- Emoji som äldre telefoner saknar (🫎, 🪿, 🐦‍⬛) kontrolleras med canvas och byts mot `fallback`.
- Skriver man en okänd art visas "Ny art!" med val av grupp. Arten sparas i `custom_species`.
- Varje grupp i `SPECIES_GROUPS` har `kind`: `daggdjur`, `fagel` eller `annat`.

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

# Charlies mega-ultra-viltrapport – projektbeskrivning

Appens namn är **"Charlies mega-ultra-viltrapport"** (repo: Viltrapport).

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
- Hosting: GitHub Pages. Alla sökvägar är relativa (`./`) eftersom sidan ligger under `/Viltrapport/`.

## Filer
| Fil | Innehåll |
|---|---|
| `index.html` | Vyer: inloggning, välj lösenord, app (karta, lista, formulär) |
| `style.css` | Mobil först, stora knappar |
| `app.js` | All logik: auth, karta, CRUD, filter/sortering, artförslag |
| `config.js` | Supabase-URL, publishable-nyckel, kartans centrum och zoom |
| `species.js` | `SPECIES_GROUPS` (grupp → etikett + emoji-ikon, ev. `fallback`) och `SPECIES` (`[namn, grupp]`, ca 300 arter) |
| `icons/scene.svg` | Startsidans bild: skog i solnedgång, två jägare med gevär på ryggen, en labrador och en beagle. Genererad med ett Python-skript (finns inte i repot), redigera SVG:n direkt |
| `sw.js` | Service worker. Egna filer: network-first. CDN: cache-first. Supabase och kartbilder cachas inte |
| `manifest.json`, `icons/` | PWA-installation |
| `supabase.sql` | Tabell, trigger och RLS-policies. Klistras in i Supabase SQL Editor |

## Databas (`public.reports`)
`id, user_id, reporter_email, species, animal_count, observed_at, comment, lat, lng, created_at, updated_at`
- Trigger `reports_set_owner` sätter `user_id` och `reporter_email` från den
  inloggades JWT vid insert och låser dem vid update. Appen skickar dem aldrig.
- RLS är på. Medlemmar (`is_member()`): select alla, insert egna. Update/delete: ägaren eller admin (`is_admin()`). `anon`: ingen åtkomst.

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
- Nålen = cirkel i rapportörens färg med djurgruppens emoji. Emoji som äldre telefoner saknar (🫎, 🪿, 🐦‍⬛) kontrolleras med canvas och byts mot `fallback`.
- Skriver man en okänd art visas "Ny art!" med val av grupp. Arten sparas i `custom_species`.

## Inloggning
- Konton skapas i appen med inbjudningskod. Admin kan också skapa användare i Supabase
  (Authentication → Users → Add user). De får då ange koden vid första inloggningen.
- Inbjudnings- och återställningslänkar (`#...type=invite|recovery`) visar
  vyn "Välj lösenord". Kräver att Site URL/Redirect URLs i Supabase pekar på GitHub Pages-adressen.

## Säkerhetsregler
- Bara den publika nyckeln (`sb_publishable_...`/anon) får finnas i koden.
- **Secret-/service_role-nyckeln får ALDRIG hamna i koden eller på GitHub.**
- All användartext visas via `escapeHtml()` (skydd mot XSS).

## Utveckling
- Testa lokalt: `python3 -m http.server 8000` och öppna http://localhost:8000
- Vid varje ändring: öka `?v=` på css/js i `index.html` och `CACHE` i `sw.js` (samma nummer). Annars kan gamla filer ligga kvar i webbläsaren.
- Git-gren för arbete: `claude/wildlife-reporting-pwa-hawg43`.

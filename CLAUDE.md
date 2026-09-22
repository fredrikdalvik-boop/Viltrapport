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
- RLS är på. `authenticated`: select alla, insert/update/delete bara egna. `anon`: ingen åtkomst.

## Övriga tabeller
- `profiles (user_id, color)`: användarens valda färg. Alla inloggade kan läsa, man ändrar bara sin egen. Saknas en färg används en standardfärg (hash av user_id).
- `custom_species (name, category)`: arter som användare lagt till. Unik på `lower(btrim(name))`. Inloggade kan läsa och lägga till, inte ändra eller ta bort.
- Appen fungerar även om de två tabellerna saknas (bara varningar i konsolen).

## Ikoner och färger
- Nålen = cirkel i rapportörens färg med djurgruppens emoji. Emoji som äldre telefoner saknar (🫎, 🪿, 🐦‍⬛) kontrolleras med canvas och byts mot `fallback`.
- Skriver man en okänd art visas "Ny art!" med val av grupp. Arten sparas i `custom_species`.

## Inloggning
- Öppen registrering är avstängd i Supabase. Admin skapar användare under
  Authentication → Users → Add user.
- Inbjudnings- och återställningslänkar (`#...type=invite|recovery`) visar
  vyn "Välj lösenord". Kräver att Site URL/Redirect URLs i Supabase pekar på GitHub Pages-adressen.

## Säkerhetsregler
- Bara den publika nyckeln (`sb_publishable_...`/anon) får finnas i koden.
- **Secret-/service_role-nyckeln får ALDRIG hamna i koden eller på GitHub.**
- All användartext visas via `escapeHtml()` (skydd mot XSS).

## Utveckling
- Testa lokalt: `python3 -m http.server 8000` och öppna http://localhost:8000
- Vid ändring av filer i `APP_FILES` i `sw.js`: öka `CACHE`-versionen.
- Git-gren för arbete: `claude/wildlife-reporting-pwa-hawg43`.

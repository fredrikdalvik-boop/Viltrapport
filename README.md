# Charlies mega-ultra-viltrapport-app

En app för att rapportera vilt på flygplatsen. Man trycker på kartan där djuret
sågs, fyller i art och antal, och sparar. Alla inloggade ser allas rapporter.

## Använda appen
1. Logga in med e-post och lösenord.
2. **Karta:** tryck där du såg djuret. Välj typ (**Observation**, **Olycka** eller **Birdstrike**),
   fyll i formuläret och tryck på **Spara**. Olyckor och birdstrikes visas som varningstrianglar.
   - Varje nål har rapportörens färg och en ikon för djurslaget.
   - Välj din egen färg under ⚙️ (uppe till höger).
   - Knappen uppe till höger byter mellan karta och satellitbild.
3. **Filter** (🔍 uppe, både på kartan och i listan):
   - **Djur:** skriv t.ex. "fåglar", "däggdjur", "rovfåglar" eller "älg".
   - **Rapportör:** alla, bara mina eller en viss person.
   - **Datum:** Idag, 7 dagar, 30 dagar eller egna datum.
   - **Tid på dygnet, ljus och väder:** t.ex. "Morgon" + "Har regnat".
   - Filtren går att kombinera. Tryck ✕ på en etikett för att ta bort ett filter. Appen kommer ihåg filtret.
4. Dina egna rapporter kan du **redigera** eller **ta bort**.
5. **⚠️ Risk:** varje rapport får en riskpoäng 0–100 (Låg/Medel/Hög/Kritisk) utifrån djurets storlek,
   var det är (bana, inflygning, innanför stängsel …) och hur många. Tryck på en risk för att se varför
   och registrera åtgärd (t.ex. Skrämselskott). Risken ligger kvar tills en åtgärd registrerats.
6. **Admin:** ritar banor, taxibanor och stängsel under ⚠️ Risk → **Rita ny zon**, och ändrar hur risken
   räknas under ⚠️ Risk → **Ändra riskinställningar** (standardvärdena finns i `risk.js`).
7. **Väder:** varje rapport får automatiskt vädret för timmen och de 4 timmarna före (från Open-Meteo),
   samt om det var natt, gryning, dag eller skymning. Tryck på **📄 Detaljer** för att se allt.
8. **📊 Statistik:** diagram över arter, tid på dygnet, väder med mera. Följer filtret.
   Tryck på en stapel för att filtrera på den. **Jämför** visar t.ex. art mot tid på dygnet.
9. **Export:** ⚙️ → **Exportera till Excel** (allt eller det filtret visar).

## Installera på mobilen
- **Android (Chrome):** meny ⋮ → *Lägg till på startskärmen* / *Installera app*.
- **iPhone (Safari):** dela-knappen → *Lägg till på hemskärmen*.

## Lägga till en ny användare (admin)
Supabase → **Authentication** → **Users** → **Add user** → **Create new user**
→ fyll i e-post och lösenord → kryssa i **Auto Confirm User** → **Create user**.

## Lägga till fler arter
- Enklast: skriv bara in arten i appen. Den sparas och blir ett förslag för alla.
- Eller öppna `species.js` och lägg till en rad, t.ex. `['Myskoxe', 'daggdjur'],`.

## Uppdatera områdesgränserna
Exportera en ny GPX-fil (t.ex. från WeHunt), döp den till `omraden.gpx` och byt ut filen i mappen `data/`.

## Byta namn på appen
Ändra `APP_NAME` i `config.js`. För hemskärmen: ändra även `name` och `short_name` i `manifest.json`.

## Säkerhet
Bara den publika nyckeln finns i `config.js`. Secret-/service_role-nyckeln får
aldrig läggas in i koden.

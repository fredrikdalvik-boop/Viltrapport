# Charlies mega-ultra-viltrapport

En app för att rapportera vilt på flygplatsen. Man trycker på kartan där djuret
sågs, fyller i art och antal, och sparar. Alla inloggade ser allas rapporter.

## Använda appen
1. Logga in med e-post och lösenord.
2. **Karta:** tryck där du såg djuret. Fyll i formuläret och tryck på **Spara**.
   - Varje nål har rapportörens färg och en ikon för djurslaget.
   - Välj din egen färg under ⚙️ (uppe till höger).
   - Knappen uppe till höger byter mellan karta och satellitbild.
3. **Lista:** filtrera på djurslag, rapportör och datum. Filtret gäller även kartan.
4. Dina egna rapporter kan du **redigera** eller **ta bort**.

## Installera på mobilen
- **Android (Chrome):** meny ⋮ → *Lägg till på startskärmen* / *Installera app*.
- **iPhone (Safari):** dela-knappen → *Lägg till på hemskärmen*.

## Lägga till en ny användare (admin)
Supabase → **Authentication** → **Users** → **Add user** → **Create new user**
→ fyll i e-post och lösenord → kryssa i **Auto Confirm User** → **Create user**.

## Lägga till fler arter
- Enklast: skriv bara in arten i appen. Den sparas och blir ett förslag för alla.
- Eller öppna `species.js` och lägg till en rad, t.ex. `['Myskoxe', 'daggdjur'],`.

## Säkerhet
Bara den publika nyckeln finns i `config.js`. Secret-/service_role-nyckeln får
aldrig läggas in i koden.

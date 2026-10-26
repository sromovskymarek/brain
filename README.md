# Brain

Osobný Brain Mareka Šromovského – nástenka, denník, kalendár, financie, autá, výlety, ciele, zdravie, ľudia.
Samostatná webová aplikácia (PWA): beží na **https://brain.sromovskymarek.sk**, inštaluje sa na iPhone, iPad aj Mac
a funguje aj offline. Dáta sú v Supabase (databáza v EÚ), prístup má iba prihlásený vlastník.

## Ako to je poskladané
| Súbor | Čo robí |
|---|---|
| `index.html` | aplikácia (zostavená zo `src/brain-artifact.html` skriptom `tools/build.py`) |
| `shim.js` | napojenie na Supabase: dáta, fotky, prihlásenie, offline fronta, sekcia Účet |
| `sw.js` | service worker: offline režim a zobrazovanie súkromných fotiek |
| `config.js` | Project URL a publishable kľúč Supabase (verejné údaje, žiadne heslá) |
| `supabase/schema.sql` | tabuľka `docs`, pravidlá prístupu, úložisko `assets` |
| `vendor/supabase.js` | knižnica @supabase/supabase-js 2.117.1 (MIT) |

## Prvé nastavenie
1. Supabase → **SQL Editor** → vlož `supabase/schema.sql` → **Run**.
2. Supabase → **Authentication → Users → Add user → Create new user** (e-mail, heslo, zaškrtni *Auto Confirm User*).
3. Supabase → **Authentication → Sign In / Providers → Email**: vypni **Allow new users to sign up**.
4. Do `config.js` doplň Project URL a publishable kľúč (Settings → API).
5. Otvor https://brain.sromovskymarek.sk, prihlás sa a nahraj zálohu z pôvodnej aplikácie.

## Úprava aplikácie
Zmeny rob v `src/brain-artifact.html` a potom spusti `python3 tools/build.py src/brain-artifact.html index.html`.
Pri každej zmene `sw.js` alebo súborov appky zvýš verziu `V` v `sw.js`, aby sa zariadenia aktualizovali.

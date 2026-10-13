# context-gauge

Mod do [Claude Code](https://claude.com/claude-code), który nad promptem pokazuje, ile kontekstu zostało, co go zajmuje i ile czasu zostało do wygaśnięcia prompt cache.

```

 ███▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░▒▒▒▒▒▒▒ 412k/1M 41%  ◷ 47 min  ≡
 ■ system 20k  ■ narzędzia 12k  ■ wiadomości 380k  ░ wolne 423k  ▒ bufor 165k
```

- **pasek dzielony na kategorie** z `/context` (prompt systemowy, narzędzia, MCP, pamięć, skille, wiadomości); szerokość odcinka = jego udział w oknie, `░` to wolne miejsce, `▒` bufor autokompaktowania; pod paskiem legenda z nazwą i liczbą tokenów każdej kategorii
- **kolory z motywu CLI**: każda kategoria dostaje ten sam klucz motywu, którym rysuje ją `/context`, więc pasek zmienia się razem z `/theme` (dark, light, daltonized, ANSI)
- **odliczanie cache** od ostatniej odpowiedzi modelu w głównym wątku: minuty, a poniżej 10 min sekundy; zielony → żółty (< 10 min) → czerwony (< 2 min) → `◌ 0:00`, gdy cache wygasł; `◷ ●` w trakcie pracy modelu
- **toast** kilka minut przed wygaśnięciem cache, z liczbą tokenów, które trzeba by przecachować
- **`≡`** albo `/ctx` otwiera panel: każda kategoria z paskiem, tokenami i procentem, a pod spodem pełne listy (z liczbą i sumą): pliki pamięci, serwery MCP, skille, agenci; **[ Policz dokładnie ]** liczy jak `/context` (zapytaniami o liczbę tokenów), domyślnie panel szacuje lokalnie i za darmo

## Ustawienia

W `/config` (albo `pluginConfigs` w settings):

| Pole | Domyślnie | Co robi |
| --- | --- | --- |
| `cacheTtl` | `1h` | czas życia cache; `5m`, gdy sesja jest w overage i cache spada do 5 minut |
| `warnMinutes` | `5` | ile minut przed wygaśnięciem pokazać toast; `0` wyłącza |

## Status line (opcjonalnie)

`statusline/statusline.mjs` to jednoliniowy status line w kolorach motywu (czyta `theme` z settings, a dla `custom:*` plik z `~/.claude/themes`):

```
Opus 5.5 medium │ 5h ━─────── 13% ↻1h50 │ tydz ━━━━──── 47% ↻2d17h │ ⎇ main +42 −7 │ $4.96
```

- model i poziom effort
- limity 5h i tygodniowy; kolor według tempa: żółty/czerwony, gdy przy obecnym tempie limit skończy się przed resetem
- gałąź git i zmiany względem HEAD, koszt sesji
- **dokładny czas wygaśnięcia cache:** Claude Code podaje go status line'owi (`prompt_cache.expires_at`, też `ttl` przy overage), skrypt zapisuje go do `~/.claude/context-gauge/<sesja>.json`, a mod odlicza od niego zamiast szacować
- `--chain "<komenda>"` przekazuje to samo wejście innemu status line'owi (np. ClaudeWidget), więc ten dalej dostaje swoje dane; jego wydruk jest pomijany

W `~/.claude/settings.json`:

```json
"statusLine": {
  "type": "command",
  "command": "node <ścieżka>/statusline/statusline.mjs --chain \"<poprzednia komenda status line>\""
}
```

## Ograniczenia

- Bez status line'a z tego repo moment wygaśnięcia cache to szacunek: ostatnia odpowiedź + TTL. Ze skryptem mod czyta dokładną godzinę od Claude Code.
- Subagenci mają własny cache; licznik dotyczy głównej rozmowy. Po `/clear` i kompaktowaniu licznik startuje od nowa.
- Procent liczony jest względem okna autokompaktowania, bo to ono decyduje, kiedy zrobi się ciasno.

## Instalacja

```
/plugin install context-gauge --marketplace DamianoCode/claude-context-gauge
```

Potwierdź dodanie marketplace (`y`) i wybierz zakres (domyślnie user).

### Bez instalacji

```
git clone https://github.com/DamianoCode/claude-context-gauge
claude --plugin-dir ./claude-context-gauge
```

## Rozwój

```
claude plugin validate .
claude plugin test .
```

Mod to moduł function hooks (`hooks/register.tsx`); przy `--plugin-dir` przeładowuje się po każdej zmianie pliku.

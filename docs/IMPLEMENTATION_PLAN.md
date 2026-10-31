# Fake It Till U Make It: Implementation Plan

Live team quiz. The host runs their own PowerPoint and starts each question from the admin panel. Every team answers on one phone. The app does not know about the PPT.

## The game

| Round | Name | Questions | Time | Options | Max points |
|---|---|---|---|---|---|
| 1 | Image Guess | 20 | 20 s | AI-generated / Real / Unknown / Real, but edited | 100 |
| 2 | Video Guess | 10 | 20 s | AI-generated / Real / Unknown / Real, but edited | 50 |
| 3 | Text Detective | 15 | 20 s | AI / Human / Mixed | 75 |
| 4 | The Fake Vault | 10 | 25 s | A / B / C / D | 50 |
| | **Total** | **55** | | | **275** |

Points use the number on the countdown when the answer reaches the server:

| 20 s rounds | 25 s round | Points if correct |
|---|---|---|
| 20–17 | 25–21 | 5 |
| 16–13 | 20–16 | 4 |
| 12–9 | 15–11 | 3 |
| 8–5 | 10–6 | 2 |
| 4–1 | 5–1 | 1 |
| 0 / timeout | 0 / timeout | 0 |

Wrong answers and timeouts get 0.

## Decisions

| # | Decision | Decided by |
|---|---|---|
| 1 | Next.js and Express run on Vercel; Supabase holds the data and sends the live signal | User |
| 2 | The admin generates one secret code per team, printed on the player card with a QR to the site | User |
| 3 | Phones show no scores during the game | User |
| 4 | No PPT in the app. One results page for announcing winners | User |
| 5 | Ranking: most points, then most correct answers, then least total time on correct answers | Claude, from the user's rule that timing breaks clashes |
| 6 | Round 3 is 20 s (the points sheet replaces the earlier 15 s). Round 4 is named The Fake Vault | User's points sheet |
| 7 | Results page shows the top 3 and the full ranking | Claude |
| 8 | An answer tapped just before 0 but arriving within 1 s after still counts, as 1 point | Claude |
| 9 | Lost phone: log in again with the secret code and exactly the same leader name; the old phone is logged out | Claude, same as Crypto Hunt |
| 10 | Changing an answer re-scores everyone instantly, since scores are worked out when read | Claude |
| 11 | Question order is the same for everyone. Each team's options are jumbled, staying the same for that phone after a reload | User, per-team order by Claude |
| 12 | Rounds 1 and 2 have four options. Only AI-generated and Real are ever correct. "Real, but edited" is Claude's choice for the related fourth option | User |

## How it is built, using the Crypto Hunt lessons

| Crypto Hunt problem | Fake It |
|---|---|
| One queue for all check-ins | An answer is one insert for that team. No shared row is written |
| Leaderboard rebuilt on most actions | Worked out only when the admin or results page reads it |
| Full leaderboard sent to every phone | Phones get one tiny "changed" signal, then read the shared question |
| Phones polling the database | The shared question is cached by the CDN, so 80 phones cost about one read |
| Live table updates | Off. Broadcast signal only |
| Fast retries | Waits grow each time, at random moments |
| Login checks on every page, players logged out in an outage | No Supabase Auth for players. A team token stays on the phone; an outage shows "Reconnecting" |
| Bots too fast to reproduce the crash | Bots play at human pace with real live connections |
| Nobody watching, no crash plan | Event sheet in `docs/EVENT_SHEET.md` |

Timing comes only from the database clock. Phones never report their own time.

Supabase holds only: `rounds`, `questions`, `games`, `question_runs`, `teams`, `answers`.

## Phases

| Phase | Work | Needs from the user | Status |
|---|---|---|---|
| P1 | Project setup, database, scoring, all Round 3 and 4 content | Nothing | In progress |
| P2 | Express backend: join, live question, answers, admin, results | Nothing | Planned |
| P3 | Phone screens: join, waiting, question, locked, time's up, final | Nothing | Planned |
| P4 | Admin panel and player cards: run game, edit questions and answers, teams, results, new game. Results page | Nothing | Planned |
| P5 | Local proof: scoring tests, cheating tests, real browser game, 80 bot screens at human pace | Nothing | Planned |
| P6 | Cloud setup on Supabase and Vercel | **Which Supabase account, and a Vercel login** | Planned |
| P7 | Cloud proof: 80 bot screens on the real site, a few real phones | **A few phones** | Planned |
| P8 | Event setup: print cards, final check | Nothing more: the 20 image and 10 video answers are in | Planned |

Round 1 and Round 2 answers are in migration 0003, and can be changed in the admin panel without any code change.

## UI rebuild (waiting for the user's approval of the player mockup)

Mockup: `docs/design/player-view.png`. Nothing below is applied until the user approves it.

**Direction:** a detective's case file. Made for a crew of four around one phone, reading fast under a timer, in a noisy hall.

| Part | Choice | Why |
|---|---|---|
| Colours | Ink background, one yellow accent, coral and mint answer blocks | Readable in a dim or bright hall. Tells the two answers apart at a glance |
| Fonts | Bricolage Grotesque for headings, JetBrains Mono for labels. Served by the app, not fetched from Google | Bold and characterful. Campus Wi-Fi can't delay them |
| Timer | Five blocks that drain, one per points band, next to the big countdown | Shows the speed scoring without showing any score |
| Answers | Full-width blocks, with icon and word, at least 48 px tall and 8 px apart | Easy to hit quickly. Colour is never the only signal |
| Motion | A stamp effect on "Answer locked", respecting reduced motion | One moment of delight, no slowdown |

| Step | Work | Files |
|---|---|---|
| U1 | New colours, fonts and shared pieces | `src/app/globals.css`, `src/app/layout.tsx` |
| U2 | Phone screens: join, waiting, all 4 question types, locked, time's up, final | `src/app/page.tsx` |
| U3 | Admin panel in the same look, kept dense and easy to scan | `src/app/admin/page.tsx` |
| U4 | Player cards (printable on white) and results page (readable from the back of the hall) | `src/app/admin/cards/page.tsx`, `src/app/results/page.tsx` |
| U5 | Recheck: browser game, phone widths, contrast, `agylite design check` | `scripts/bots/browser.ts` |

No game logic, backend or database changes.

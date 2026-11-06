# Fiesta pilot

Registration on phones, PIN entry, one touch game ("El Distinto") and touch diagnostics for the venue panels. Design spec: `DESIGN.md`.

## Two modes (chosen at build time)

| Mode | Backend | Used for |
|---|---|---|
| `server` (default) | Fastify + SQLite (`/api/*`) | Real event: roster in `data/guests.csv`, DB in `data/fiesta.db` |
| `static` (`--mode pages`, set in `vite.config.js`) | None. Roster from `src/data/demo-roster.json`, state in `localStorage` | GitHub Pages demo (shows a "Modo demo" badge) |

Static mode is demo only: any roster PIN logs in (phone and panel are different browsers), the 5-failures/30 s lockout is per screen and kept locally. Regenerate the roster JSON after editing the CSV: `npm run gen:demo` (deterministic PINs and tokens).

Both modes lock PIN attempts per **screen id** (random id kept in the panel's localStorage and sent with login), not per IP, because all venue panels share one public IP.

## Scripts

```
npm install
npm run dev            # Vite (HMR) + API server on :3000, /api proxied
npm start              # build (server mode) + serve dist and API; PORT env var, default 3000
npm run serve          # serve an existing dist/ without rebuilding
npm run build:pages    # static build, base /fiesta-juegos/ -> dist/
npm run preview:pages  # serve that build at http://localhost:4173/fiesta-juegos/
npm test
npm run reset          # deletes registrations and attempts, keeps the roster
```

Requires Node 24 (runs TypeScript directly, uses built-in `node:sqlite`). `VITE_BASE` sets the base path (default `/`).

## Routes (same in both modes)

| Page | What |
|---|---|
| `index.html` | Landing + registration |
| `ticket.html?t=<ticketToken>` | Ticket: envelope reveal, QR, PIN, download |
| `checkin.html?c=<checkinToken>` | Check-in: name only for the public; with a staff session, check in and deliver prize (never shows the PIN). The QR encodes this absolute URL |
| `play.html` | Panel app (1920x1080 stage scaled to fit): PIN, game menu, live overlays (pause, transition, raffle) |
| `diag.html` | Touch diagnostics |
| `admin.html` | Admin (server mode only): live control, guests + CSV import, games, prizes/ranking, raffle |

Server mode also redirects `/t/<token>`, `/c/<token>`, `/play`, `/diag`. API: `POST /api/lookup` (`{name}` -> `{found}`, no roster data), `POST /api/register` (`{name, dni, email}` -> `{status:'registered', ticketToken}` or `{status:'pending'}`), `GET /api/ticket/:token`, `POST /api/login` (`{pin, screenId}`), `POST /api/attempts` (`{session, game}`), `POST /api/attempts/:id/result`, `GET /api/live`, `GET /api/checkin/:token`, and `/api/admin/*` (see `server/admin.ts`).

Registration validates identity: the guest types their full name (normalized; the full name or any 2+ tokens of it match), then DNI and email, checked against `data/guests.csv` (`name,dni,email`, fictitious demo data). A mismatch is stored in `verification_request` (static mode: `localStorage`) and the UI sends the guest to the accreditation desk; re-submitting matching data returns the existing ticket. The mode is one constant, `VALIDATION_MODE` in `src/shared/identity.js` (`name_dni_email` default, or `name_only`).

## Admin

Set `ADMIN_PASSWORD` (env or `.env` via the systemd unit) to enable `/api/admin/*`; without it admin login returns 503. Staff log in on their phone with the same password and then scan ticket QRs. Every business rule (enabled games, order, prize threshold, max attempts per game, prize stock, transition text, raffle display time) is editable from the admin, with defaults in `src/shared/games.js`. Deploy: `deploy/README.md`.

## GitHub Pages

`npm run deploy:pages` builds the static demo and force-pushes `dist/` to the `gh-pages` branch (Pages source: branch `gh-pages`, root).

- Landing: `https://ggracis.github.io/fiesta-juegos/`
- Panel: `https://ggracis.github.io/fiesta-juegos/play.html`
- Touch diagnostics: `https://ggracis.github.io/fiesta-juegos/diag.html`

To deploy from CI instead, grant the token the `workflow` scope (`gh auth refresh -s workflow`), commit `.github/workflows/pages.yml` and switch Settings > Pages > Source to "GitHub Actions".

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
| `checkin.html?c=<checkinToken>` | Check-in placeholder (never shows the PIN); the QR encodes this absolute URL |
| `play.html` | Panel app (1920x1080 stage scaled to fit) |
| `diag.html` | Touch diagnostics |

Server mode also redirects `/t/<token>`, `/c/<token>`, `/play`, `/diag`. API: `GET /api/guests/search?q=`, `POST /api/register`, `GET /api/ticket/:token`, `POST /api/login` (`{pin, screenId}`), `POST /api/attempts`, `POST /api/attempts/:id/result`.

## GitHub Pages

`npm run deploy:pages` builds the static demo and force-pushes `dist/` to the `gh-pages` branch (Pages source: branch `gh-pages`, root).

- Landing: `https://ggracis.github.io/fiesta-juegos/`
- Panel: `https://ggracis.github.io/fiesta-juegos/play.html`
- Touch diagnostics: `https://ggracis.github.io/fiesta-juegos/diag.html`

To deploy from CI instead, grant the token the `workflow` scope (`gh auth refresh -s workflow`), commit `.github/workflows/pages.yml` and switch Settings > Pages > Source to "GitHub Actions".

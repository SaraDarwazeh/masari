# Masari

Masari is a private, Arabic-first personal finance and ideas PWA. It combines expense tracking, budgeting, subscriptions, debts, savings goals, wishlist planning, voice-captured ideas, and optional Claude-powered analysis in a self-hosted app backed by SQLite.

The project is intentionally small and deployable: a static mobile-first frontend, a Node.js/Express API, SQLite persistence, Docker packaging, and a service worker for offline app-shell caching.

## Screenshots

Add screenshots to `docs/screenshots/` with the filenames below before publishing the repository.

| Home dashboard | Analytics | Ideas |
| --- | --- | --- |
| `<docs/screenshots/home.png>` | `<docs/screenshots/analytics.png>` | `<docs/screenshots/ideas.png>` |

| Goals and wishlist | Settings | Mobile PWA |
| --- | --- | --- |
| `<docs/screenshots/goals-wishlist.png>` | `<docs/screenshots/settings.png>` | `<docs/screenshots/mobile-pwa.png>` |

After adding the image files, replace the placeholders with:

```md
| ![Home dashboard](docs/screenshots/home.png) | ![Analytics](docs/screenshots/analytics.png) | ![Ideas](docs/screenshots/ideas.png) |
```

## Features

- Arabic RTL interface designed for mobile use and iOS home-screen installation.
- PIN-based single-user authentication with bcrypt password hashing.
- Expense and income tracking with categories, notes, dates, monthly history, and quick filters.
- Analytics dashboard with monthly summaries, category breakdowns, trend charts, and rule-based insights.
- Budgets per spending category with progress indicators and warnings.
- Subscription tracker with monthly/yearly normalization and trial labels.
- Debt tracking for money owed by or to the user.
- Savings goals with contribution tracking.
- Wishlist with image upload and client-side image compression.
- Ideas workspace with typed or voice-captured notes, status cycling, and optional AI analysis.
- JSON export/import for app-level backups.
- Offline app shell through a service worker while keeping `/api/*` financial data network-only.
- Dockerized deployment with persistent SQLite storage in a Docker volume.

## Tech Stack

| Layer | Technology |
| --- | --- |
| Frontend | HTML, CSS, vanilla JavaScript, PWA manifest, service worker |
| Backend | Node.js, Express |
| Auth | `express-session`, HTTP-only cookies, `bcryptjs` |
| Database | SQLite via `better-sqlite3`, WAL mode enabled |
| Deployment | Docker, Docker Compose, optional VPS deploy script |
| AI integration | Optional Anthropic Claude Messages API key configured by the user |

## Architecture

```txt
public/
  index.html              # Single-page RTL PWA UI and client-side state logic
  sw.js                   # Offline app-shell cache, API requests intentionally excluded
  manifest.webmanifest    # Installable PWA metadata

server/
  server.js               # Express API, sessions, auth, SQLite persistence
  package.json            # Runtime dependencies

Dockerfile                # Production container image
docker-compose.yml        # App service + persistent SQLite volume
deploy.sh                 # rsync + remote Docker Compose deployment helper
```

The backend exposes a very small API surface:

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/status` | Check setup and session state |
| `POST` | `/api/setup` | Create the first PIN/password hash |
| `POST` | `/api/login` | Authenticate and create a session |
| `POST` | `/api/logout` | Destroy the current session |
| `POST` | `/api/change-password` | Rotate the PIN/password |
| `GET` | `/api/state` | Load the authenticated user's app state |
| `PUT` | `/api/state` | Persist the authenticated user's app state |

## Data Model

Masari uses SQLite with two tables:

- `auth`: stores the single-user password hash.
- `state`: stores the application state as JSON, including transactions, subscriptions, debts, goals, ideas, wishlist items, budgets, preferences, and optional AI settings.

This keeps the app easy to back up, migrate, and self-host. SQLite WAL mode is enabled for better reliability during normal read/write usage.

## Security Notes

- The PIN/password is never stored in plaintext; it is hashed with bcrypt.
- Sessions use HTTP-only cookies through `express-session`.
- Login attempts are rate-limited in memory: five failed attempts trigger a short cooldown.
- In production, cookies are marked `Secure` when `NODE_ENV=production`, so the app should run behind HTTPS.
- API routes that read or mutate state require an authenticated session.
- The optional Claude API key is stored inside the user's app state. A stronger production design would proxy Claude calls through the backend instead of calling the API directly from the browser.

## Local Development

Create an environment file:

```bash
cp .env.example .env
```

Set a real session secret:

```bash
openssl rand -hex 32
```

For local HTTP development, set:

```env
NODE_ENV=development
```

Run with Docker Compose:

```bash
docker compose up -d --build
```

Open:

```txt
http://localhost:4471
```

The first visit creates the PIN/password. Later visits require login.

## Deployment

The app is designed to run as a single Docker service:

```bash
docker compose up -d --build
```

Production deployment should place a reverse proxy with HTTPS in front of the container, for example nginx or Caddy.

Example nginx location:

```nginx
server {
    server_name masari.example.com;

    location / {
        proxy_pass http://127.0.0.1:4471;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

The included `deploy.sh` script can sync the project to a VPS and rebuild the container remotely. Configure `VPS_USER`, `VPS_HOST`, and `VPS_PATH` before using it.

## Backups

Masari supports two backup paths:

- In-app JSON export/import from the settings screen.
- SQLite file backup from the Docker volume:

```bash
docker compose exec masari sh -c "cat /data/masari.db" > masari-backup-$(date +%F).db
```

## PWA Behavior

The service worker caches the static app shell and font assets. Financial API requests are intentionally excluded from caching so saved data is always fetched from the server.

On iOS, open the deployed URL in Safari and use:

```txt
Share -> Add to Home Screen
```

## Engineering Trade-offs

Masari favors a compact self-hosted architecture over a complex multi-service setup. The app keeps state in one JSON document because it is single-user, easy to back up, and simple to evolve. If the project became multi-user or collaborative, the next step would be normalizing transactions, goals, wishlist items, and ideas into separate relational tables with row-level ownership.

The frontend is intentionally framework-free. That keeps the deployed artifact small and easy to host, while still demonstrating PWA behavior, authenticated API integration, client-side image compression, voice input, SVG chart rendering, and Arabic RTL UI design.

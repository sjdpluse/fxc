# FXC — Trading Calendar

A responsive, English-language trading journal for recording closed trades and reviewing daily profit and loss. Built with native JavaScript modules, HTML, CSS, and the official Supabase client. Supports both a local journal and private cloud accounts.

![FXC trading calendar with clearly labeled sample data](docs/preview.jpg)

## Features

- Monthly calendar: **green** for profitable days, **red** for losing days, and **navy** for days without trades. Break-even trading days use a separate slate color.
- Daily net P&L and trade counts, with weekly totals for the displayed month.
- Add, edit, and delete trades, with a date, instrument, long/short direction, gross P&L, fees, and notes.
- Multiple trades per day are combined. **Net P&L = gross P&L − fees.** Enter fees as a positive amount; if your broker's P&L already includes fees, leave fees at zero.
- Monthly net P&L, trade win rate, active trading days, profit factor, and cumulative monthly performance chart.
- Searchable trade history with pagination and CSV export.
- JSON backups with validated merge or explicit full restore. Re-importing identical records does not duplicate them.
- Separate, temporary demo workspace. Your journal starts empty; demo trades never enter your personal journal automatically.
- Responsive desktop and mobile layouts, keyboard calendar navigation, and accessible native dialogs.
- Default journal timezone: **Asia/Kabul**. Preferences can change how Today and new trade dates are determined. Existing dates remain as entered.
- Email/password accounts with immediate sign-in after signup, password recovery, and cloud persistence in the existing Supabase project.
- Private per-user trade access enforced by PostgreSQL Row Level Security. Anonymous visitors cannot read or write FXC cloud records.
- Explicit migration of this device's local trades into the signed-in account. The original local journal stays intact.
- Installable Android PWA with a Settings install action, standalone app window, and offline caching of public app-shell assets only.
- Compact Settings and Sign in controls in the header; signed-in users see a profile icon. No sign-in or connection banner covers the calendar.
- Transactional cloud saves with revision checks: stale devices must refresh and review their draft instead of overwriting a newer journal.

## Install on Android

Open the deployed HTTPS site in Chrome on Android, then open **Settings → Install app**. When Chrome provides its native installation prompt, this button opens it. If the prompt is unavailable, FXC explains how to use Chrome’s menu → **Install app** or **Add to Home screen**. The app launches in a standalone window with its own FXC icon. This is a PWA installation, not an APK download or Play Store listing.

The manifest, 192px/512px icons, maskable icon, and service worker are included in the production build. The worker caches only exact public app-shell URLs; it never intercepts Supabase requests, authenticated requests, query-string callbacks, or mutations. Cloud data still needs internet access. The local journal works offline after the shell is cached. Closing and reopening the app allows a waiting service-worker update to activate.

## Run locally

Requires Node.js 22 or later. Install the exact versions from the committed lockfile:

```sh
npm ci
npm run dev
```

Open `http://localhost:3000`. Set `PORT` if another port is needed. ES modules require an HTTP server; do not open `index.html` directly using a `file://` URL.

## Verify and build

```sh
npm test
npm run check
npm run build
```

The production build is written to `dist/` and includes a locally bundled Supabase client; no CDN is required. Upload that directory to any static web host. Asset URLs are relative, so the build also supports a subdirectory such as `/fxc/`.

### Vercel

Import this repository into Vercel. The included `vercel.json` sets the build command to `npm run build`, the output directory to `dist`, and a Content Security Policy allowing this Supabase project's API. The connected project's public URL and publishable key are already configured in `src/cloud-config.js`; no service-role or secret key is included. The included FXC migrations have been applied to the configured project. For a different project, apply those migrations before using cloud storage.

### GitHub Pages

Build the project, then publish the contents of `dist/` using your preferred Pages deployment workflow. This repository does not automatically enable Pages or publish your journal.

## Data and calculation details

All amounts are entered and displayed in **USD**. Money is stored as integer cents to avoid decimal rounding errors. Daily colors and all statistics use net results after fees. Win rate is winning trades divided by all trades, including break-even trades. Profit factor is the sum of positive net results divided by the absolute sum of negative net results; it displays `∞` when gains exist without losses and `—` when neither exists. Weekly totals exclude dates outside the selected month. The performance chart begins at zero each month and is cumulative P&L, not an account balance or a compounded return.

Instrument names are labels, not contract specifications. For example, MNQ and US100 are distinct instruments; this app records the realized USD result you enter and does not assume their tick values are the same or calculate position sizing.

## Backups and privacy

**Local mode:** Records remain in `localStorage` under `fxc.journal.v1`, on this browser and this website origin only. They do not sync automatically. Clearing browser data removes local records. Unreadable local data is preserved and can be downloaded as a recovery file before restoring a valid backup.

**Cloud mode:** Click **Sign in** next to the Settings icon, then create an account or use an existing Supabase email/password account. The connected project has email confirmation disabled, so new accounts receive a session immediately. After signing in, the control becomes a profile icon. While signed in, successful saves go to `public.fxc_trades` and `public.fxc_journals` in project `cvernmhpnsgdtegvblyc`. Signing in on another device loads that account's journal. Use **Refresh** to fetch changes made elsewhere. This is explicit refresh synchronization, not live realtime or offline write queuing.

In your **Profile**, use **Import this device's trades** to copy the local journal into the current account. Identical entries are skipped; conflicting IDs require review. Signing out returns to the separate local journal. Demo data is never uploaded. Cloud trades are kept in page memory, not copied into the local journal. The Supabase SDK persists the account session in browser storage; signing out of FXC removes this device's session.

Cloud saves are acknowledged only after the database transaction succeeds. A revision conflict or uncertain network write requires **Refresh** before retrying; forms are preserved. Concurrent edits are not silently merged. A failed cloud save is never reported as a successful local or cloud save.

Anyone who can use your browser profile can access your local journal and any active account session. Keep JSON backups independently of the database; the existing project's Free plan does not include automatic database backups. CSV is intended for viewing history; JSON is the supported restore format.

### Signup and password recovery

Email confirmation is disabled in the connected project (verified through its public Auth settings). No confirmation step is required for new signups. The signup handler accepts the returned session and immediately opens the account’s journal. The project’s existing password-recovery email settings and redirect URLs are preserved. Older confirmation links are still supported for accounts created before this setting changed. If an email link opens a different website, open **Account → Have a confirmation or recovery link?** and paste the original Supabase verification link from that email. FXC accepts only links belonging to the configured project. Recovery links lead to a new-password form. This avoids changing redirect settings shared by the project's other applications. Actual email delivery depends on the project's SMTP configuration and provider limits.

Backups support up to 10,000 trades, notes of up to 2,000 characters, and trade dates from 1900 through 2100. Exported files contain your trade notes and results; keep them private. Import validates the entire file before applying any changes. A conflicting trade ID requires an explicit replacement rather than silently overwriting an edited trade.

## Source layout

- `src/domain.js` — dates, exact money parsing, aggregation, validation, and sample data.
- `src/storage.js` — persistence and safe backup merging.
- `src/cloud-config.js` — public project configuration; never place secret keys here.
- `src/cloud.js` — official Supabase client and email-link verification.
- `src/cloud-store.js` — validated cloud records, concurrency protection, and account isolation in the client.
- `src/app.js` — UI, journal actions, downloads, and calendar interactions.
- `tests/journal.test.js` — calculation, calendar, backup, and persistence checks.
- `tests/cloud-store.test.js` — cloud failures, concurrent devices, account changes, and safe retries.
- `tests/database-security.sql` — transactional integration assertions for RLS, validation, and concurrency. Test fixtures are rolled back.
- `scripts/fxc-schema.sql` — reviewed source for the FXC-only database migration; it is not run on every app build.
- `supabase/migrations/` — exact migration versions deployed to the configured project.
- `docs/supabase-integration.md` — verification evidence, shared-project findings, and email-delivery limitations.
- `src/pwa.js` — user-initiated installation and installed-state detection.
- `src/service-worker.js` — public app-shell offline policy; the built `sw.js` is generated and ignored in source control.
- `scripts/generate-worker.mjs` — content-hashed shell cache and exact asset list.
- `tests/pwa.test.js` — installation lifecycle and private-request cache exclusions.
- `scripts/` — preview, SDK bundling, build, and schema reference.

The preview/build scripts use esbuild to bundle the pinned Supabase SDK. No trading recommendations, market data, automated trades, or economic news are provided.

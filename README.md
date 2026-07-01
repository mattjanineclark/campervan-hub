# 🚐 Adventure Hub — Family Campervan App

## Quick start

```bash
npm install
npm run dev
```

Then open http://localhost:5173/campervan-hub/

Default PIN for all families: **0000** — change in Settings after first login.

## Deploy to GitHub Pages

```bash
npm run deploy
```

Then go to your repo → Settings → Pages → set source to `gh-pages` branch.

Your app will be live at: `https://YOUR_USERNAME.github.io/campervan-hub/`

## Supabase (optional — for data sync between families)

1. Create a project at supabase.com
2. Copy `.env.example` to `.env`
3. Fill in your Project URL and anon key
4. Run the SQL from the setup guide to create tables

## Tech stack
- React 18 + Vite
- Leaflet.js (maps)
- OpenStreetMap / Nominatim (place search)
- Supabase (database sync — optional)

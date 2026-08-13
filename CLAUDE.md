# Flag Studio

Internal design tool for creating golf tournament flag and hole sign packages.

## Stack

- **Vite multi-page app** — vanilla JS, no framework (React/Vue/etc are not used and should not be added)
- **Supabase** — auth, Postgres, Storage, edge functions
- **CSS** — custom properties in `style.css`, no CSS framework

## Page map

Each HTML file is a Vite entry point with its own JS module:

| HTML | JS entry | Purpose |
|------|----------|---------|
| `index.html` | `landing.js` | Project hub — list/create/delete projects |
| `login.html` | `login.js` | Auth (email/password via Supabase) |
| `flags.html` | `main.js` | Flag designer (1541 lines — candidate for splitting) |
| `hole-signs.html` | `hs/app.js` | Hole sign designer |
| `project.html` | `project.js` | Project overview + export downloads |
| `review.html` | `review.js` | Customer-facing proof review |
| `order.html` | `order.js` | Order intake form |

Project ID always flows via `?project=<uuid>` URL param.

## Flag wizard (`main.js` / `flags.html`)

5 panels, shown one at a time via `goStep(n)`:
1. **Design style** — pick SVG flag template
2. **Colors** — assign colors to zones
3. **Logo library** — upload logos
4. **Variations** — build flag combinations (logos × placements)
5. **Gallery & export** — preview grid + ZIP/PDF download

State lives in `src/state.js` → `S` object. Mutations call `markDirty()`, saved to Supabase via `saveFlagConfig()`.

## Hole sign editor (`hs/` modules)

3 panels via `goStep(n)`:
1. **Design** — template, background, text, banners, template logos (`hs/design.js`)
2. **Variations** — per-variation sponsor logos (`hs/variations.js`)
3. **Gallery & export** — proof sheet preview + download (`hs/export.js`)

State lives in `hs/state.js` → `HS` (persistent config) and `UI` (ephemeral UI). Any module can mutate both by reference — do not use ES module `export let` for shared mutable state.

Key: `getEffectiveState(variation)` merges global `HS` → variation override → active editing draft for rendering.

## Supabase schema (tables)

- `projects` — top-level project records
- `flag_config` — flag designer state (colors, variations, logo assignments) per project
- `hole_sign_config` — hole sign designer state (template, variations) per project
- `project_logos` — uploaded logo metadata; files in `flag-logos` storage bucket
- `order_intakes` — order form submissions
- `variation_feedback` — customer feedback on proofs (realtime subscribed in editors)

Storage buckets: `flag-logos` (logo uploads, public), `renders` (legacy, holds a few historical objects — not written to by any current code path), `print-sheets` (admin-generated print-ready PDFs, private — signed URLs only, 7-day expiry).

Edge functions: `send-order-confirmation`, `send-proof-ready`, `send-print-sheet-ready` (email, SendGrid), `send-prestige-order` (internal), `sweep-abandoned-drafts` (daily cron — see memory for abandoned-draft cleanup).

## Rendering

- **100% client-side**: `render.js` (flags), `hole-sign-render.js` (hole signs) handle previews; the export-time rasterization in `src/flags/gallery.js` (`rasterizeForPrint`/`buildPrintZip`) and `src/hs/export.js` (`buildHsPrintZip`) handles print-quality PDF sheets. There is no server-side rendering pipeline — `send-print-sheet-ready` only emails a link to an already-rendered file the client uploaded; it never renders anything itself.
- Flag SVG templates live in `public/flags/*.svg`. Zones are `<g id="logo-placement">` children; colors are CSS custom properties injected via `<style>`.

## Conventions

- `window.xyz = function` for functions called from inline HTML `onclick` handlers
- Color inputs always paired: `<input type="color">` swatch + hex text input + optional eyedropper button (see `eyedropperBtn()` in `hs/state.js`)
- Dirty state tracking: `markDirty()` / `markClean()` gates the save button UI
- No TypeScript. No build-time type checking.

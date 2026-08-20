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

## Permissions & roles

`profiles.role` is `customer` (default) / `staff` / `admin` (CHECK-constrained). Role changes only happen through `grant_role()` (admin-only, audit-logged to `role_grants`); a trigger blocks direct `UPDATE ... SET role`.

**Two independent axes — don't conflate them:**
- **Ownership** (`owns_project()` = `created_by = auth.uid()`) — every owner-scoped RLS policy is `owns_project(project_id) OR is_staff_or_admin()`.
- **Role** — today, `role` only grants staff/admin the OR-branch to act on projects they don't own. A `customer`-role user who owns a project already has full CRUD on it, identical to staff, because ownership isn't itself restricted by role. If a feature needs to restrict what an owner can do *within their own project* (not just gate cross-project access), that's a new condition, not something `owns_project()` gives you for free.

**Three-layer enforcement model — only the first layer is real:**
1. **RLS / storage policies** — the actual boundary. Every policy reuses the `is_staff_or_admin()` security-definer helper (`supabase/migrations/20260811030000_owner_scoped_rls.sql`); a new staff/admin-only resource should add a policy in this same shape, not invent a new check.
2. **Edge functions** — for anything privileged that isn't a plain table write, re-derive role server-side from the caller's JWT (see `send-print-sheet-ready` / `sendPrintSheetReady()` in `src/supabase.js`). Never trust a client-supplied role claim.
3. **Client UI** (`isStaffOrAdmin()` in `src/auth.js`, `UI.isStaffOrAdmin` in `hs/state.js`) — hides/shows buttons only. Explicitly documented in-code as "UI-convenience gate only." Assume nothing it hides is actually protected unless layer 1 or 2 also blocks it.

**Reference implementation of an admin-only feature end to end:** the "email print-sheet link" flow — `print-sheets` storage bucket RLS requires `is_staff_or_admin()` with no ownership branch at all (`supabase/migrations/20260812030000_print_sheets_storage.sql`), `uploadPrintSheet()` relies on that RLS to reject non-staff, and `sendPrintSheetReady()` forwards the real JWT so the edge function re-derives role itself.

**Dormant scaffolding already in the schema, not yet wired to any feature:**
- `projects.status` (default `'draft'`) — currently set once at creation and never transitioned by any code path. Natural column for a submit/review/lock workflow.
- `admin_actions` table — RLS already restricts insert/select to staff/admin (`granted` in the baseline migration), but no client code writes to it yet. Built for an admin audit trail (approvals, print-sends, etc.) that doesn't exist yet.
- `flag_config.status` / `hole_sign_config.status` — same pattern as `projects.status`, always `'draft'`, unused.
- Realtime-subscribed tables (`flag_config`, `hole_sign_config`, `variation_feedback`) need a real table-level RLS *select* policy, not an RPC-gated check — Realtime subscribes to the table directly and can't go through a function call.

### Planned: submission/review workflow (not yet built)

Goal: once a customer submits a project, they can't edit it until staff reviews it. Design, not yet implemented:

- States on `projects.status`: `draft` → `submitted` → `needs_changes` (staff kicks back) or `approved` (staff signs off).
- New helper `project_is_editable(project_id)` (same shape as `is_staff_or_admin()`): true when status is `draft`/`needs_changes`.
- Owner-scoped update policies (`flag_config`, `hole_sign_config`, `project_logos`) become `(owns_project(project_id) AND project_is_editable(project_id)) OR is_staff_or_admin()`.
- Status transitions go through RPCs, not raw column updates — same reasoning as `grant_role()` vs. direct `profiles.role` writes: `submit_project_for_review(project_id)` (owner-only, requires current status draft/needs_changes) and `review_project(project_id, decision, note)` (staff/admin-only, sets approved/needs_changes, logs to the already-scaffolded-but-unused `admin_actions` table).
- **Decided:** staff editing a submitted/approved project does NOT auto-flip its status — edits are silent, no forced reset to `needs_changes`. Staff uses the same designer flow as the customer, no separate "admin edit mode."
- Admin overview: extend `project.html`/`project.js` (already loads flag/hole-sign config + intake + customer info in one place) with role-branched UI — staff sees approve/request-changes + download/send-to-print + an `admin_actions` activity log; customers see a "Submit for review" button instead. Not a new page.
- Admin fast-path project creation already exists: `landing.js`'s "+ New project" bypasses `order.html`'s customer intake form entirely.

## Rendering

- **100% client-side**: `render.js` (flags), `hole-sign-render.js` (hole signs) handle previews; the export-time rasterization in `src/flags/gallery.js` (`rasterizeForPrint`/`buildPrintZip`) and `src/hs/export.js` (`buildHsPrintZip`) handles print-quality PDF sheets. There is no server-side rendering pipeline — `send-print-sheet-ready` only emails a link to an already-rendered file the client uploaded; it never renders anything itself.
- Flag SVG templates live in `public/flags/*.svg`. Zones are `<g id="logo-placement">` children; colors are CSS custom properties injected via `<style>`.

## Conventions

- `window.xyz = function` for functions called from inline HTML `onclick` handlers
- Color inputs always paired: `<input type="color">` swatch + hex text input + optional eyedropper button (see `eyedropperBtn()` in `hs/state.js`)
- Dirty state tracking: `markDirty()` / `markClean()` gates the save button UI
- No TypeScript. No build-time type checking.

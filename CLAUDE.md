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
| `upload-logos.html` | `upload-logos.js` | Public post-order logo upload (no login required) |

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
- `admin_actions` — review-workflow audit trail (submit/request-changes/send-proof/approve/reject/sent-to-print), see "Submission/review workflow" below

Storage buckets: `flag-logos` (logo uploads, public), `renders` (legacy, holds a few historical objects — not written to by any current code path), `print-sheets` (admin-generated print-ready PDFs, private — signed URLs only, 7-day expiry).

Edge functions (SendGrid email unless noted): `send-order-confirmation`, `send-order-notification` (internal, order submitted), `send-logo-upload-notification` (internal, logos added via `upload-logos.html`), `send-proof-ready`, `send-print-sheet-ready`, `send-review-decision` (internal, client approved/rejected a proof), `send-prestige-order` (internal); `sync-event-info` (GolfStatus event-page scrape, not email); `sweep-abandoned-drafts` (daily cron — see memory for abandoned-draft cleanup).

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

**Remaining dormant scaffolding:**
- `projects.status` — no longer written to by any code path as of `20260913000000_per_design_status_workflow.sql` (superseded by the per-design columns below); left in place as unmaintained historical data rather than dropped.
- Realtime-subscribed tables (`flag_config`, `hole_sign_config`, `variation_feedback`) need a real table-level RLS *select* policy, not an RPC-gated check — Realtime subscribes to the table directly and can't go through a function call.

### Submission/review workflow

Once a customer submits a design, they can't edit it until staff reviews it. Flags and hole signs progress independently (a project can have flags in `proof_sent` while hole signs is still `draft`), so this is two parallel per-design state machines, not one project-level status:

- States live on `flag_config.status` / `hole_sign_config.status`: `draft` → `submitted` → `needs_changes` (staff kicks back) or `proof_sent` (staff sends a proof) → `approved` (client signs off) → `sent_to_print`.
- `design_is_editable(project_id, product_type)` gates the owner branch of `flag_config`/`hole_sign_config` update RLS. `project_has_unlocked_design(project_id)` (true unless *either* design is currently locked) gates `projects` update RLS and the owner branch of `project_logos` insert/delete — the anon/ownerless branch of `project_logos` insert also requires it as of `20260926000000_project_logos_ownerless_requires_unlocked.sql`, so `upload-logos.html`'s public post-order upload link (see "Page map") stops working once a design is under review.
- A trigger (`prevent_design_status_self_update`) blocks any raw client update to `status` — only six `SECURITY DEFINER` RPCs can move it, each re-implementing its own permission + precondition checks and logging to `admin_actions` (nullable `admin_id`/`admin_email`/`product_type`, so both staff-triggered and anonymous/client-triggered rows fit the same shape): `submit_design_for_review`, `admin_request_design_changes`, `admin_send_design_proof` (mints `share_token`/`proof_shared_at` on first send; also covers resend/reshare), `client_approve_design_proof` / `client_reject_design_proof` (anon, share-token-gated — called from `review.js`), `admin_mark_design_sent_to_print`. Same reasoning as `grant_role()` vs. a direct `profiles.role` write.
- The share link stays one per *project*, not per design type — `review.html` shows both tabs behind the same token.
- **Decided:** staff editing a submitted/approved design does NOT auto-flip its status — edits are silent, no forced reset to `needs_changes`. Staff uses the same designer flow as the customer, no separate "admin edit mode."
- UI lives in `project.js`'s existing tool cards, not a separate page: staff sees Request changes / Send proof / Mark sent to print (role-branched in `renderToolCardStatus`, plus a Submit-on-customer's-behalf button for `draft`-status admin-created projects that have no separate customer to submit); customers see `renderCustomerDesignBody`'s status text and a Submit/Resubmit button. `window.submitForReview` is shared by both paths. There's no rendered `admin_actions` timeline/activity log yet — it's only queried ad hoc for a single latest row (`loadLatestChangeNote` for the kickback reason, `loadLatestPrintAction` for the last-sent timestamp).
- Admin fast-path project creation already exists: `landing.js`'s "+ New project" bypasses `order.html`'s customer intake form entirely.

## Rendering

- **100% client-side**: `render.js` (flags), `hole-sign-render.js` (hole signs) handle previews; the export-time rasterization in `src/flags/gallery.js` (`rasterizeForPrint`/`buildPrintZip`) and `src/hs/export.js` (`buildHsPrintZip`) handles print-quality PDF sheets. There is no server-side rendering pipeline — `send-print-sheet-ready` only emails a link to an already-rendered file the client uploaded; it never renders anything itself.
- Flag SVG templates live in `public/flags/*.svg`. Zones are `<g id="logo-placement">` children; colors are CSS custom properties injected via `<style>`.
- **One canonical hole-sign renderer — `makeHoleSignSvg`/`renderHoleSignInto` (`hole-sign-render.js`)**: every consumer (interactive canvas, Variations sidebar thumbnail, Gallery grid, print export, customer review page) must produce content by calling this shared builder with `getEffectiveState(v)`/`getEffectiveVariation(v)` — never by special-casing a content type (a new upload kind, a new frame element) per call site. A caller that bypasses the shared builder for one content type (e.g. painting an artboard image directly instead of through `makeHoleSignSvg`) will silently drift from what the canvas shows the moment that content type needs to interact with anything else the builder composes (banners, template logos). The interactive canvas (`var-canvas.js`) is the one legitimate exception — it renders through the same builder, then re-parents the resulting `.hs-frame` group into its own DOM overlay so the draggable logo (a plain DOM element, not part of the SVG) can stack correctly against it; it does not reimplement any layering decision itself. See `test/render-parity.spec.js`, which pins this invariant down for exactly the bug class (an artboard hiding the frame, non-unique SVG ids) that motivated this rule.

## Conventions

- `window.xyz = function` for functions called from inline HTML `onclick` handlers
- Color inputs always paired: `<input type="color">` swatch + hex text input + optional eyedropper button (see `eyedropperBtn()` in `hs/state.js`)
- Dirty state tracking: `markDirty()` / `markClean()` gates the save button UI
- No TypeScript. No build-time type checking.

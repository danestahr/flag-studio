# Hole Sign Editor — New User UX Audit

Pain points and unintuitive moments a first-time user would encounter, organized by flow stage.

---

## Onboarding / First impression

1. **No explanation of what a "hole sign" is** — a first-time user has no context before being dropped into the template picker. A one-liner ("Sponsor signs displayed at each tee box — one design per hole") would orient them.
2. **Template descriptions don't explain trade-offs** — "Logo only" and "Standard" sound similar. Users need to know what they're giving up (text support, template logos, etc.) before choosing.
3. **No back button from the template picker** — once you pick a template and start designing, there's no obvious way to go back and try a different one without knowing about the Template menu item inside step 1.

---

## Step 1 — Design

4. **The canvas is interactive but nothing indicates that** — no hover states, tooltips, or instructions tell the user they can click text to edit inline or drag template logo slots around.
5. **"Template logos" is a confusing name** — this refers to recurring sponsor/partner logos that appear on every sign. "Header logos" or "Recurring sponsor logos" would be clearer.
6. **The Off / 1 / 2 / 3 count buttons don't explain what they're counting** — first-time users won't know if this means number of logo spots or something else.
7. **Double-tap on a canvas slot to open logo options is completely undiscoverable** — the only affordance is a small "Edit" hover button, which itself is easy to miss on touch or if the user doesn't hover first.
8. **"Position" (↑↓) vs "Alignment" icons** — the distinction between vertical position and horizontal alignment isn't explained anywhere. Users won't understand until they try each one.
9. **Click-to-edit text on the canvas is hidden** — tapping "Sponsored By" directly on the canvas edits it inline, but there's no prompt to do this. Users will look for a text input in the sidebar and not find it where they expect.
10. **Banners are conceptually unclear** — the word "banner" has too many meanings (image banner, ad banner). Users may not expect a full-width colored strip for text. The controls are also very deep (enable → height → background → text → sub-text).
11. **"Save draft" vs auto-save ambiguity** — there is auto-save on step transitions, but no indication of this. Users who don't click "Save draft" will worry their work is lost.
12. **Zoom is keyboard-shortcut-only** — "⌘ + scroll to zoom" doesn't help mobile or trackpad-only users. No pinch-to-zoom, and the hint is easy to miss.

---

## Step 2 — Variations

13. **"Variations" is an abstract concept** — it means "one sign design per sponsor." The sub-label "Sponsor logos" helps, but the concept of a variation as a per-sponsor version isn't spelled out anywhere.
14. **Uploading a logo auto-creates a variation** — smart behavior, but it surprises users who expected to upload and then place manually. They end up with unexpected cards in the list.
15. **The library strip and variation cards look unrelated** — it's not obvious the strip is a logo bank you assign from, or that cards below represent final signs.
16. **Dragging a logo from the strip onto a variation card to replace it** — great feature, completely hidden. Users will try clicking instead.
17. **The floating toolbar (Fill / Remove BG / Remove / Replace)** — appears on tap, disappears when tapping elsewhere. Users may not know it exists if they don't tap the logo first.
18. **"Fill" button is unclear** — it means "auto-fit the logo to fill the available zone." Needs a tooltip or a clearer label like "Auto-fit."
19. **"Remove BG" has no explanation** — users may not know this is AI-powered background removal. No indication of what it does, that it takes time, or that it works best on images with a single subject.
20. **Canvas drag/resize handles for the sponsor logo are tiny** — only appear on hover. On touch, discoverability is low.
21. **The variation editor (overrides) is advanced with no onboarding** — entering "Edit" mode and the concept of per-variation overrides (template, background, text) is power-user territory. "Apply changes" and "Revert all overrides" are intimidating phrases.
22. **Sponsor text as an alternative to a logo is buried** — the option to type text instead of using a logo is inside the "Replace ▾" dropdown, which most users won't open when the zone looks empty.
23. **"Add default sign" is unexplained** — what is a default sign? (Pre-designed graphic for holes without a sponsor.) A new user will skip it entirely.
24. **Qty field is easy to miss** — it's inline in the variation card. Users may not notice it or understand why quantities are set here rather than at export.

---

## Navigation & general UX

25. **No undo** — deleting a variation, removing a logo, or changing a template is permanent with no way back.
26. **Step navigation with partial completion gives no feedback** — it's unclear whether you can or should jump steps, and there's no warning if you skip setting up variations before going to export.
27. **"← Projects" is the only escape route** — on mobile or when the header has scrolled out of view, users may feel trapped with no obvious way back to the project list.
28. **No empty-state guidance in step 2** — when the variation list is empty, the only prompt is plain text. No arrow, tooltip, or visual cue points at the upload button.
29. **The ✦ "Remove background" button in the lib strip communicates nothing** — the sparkle icon gives no indication of its function. Needs a label or tooltip.
30. **Export is invisible until step 3** — users don't know what they're building toward. A small preview of the output (proof sheet, ZIP of PNGs) on the first screen would give them a clear goal.

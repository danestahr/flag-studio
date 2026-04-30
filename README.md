# Flag Studio

Golf tournament flag configurator — multi-step tool for selecting flag styles, colors, uploading logos, building variations, and exporting print-ready files.

## Project structure

```
flag-studio/
├── flag-configurator.html   # Main single-file app (current working version)
├── public/
│   └── flags/               # SVG flag templates
│       ├── Edinburgh.svg
│       ├── Ascot.svg
│       └── Plain.svg
├── README.md
├── .gitignore
└── ROADMAP.md               # Next steps: Supabase + Google Sheets integration
```

## Current state

The configurator is a self-contained HTML/JS single file. It runs locally with no build step — just open in a browser.

**5-step flow:**
1. **Style** — choose Edinburgh, Ascot, or Plain flag layout
2. **Colors** — set master color scheme (preset palette + custom hex picker)
3. **Logo library** — upload multiple logos, drag into named drop zones on the flag
4. **Variations** — build multiple logo combinations on the same master
5. **Gallery** — swipe through all variations, export SVG or PNG per variation

**SVG flag specs:**
- All flags: `7519 × 4670px` viewBox (real print dimensions)
- Named color zones: `zone-primary`, `zone-secondary`
- Bleed marks: `#Bleed` group (non-colorable, display only)
- Logo zones defined in `FLAGS` data array with `x, y, w, h` in SVG units

## Running locally

```bash
# No build step needed — open directly
open flag-configurator.html

# Or serve with any static server
npx serve .
```

## Next steps

See `ROADMAP.md` for the full integration plan.

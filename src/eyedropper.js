// Browser eyedropper (Chrome/Edge ≥ 95) — shared between the flags and hole
// sign editors. Each editor wires the picked hex into its own color-state
// update, since flags routes through zone-based pickColor callbacks while
// hole signs sets an <input type=color> directly and dispatches `input`.
export const SUPPORTS_EYEDROPPER = typeof window !== 'undefined' && 'EyeDropper' in window;

const EYEDROPPER_SVG = `<i class="fa-solid fa-eye-dropper" aria-hidden="true"></i>`;

// `onclick` is the raw inline-handler JS expression, e.g. "cEyedrop('zone-1')".
export function eyedropperBtn(onclick) {
  if (!SUPPORTS_EYEDROPPER) return '';
  return `<button type="button" class="eyedropper-btn" onclick="${onclick}" title="Pick color from screen">${EYEDROPPER_SVG}</button>`;
}

// Opens the native eyedropper and resolves the picked hex, or null if
// unsupported / the user canceled.
export async function pickEyedropperColor() {
  if (!SUPPORTS_EYEDROPPER) return null;
  try {
    const r = await new window.EyeDropper().open();
    return r.sRGBHex;
  } catch {
    return null;
  }
}

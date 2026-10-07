// Per-variation hole numbering. A numbered variation carries one ordinary
// text layer flagged `holeNumber: true` showing the starting hole — so it is edited
// (drag, font, size, color) and reviewed like any other text layer. Only the
// export expands it: one flag per number, starting at `v.holeStart`, for
// `v.qty` flags (counting straight up, no wraparound).

export function holeNumberLayer(v) {
  return (v.textLayers || []).find(l => l.holeNumber) || null;
}

export function hasHoleNumbers(v) {
  return v.holeStart != null && !!holeNumberLayer(v);
}

// The layer displays the starting hole in the editor/review; export swaps in
// each flag's own number.
export function syncHoleNumberText(v) {
  const l = holeNumberLayer(v);
  if (l && v.holeStart != null) l.text = String(v.holeStart);
}

export function enableHoleNumbers(v, start = 1) {
  if (!Array.isArray(v.textLayers)) v.textLayers = [];
  v.holeStart = Math.max(0, parseInt(start, 10) || 1);
  syncHoleNumberText(v);
  if (holeNumberLayer(v)) return;
  v.textLayers.push({
    id: 'ftl-hole-' + Date.now(),
    holeNumber: true,
    text: String(v.holeStart),
    x: 30, y: 35, w: 40,
    fontSize: 14,
    font: 'dm-serif',
    color: '#000000',
    align: 'center',
  });
}

export function disableHoleNumbers(v) {
  delete v.holeStart;
  v.textLayers = (v.textLayers || []).filter(l => !l.holeNumber);
}

// One entry per physical flag. Un-numbered variations yield a single entry
// with `num: null` and the variation itself, so callers can iterate blindly.
export function expandHoleNumbers(v) {
  if (!hasHoleNumbers(v)) return [{ v, num: null }];
  const qty = Math.max(1, parseInt(v.qty, 10) || 1);
  return Array.from({ length: qty }, (_, i) => {
    const num = v.holeStart + i;
    return {
      num,
      v: {
        ...v,
        textLayers: v.textLayers.map(l => l.holeNumber ? { ...l, text: String(num) } : l),
      },
    };
  });
}

// Word-wrap text into lines that fit within `maxW`. Width estimated from
// font size — close enough for layout intent, the SVG renderer handles the
// actual glyph metrics. Shared by the flags and hole-sign static SVG
// renderers so wrapping matches what the live editor overlay shows.
export function wrapText(text, maxW, fontSize) {
  const charW = fontSize * 0.5;
  const maxChars = Math.max(1, Math.floor(maxW / charW));
  const results = [];
  // Split on explicit newlines first so Shift+Enter hard-breaks are honoured,
  // then word-wrap each paragraph independently.
  for (const para of String(text || '').split('\n')) {
    const words = [];
    para.split(/\s+/).filter(Boolean).forEach(w => {
      while (w.length > maxChars) { words.push(w.slice(0, maxChars)); w = w.slice(maxChars); }
      words.push(w);
    });
    if (!words.length) { results.push(''); continue; }
    let cur = words[0];
    for (let i = 1; i < words.length; i++) {
      const candidate = cur + ' ' + words[i];
      if (candidate.length <= maxChars) cur = candidate;
      else { results.push(cur); cur = words[i]; }
    }
    results.push(cur);
  }
  return results;
}

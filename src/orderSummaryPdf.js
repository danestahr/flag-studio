import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { supabase } from './supabase.js';

// ── Palette ────────────────────────────────────────────────
const HEADER_BG = rgb(0x23/255, 0x23/255, 0x23/255);
const GOLD  = rgb(0xC8/255, 0x97/255, 0x2A/255);
const BLACK = rgb(0x11/255, 0x11/255, 0x10/255);
const GRAY  = rgb(0x5A/255, 0x5A/255, 0x54/255);
const LGRAY = rgb(0xE8/255, 0xE8/255, 0xE4/255);
const WHITE = rgb(1, 1, 1);

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return rgb(parseInt(h.slice(0,2),16)/255, parseInt(h.slice(2,4),16)/255, parseInt(h.slice(4,6),16)/255);
}

function formatDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  const months = ['January','February','March','April','May','June',
    'July','August','September','October','November','December'];
  return `${months[m-1]} ${d}, ${y}`;
}

function today() { return formatDate(new Date().toISOString().slice(0, 10)); }

// ── Data loaders ──────────────────────────────────────────
async function loadCustomerData(projectId) {
  const [{ data: project }, { data: intake }] = await Promise.all([
    supabase.from('projects').select('name, customer_info').eq('id', projectId).single(),
    supabase.from('order_intakes').select('*').eq('project_id', projectId).maybeSingle(),
  ]);
  const ci = project?.customer_info && Object.keys(project.customer_info).length
    ? project.customer_info
    : intake || {};
  return { projectName: project?.name || '', ci };
}

async function loadApprovalStatus(projectId, productType) {
  const { data } = await supabase
    .from('variation_feedback')
    .select('status, resolved')
    .eq('project_id', projectId)
    .eq('product_type', productType);
  if (!data?.length) return null;
  const allApproved = data.every(f => f.status === 'approved' || f.resolved);
  const anyApproved = data.some(f => f.status === 'approved');
  if (allApproved) return { label: 'All variations approved', color: rgb(0.1,0.55,0.28) };
  if (anyApproved) return { label: 'Partially approved',      color: rgb(0.8,0.55,0.1)  };
  return                { label: 'Pending client review',     color: GRAY };
}

// ── Page chrome ───────────────────────────────────────────
const W = 612, H = 792, M = 48;
const HEADER_H = 60;  // header bar (56) + gold rule (4)
const CONTENT_TOP = H - HEADER_H - 20;   // y where content starts after header
const CONTENT_BOT = 36;                  // bottom margin

function drawHeader(page, bold, reg) {
  page.drawRectangle({ x: 0, y: H - 56, width: W, height: 56, color: HEADER_BG });
  page.drawText('FLAG STUDIO', { x: M, y: H - 36, size: 18, font: bold, color: WHITE });
  const sub = 'Order Summary';
  page.drawText(sub, { x: W - M - reg.widthOfTextAtSize(sub, 10), y: H - 36, size: 10, font: reg, color: rgb(1,1,1,0.65) });
  page.drawRectangle({ x: 0, y: H - HEADER_H, width: W, height: 4, color: GOLD });
}

function drawFooter() {}

// ── Layout state ──────────────────────────────────────────
// We carry a mutable cursor so content flows across pages naturally.
function makeCursor(doc, bold, reg) {
  let page;
  let y;

  function newPage() {
    page = doc.addPage([W, H]);
    drawHeader(page, bold, reg);
    drawFooter(page, reg);
    y = CONTENT_TOP;
    return page;
  }

  function ensureSpace(needed) {
    if (y - needed < CONTENT_BOT) newPage();
  }

  function current() { return page; }
  function getY() { return y; }
  function setY(v) { y = v; }
  function moveY(delta) { y += delta; } // negative = move down

  newPage(); // initialise first page

  return { newPage, ensureSpace, current, getY, setY, moveY };
}

// ── Drawing helpers ───────────────────────────────────────
function drawSectionHeader(cursor, title, font) {
  const size = 10;
  cursor.ensureSpace(size + 20);
  const page = cursor.current();
  const y = cursor.getY();
  page.drawRectangle({ x: M, y: y - 2, width: W - M * 2, height: size + 8, color: LGRAY });
  page.drawText(title.toUpperCase(), { x: M + 6, y, size, font, color: GRAY });
  cursor.setY(y - size - 14);
}

function drawRow(cursor, label, value, { labelFont, valueFont, size = 11 }) {
  const labelW = 120;
  const maxValW = W - M * 2 - labelW;
  const str = String(value || '—');

  // word-wrap value
  const words = str.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? line + ' ' + word : word;
    if (valueFont.widthOfTextAtSize(test, size) > maxValW && line) {
      lines.push(line); line = word;
    } else { line = test; }
  }
  if (line) lines.push(line);

  const blockH = lines.length * size * 1.5 + 4;
  cursor.ensureSpace(blockH);

  const page = cursor.current();
  let y = cursor.getY();
  page.drawText(label + ':', { x: M, y, size, font: labelFont, color: GRAY });
  for (const l of lines) {
    page.drawText(l, { x: M + labelW, y, size, font: valueFont, color: BLACK });
    y -= size * 1.5;
  }
  cursor.setY(y - 2);
}

// Two label:value entries on a single line, side by side — used to consolidate
// short fields (Event/Course, Contact/Email, etc.) so sections take fewer rows.
function drawRowPair(cursor, entries, { labelFont, valueFont, size = 10 }) {
  const colW = (W - M * 2) / 2;
  const labelW = 66;
  cursor.ensureSpace(size * 1.5 + 4);
  const page = cursor.current();
  const y = cursor.getY();
  entries.forEach((entry, i) => {
    if (!entry) return;
    const [label, value] = entry;
    const x = M + i * colW;
    page.drawText(label + ':', { x, y, size, font: labelFont, color: GRAY });
    page.drawText(String(value || '—'), { x: x + labelW, y, size, font: valueFont, color: BLACK });
  });
  cursor.setY(y - size * 1.5 - 2);
}

// Mirrors the wrapping in drawColorSwatchLine so callers can reserve the
// right amount of vertical space up front instead of assuming a single row.
function colorSwatchRowCount(colorEntries, valueFont, size = 9) {
  if (!colorEntries?.length) return 0;
  const sw = 8, gapAfterSwatch = 4, gapBetween = 16;
  const maxX = W - M;
  let rows = 1;
  let x = M;
  for (const entry of colorEntries) {
    const text = `${entry.label}: ${entry.name} ${entry.hex.toUpperCase()}`;
    const textW = valueFont.widthOfTextAtSize(text, size);
    const entryW = sw + gapAfterSwatch + textW;
    if (x !== M && x + entryW > maxX) {
      rows++;
      x = M;
    }
    x += entryW + gapBetween;
  }
  return rows;
}

// One line of small colour swatches + "Label #HEX" text, wrapping to a new
// line only if it overflows the content width (rare — most flags use 1-2 zones).
function drawColorSwatchLine(cursor, colorEntries, { valueFont, size = 9 }) {
  if (!colorEntries?.length) return;
  const sw = 8;
  const gapAfterSwatch = 4;
  const gapBetween = 16;
  const maxX = W - M;
  cursor.ensureSpace(size * 1.5 + 4);
  let page = cursor.current();
  let y = cursor.getY();
  let x = M;
  for (const entry of colorEntries) {
    const text = `${entry.label}: ${entry.name} ${entry.hex.toUpperCase()}`;
    const textW = valueFont.widthOfTextAtSize(text, size);
    const entryW = sw + gapAfterSwatch + textW;
    if (x !== M && x + entryW > maxX) {
      y -= size * 1.5;
      cursor.setY(y);
      cursor.ensureSpace(size * 1.5 + 4);
      page = cursor.current();
      y = cursor.getY();
      x = M;
    }
    page.drawRectangle({ x, y: y - sw + 6, width: sw, height: sw, color: hexToRgb(entry.hex), borderColor: LGRAY, borderWidth: 0.5 });
    page.drawText(text, { x: x + sw + gapAfterSwatch, y, size, font: valueFont, color: BLACK });
    x += entryW + gapBetween;
  }
  cursor.setY(y - size * 1.5 - 2);
}

// ── Main export ───────────────────────────────────────────
/**
 * @param {object} opts
 * @param {string}   opts.projectId
 * @param {string}   opts.productType   'flags' | 'hole-signs'
 * @param {Array}    opts.colorEntries  [{label, hex, name}]
 * @param {string}   [opts.templateName]
 * @param {number}   [opts.variationCount]
 * @param {number}   [opts.quantity]
 * @param {Array}    [opts.variationImages]  [{name, frontPng: Uint8Array, backPng: Uint8Array, flagName, colorEntries}]
 */
export async function buildOrderSummaryPdf({
  projectId,
  productType,
  colorEntries = [],
  templateName,
  variationCount,
  quantity,
  variationImages = [],
}) {
  const [{ projectName, ci }, approval] = await Promise.all([
    loadCustomerData(projectId),
    loadApprovalStatus(projectId, productType),
  ]);

  const doc  = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const reg  = await doc.embedFont(StandardFonts.Helvetica);

  const cursor = makeCursor(doc, bold, reg);

  // ── Project name + meta ──────────────────────────────────
  {
    const page = cursor.current();
    let y = cursor.getY();
    page.drawText(projectName || 'Untitled Project', { x: M, y, size: 16, font: bold, color: BLACK });
    y -= 18;
    page.drawText(`Generated: ${today()}`, { x: M, y, size: 9, font: reg, color: GRAY });
    if (approval) {
      const aw = reg.widthOfTextAtSize(approval.label, 9);
      page.drawCircle({ x: W - M - aw - 14, y: y + 3, size: 4, color: approval.color });
      page.drawText(approval.label, { x: W - M - aw, y, size: 9, font: reg, color: approval.color });
    }
    y -= 28;
    cursor.setY(y);
  }

  // ── Customer Information (shown once, packed two fields per line) ────
  drawSectionHeader(cursor, 'Customer Information', bold);

  const addrParts = [
    ci.address_line1, ci.address_line2,
    [ci.city, ci.state_province, ci.postal_code].filter(Boolean).join(', '),
    ci.country === 'CA' ? 'Canada' : ci.country === 'US' ? 'United States' : (ci.country || ''),
  ].filter(Boolean).join(', ');

  const effectiveAttn = ci.attn || ci.contact_name;

  const infoEntries = [
    ['Event',      ci.event_name],
    ['Course',     ci.course_name],
    ['Event Date', formatDate(ci.event_date)],
    ['Contact',    ci.contact_name],
    ['Email',      ci.contact_email],
    effectiveAttn ? ['ATTN', effectiveAttn] : null,
  ].filter(Boolean);
  for (let i = 0; i < infoEntries.length; i += 2) {
    drawRowPair(cursor, [infoEntries[i], infoEntries[i + 1] || null], { labelFont: bold, valueFont: reg });
  }
  drawRow(cursor, 'Shipping Address', addrParts, { labelFont: bold, valueFont: reg, size: 10 });
  cursor.moveY(-10);

  // ── Design Details ───────────────────────────────────────
  drawSectionHeader(cursor, 'Design Details', bold);

  // Flag Template is shown per-variation below when variations are present —
  // only fall back to a single project-level line when there's nothing to break out.
  const designEntries = [
    (!variationImages.length && templateName) ? ['Flag Template', templateName] : null,
    ci.flag_setup          ? ['Setup',      ci.flag_setup === 'same' ? 'Same front & back' : 'Different front & back'] : null,
    variationCount != null ? ['Variations', String(variationCount)] : null,
    quantity != null       ? ['Signs',      String(quantity)] : null,
    ci.flag_qty            ? ['Ordered Qty', String(ci.flag_qty)] : null,
  ].filter(Boolean);
  for (let i = 0; i < designEntries.length; i += 2) {
    drawRowPair(cursor, [designEntries[i], designEntries[i + 1] || null], { labelFont: bold, valueFont: reg });
  }
  if (ci.design_notes) {
    drawRow(cursor, 'Notes', ci.design_notes, { labelFont: bold, valueFont: reg, size: 10 });
  }
  cursor.moveY(-10);

  // ── Colour Assignments ───────────────────────────────────
  // Only shown as a standalone section as a fallback — when variations exist,
  // each variation lists its own colours below instead.
  if (!variationImages.length && colorEntries.length) {
    drawSectionHeader(cursor, 'Colour Assignments', bold);
    const sw = 14;
    for (const entry of colorEntries) {
      cursor.ensureSpace(22);
      const page = cursor.current();
      const y = cursor.getY();
      page.drawRectangle({ x: M, y: y - sw + 3, width: sw, height: sw, color: hexToRgb(entry.hex), borderColor: LGRAY, borderWidth: 0.5 });
      page.drawText(entry.label + ':', { x: M + sw + 8, y, size: 11, font: bold, color: BLACK });
      page.drawText(`${entry.name}   ${entry.hex.toUpperCase()}`, { x: M + sw + 8 + 115, y, size: 11, font: reg, color: BLACK });
      cursor.setY(y - 20);
    }
  }

  // ── Variations (flow inline, packed so multiple fit per page) ─────
  // Each variation carries its own flag style + colour assignment (variations
  // can override both), so those are shown per-block instead of once globally.
  if (variationImages.length) {
    cursor.moveY(-8);
    drawSectionHeader(cursor, 'Flag Variations', bold);

    // Flag aspect ~7519:4669. Front/back shown smaller than a full-bleed print
    // so a style + colour line fits above them and 2+ variations fit per page.
    const gap    = 12;
    const imgW   = 204;
    const imgH   = Math.round(imgW / (7519 / 4669)); // ~127
    const pairW  = imgW * 2 + gap;
    const xOff   = M + Math.round((W - M * 2 - pairW) / 2);

    for (let i = 0; i < variationImages.length; i++) {
      const { name, frontPng, backPng, flagName, colorEntries: varColors } = variationImages[i];
      const colorRows = colorSwatchRowCount(varColors, reg, 9);
      const colorLineH = colorRows ? colorRows * 9 * 1.5 + 2 : 0; // matches drawColorSwatchLine's own consumption
      const blockH = 14 + colorLineH + 12 + imgH + 14; // name/style + colours + face labels + image + margin

      cursor.ensureSpace(blockH + (i > 0 ? 8 : 0));
      let page = cursor.current();
      let y = cursor.getY();

      if (i > 0) {
        page.drawLine({ start: { x: M, y: y + 6 }, end: { x: W - M, y: y + 6 }, thickness: 0.5, color: LGRAY });
      }

      // Variation name (left) + flag style (right), one line
      page.drawText(name || `Variation ${i + 1}`, { x: M, y, size: 11, font: bold, color: BLACK });
      if (flagName) {
        const label = `Style: ${flagName}`;
        const w = reg.widthOfTextAtSize(label, 9);
        page.drawText(label, { x: W - M - w, y, size: 9, font: reg, color: GRAY });
      }
      y -= 14;

      // Colour assignment for this variation
      if (varColors?.length) {
        cursor.setY(y);
        drawColorSwatchLine(cursor, varColors, { valueFont: reg, size: 9 });
        page = cursor.current();
        y = cursor.getY();
      }

      // "Front" / "Back" labels
      page.drawText('Front', { x: xOff,            y, size: 8, font: reg, color: GRAY });
      page.drawText('Back',  { x: xOff + imgW + gap, y, size: 8, font: reg, color: GRAY });
      y -= 12;

      // Images
      if (frontPng) {
        try {
          const img = await doc.embedPng(frontPng);
          page.drawImage(img, { x: xOff, y: y - imgH, width: imgW, height: imgH });
        } catch { /* skip */ }
      }
      if (backPng) {
        try {
          const img = await doc.embedPng(backPng);
          page.drawImage(img, { x: xOff + imgW + gap, y: y - imgH, width: imgW, height: imgH });
        } catch { /* skip */ }
      }

      cursor.setY(y - imgH - 14);
    }
  }

  return doc.save();
}

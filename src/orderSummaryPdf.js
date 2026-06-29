import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { supabase } from './supabase.js';

// ── Palette ────────────────────────────────────────────────
const GREEN = rgb(0x1A/255, 0x4A/255, 0x2E/255);
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
const HEADER_H = 60;  // green bar (56) + gold rule (4)
const CONTENT_TOP = H - HEADER_H - 20;   // y where content starts after header
const CONTENT_BOT = 36;                  // bottom margin

function drawHeader(page, bold, reg) {
  page.drawRectangle({ x: 0, y: H - 56, width: W, height: 56, color: GREEN });
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

// ── Main export ───────────────────────────────────────────
/**
 * @param {object} opts
 * @param {string}   opts.projectId
 * @param {string}   opts.productType   'flags' | 'hole-signs'
 * @param {Array}    opts.colorEntries  [{label, hex, name}]
 * @param {string}   [opts.templateName]
 * @param {number}   [opts.variationCount]
 * @param {number}   [opts.quantity]
 * @param {Array}    [opts.variationImages]  [{name, frontPng: Uint8Array, backPng: Uint8Array}]
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

  // ── Customer Information ─────────────────────────────────
  drawSectionHeader(cursor, 'Customer Information', bold);

  const addrParts = [
    ci.address_line1, ci.address_line2,
    [ci.city, ci.state_province, ci.postal_code].filter(Boolean).join(', '),
    ci.country === 'CA' ? 'Canada' : ci.country === 'US' ? 'United States' : (ci.country || ''),
  ].filter(Boolean).join(', ');

  const effectiveAttn = ci.attn || ci.contact_name;

  for (const [label, value] of [
    ['Event',            ci.event_name],
    ['Course',           ci.course_name],
    ['Event Date',       formatDate(ci.event_date)],
    ['Contact',          ci.contact_name],
    ['Email',            ci.contact_email],
    effectiveAttn       ? ['ATTN',            effectiveAttn] : null,
    ['Shipping Address', addrParts],
  ].filter(Boolean)) {
    drawRow(cursor, label, value, { labelFont: bold, valueFont: reg });
  }
  cursor.moveY(-14);

  // ── Design Details ───────────────────────────────────────
  drawSectionHeader(cursor, 'Design Details', bold);

  for (const [label, value] of [
    templateName           ? ['Flag Template', templateName]                                                              : null,
    ci.flag_setup          ? ['Setup',         ci.flag_setup === 'same' ? 'Same front & back' : 'Different front & back'] : null,
    variationCount != null ? ['Variations',    String(variationCount)]                                                    : null,
    quantity != null       ? ['Signs',         String(quantity)]                                                          : null,
    ci.flag_qty            ? ['Ordered Qty',   String(ci.flag_qty)]                                                       : null,
    ci.design_notes        ? ['Notes',         ci.design_notes]                                                           : null,
  ].filter(Boolean)) {
    drawRow(cursor, label, value, { labelFont: bold, valueFont: reg });
  }
  cursor.moveY(-14);

  // ── Colour Assignments ───────────────────────────────────
  if (colorEntries.length) {
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

  // ── Variation images (flow inline, same page) ─────────────
  if (variationImages.length) {
    cursor.moveY(-20);
    drawSectionHeader(cursor, 'Flag Variations', bold);

    // Flag aspect ~7519:4669. Two images side-by-side with gap.
    const gap  = 12;
    const imgW = Math.floor((W - M * 2 - gap) / 2);   // ~252
    const imgH = Math.round(imgW / (7519 / 4669));      // ~156

    for (let i = 0; i < variationImages.length; i++) {
      const { name, frontPng, backPng } = variationImages[i];
      const blockH = 14 + 12 + imgH + 20; // name + face labels + image + margin

      cursor.ensureSpace(blockH);
      const page = cursor.current();
      let y = cursor.getY();

      // Variation name
      page.drawText(name || `Variation ${i + 1}`, { x: M, y, size: 11, font: bold, color: BLACK });
      y -= 14;

      // "Front" / "Back" labels
      page.drawText('Front', { x: M,            y, size: 8, font: reg, color: GRAY });
      page.drawText('Back',  { x: M + imgW + gap, y, size: 8, font: reg, color: GRAY });
      y -= 12;

      // Images
      if (frontPng) {
        try {
          const img = await doc.embedPng(frontPng);
          page.drawImage(img, { x: M, y: y - imgH, width: imgW, height: imgH });
        } catch { /* skip */ }
      }
      if (backPng) {
        try {
          const img = await doc.embedPng(backPng);
          page.drawImage(img, { x: M + imgW + gap, y: y - imgH, width: imgW, height: imgH });
        } catch { /* skip */ }
      }

      cursor.setY(y - imgH - 20);
    }
  }

  return doc.save();
}

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { Resvg, initWasm } from 'npm:@resvg/resvg-wasm';
import { PDFDocument } from 'npm:pdf-lib';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
};

// ── Hole sign constants (SVG coordinate space @ 300 DPI) ──────────────────────
const HS_W      = 6375;   // 21.25 in × 300 dpi
const HS_H      = 5475;   // 18.25 in × 300 dpi
const HS_MARGIN = 150;
const HS_GAP    = 75;

// Sheet: 5 cols × 2 rows; each sign rotated 90° CW into portrait orientation
// Portrait cell = HS_H wide × HS_W tall = 18.25 in × 21.25 in
const COLS      = 5;
const ROWS      = 2;
const SIGNS_PER_SHEET = COLS * ROWS;

// PDF dimensions in points (1 pt = 1/72 in)
const PDF_W = 91.25 * 72;   // 6570 pt
const PDF_H = 42.5  * 72;   // 3060 pt
const CELL_W_PT = (18.25 * 72);  // 1314 pt  (sign height after 90° rotation)
const CELL_H_PT = (21.25 * 72);  // 1530 pt  (sign width  after 90° rotation)

// Rasterise at 75 DPI (quarter of native 300 DPI) — standard for large-format inkjet signs
const SCALE = 0.25;

const FONT_MAP: Record<string, string> = {
  'dm-serif': "'DM Serif Display', serif",
  'dm-sans':  "'DM Sans', sans-serif",
  'georgia':  'Georgia, serif',
};

// ── resvg-wasm init ───────────────────────────────────────────────────────────
let wasmReady = false;
async function ensureWasm() {
  if (wasmReady) return;
  const res = await fetch('https://unpkg.com/@resvg/resvg-wasm@2.6.2/index_bg.wasm');
  await initWasm(res);
  wasmReady = true;
}

// ── Image helpers ─────────────────────────────────────────────────────────────
async function fetchBase64(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch: ${url}`);
  const ct  = (res.headers.get('content-type') || 'image/png').split(';')[0];
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${ct};base64,${btoa(binary)}`;
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Word-wrap text into lines that fit within `maxW` — ported verbatim from
// src/text-utils.js so banner-caption wrapping matches the editor exactly.
function wrapText(text: string, maxW: number, fontSize: number): string[] {
  const charW = fontSize * 0.5;
  const maxChars = Math.max(1, Math.floor(maxW / charW));
  const results: string[] = [];
  for (const para of String(text ?? '').split('\n')) {
    const words: string[] = [];
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

// ── Sign content builder ──────────────────────────────────────────────────────
interface TextConfig { text?: string; font?: string; size?: number; color?: string }
interface BgConfig   { type?: string; color?: string; imageUrl?: string }

// Banner bands are full-width strips at the top/bottom of the sign with their
// own background (color or image). They carry no text of their own — any
// number of free text layers can "dock" to one (layer.dock/dockOrder below),
// mirroring src/hole-sign-data.js's emptyBanner()/src/hole-sign-render.js.
interface BannerBgConfig { type?: string; color?: string; imageUrl?: string; imageX?: number; imageY?: number; imageScale?: number }
interface BannerConfig {
  enabled?: boolean;
  height?: number;
  spacing?: number;
  valign?: 'top' | 'center' | 'bottom';
  bg?: BannerBgConfig;
}
// Older saved projects (pre-docking) stored a banner's caption text directly
// as topText/subText — read here only to synthesize docked-layer specs for a
// project that hasn't been re-saved through the editor since docking shipped
// (see migrateLegacyBannerCaptions below); never rendered directly.
interface LegacyBannerText { topText?: TextConfig & { align?: string; w?: number }; subText?: TextConfig & { align?: string; w?: number } }

// A free text layer. `dock` set anchors it inside a banner band (stacked via
// dockedLayerPositions); otherwise it's freely positioned via its own x/y/w,
// same as any other text on the canvas — see renderFreeTextLayer().
interface TextLayer {
  id?: string;
  text?: string;
  font?: string;
  size?: number;
  color?: string;
  align?: string;
  x?: number;
  y?: number;
  w?: number;
  dock?: 'top' | 'bottom' | null;
  dockOrder?: number;
  aboveFrame?: boolean;
}

// A single template-logo slot (project-level, shared by every variation) —
// matches the slot shape in src/hole-sign-data.js/src/hole-sign-render.js.
interface TemplateLogoSlot {
  logoSrc?: string;
  logoSrcTight?: string;
  logoAspect?: number;
  ratio?: string;
  fit?: 'width' | 'height';
  scale?: number;
  tx?: number;
  ty?: number;
  bg?: string;
  border?: { color?: string };
  freeX?: number; freeY?: number; freeW?: number; freeH?: number;
}
interface TemplateLogosConfig {
  count?: number;
  size?: number;
  vAlign?: 'top' | 'bottom';
  hAlign?: 'left' | 'center' | 'right' | 'spread';
  customPositions?: boolean;
  slots?: TemplateLogoSlot[];
}

interface HsState {
  background: BgConfig;
  topText: TextConfig;
  bottomText: TextConfig;
  bannerTop?: BannerConfig;
  bannerBottom?: BannerConfig;
  textLayers?: TextLayer[];
  templateLogos?: TemplateLogosConfig;
}
interface Variation  {
  logoSrc?: string;
  logoData?: { x: number; y: number; w: number };
  logoAspect?: number;
  templateId?: string;
}

// Converts a legacy banner's topText/subText into 0-2 docked-layer specs —
// same conversion as src/hole-sign-data.js's migrateBannerCaptions(), ported
// here so a project's print export doesn't go blank on its banner captions
// just because it hasn't been reopened+resaved in the editor since docking
// shipped (this is synthesized in-memory for the render only, never persisted).
function migrateLegacyBannerCaptions(banner: LegacyBannerText | undefined, which: 'top' | 'bottom'): TextLayer[] {
  if (!banner) return [];
  const specs: TextLayer[] = [];
  const title = banner.topText;
  const sub = banner.subText;
  if (title?.text?.trim()) {
    specs.push({
      id: `legacy-${which}-0`, text: title.text, font: title.font ?? 'dm-serif', size: title.size ?? 260,
      color: title.color ?? '#111110', align: title.align ?? 'center', w: title.w, dock: which, dockOrder: 0,
    });
  }
  if (sub?.text?.trim()) {
    specs.push({
      id: `legacy-${which}-1`, text: sub.text, font: sub.font ?? 'dm-sans', size: sub.size ?? 140,
      color: sub.color ?? '#111110', align: sub.align ?? 'center', w: sub.w, dock: which, dockOrder: 1,
    });
  }
  return specs;
}

// Clamp a text box's stored width override to the available margin span and
// center it — matches fitTextBox() in hole-sign-render.js.
function fitTextBox(overrideW: number | undefined, minW: number | undefined): { w: number; x: number } {
  const full = HS_W - 2 * HS_MARGIN;
  const w = Math.max(Math.min(minW || 200, full), Math.min(full, Math.round(overrideW || full)));
  return { w, x: HS_MARGIN + Math.round((full - w) / 2) };
}

// Free text layers currently docked to a banner, sorted into stack order —
// matches dockedLayers() in hole-sign-render.js.
function dockedLayers(state: HsState, which: 'top' | 'bottom'): TextLayer[] {
  return (state.textLayers ?? [])
    .filter(l => l.dock === which)
    .sort((a, b) => (a.dockOrder ?? 0) - (b.dockOrder ?? 0));
}

interface DockedEntry { layer: TextLayer; box: { w: number; x: number }; lines: string[]; lineH: number; h: number }
interface DockedBlock { entries: DockedEntry[]; gap: number; total: number }

// Wraps every docked, non-empty layer to its own box width and returns the
// line breakdown plus the total stacked text height — matches
// dockedTextBlock() in hole-sign-render.js.
function dockedTextBlock(state: HsState, which: 'top' | 'bottom'): DockedBlock {
  const banner = which === 'bottom' ? state.bannerBottom : state.bannerTop;
  const entries: DockedEntry[] = dockedLayers(state, which)
    .filter(l => l.text && l.text.trim())
    .map(l => {
      const size = l.size ?? 200;
      const box = fitTextBox(l.w, size);
      const lines = wrapText(l.text ?? '', box.w, size);
      const lineH = size * 1.1;
      return { layer: l, box, lines, lineH, h: lines.length * lineH };
    });
  const gap = banner?.spacing ?? 0;
  const total = entries.reduce((s, e) => s + e.h, 0) + Math.max(0, entries.length - 1) * gap;
  return { entries, gap, total };
}

// Vertical breathing room reserved above/below the docked text stack —
// matches bannerTextVPad() in hole-sign-render.js.
function bannerTextVPad(block: DockedBlock): number {
  const maxSize = block.entries.reduce((m, e) => Math.max(m, e.layer.size ?? 0), 0);
  return Math.round(maxSize * 0.45);
}

// Banner height actually used for layout: never shorter than the docked text
// needs — matches bannerEffectiveHeight() in hole-sign-render.js.
function bannerEffectiveHeight(state: HsState, which: 'top' | 'bottom'): number {
  const banner = which === 'bottom' ? state.bannerBottom : state.bannerTop;
  if (!banner || !banner.enabled) return 0;
  const block = dockedTextBlock(state, which);
  if (block.total <= 0) return Math.max(0, banner.height ?? 0);
  return Math.max(banner.height ?? 0, block.total + bannerTextVPad(block) * 2);
}

// Full-width banner band rect, or null when disabled — matches
// getBannerRect() in hole-sign-render.js.
function getBannerRect(state: HsState, which: 'top' | 'bottom'): { x: number; y: number; w: number; h: number } | null {
  const b = which === 'bottom' ? state.bannerBottom : state.bannerTop;
  const h = bannerEffectiveHeight(state, which);
  if (!b || !b.enabled || !(h > 0)) return null;
  const y = which === 'bottom' ? HS_H - h : 0;
  return { x: 0, y, w: HS_W, h };
}

// Resolved {x,y,w,h} rect per docked layer id, stacked top-to-bottom in
// dockOrder honoring banner.valign — matches dockedLayerPositions() in
// hole-sign-render.js.
function dockedLayerPositions(state: HsState, which: 'top' | 'bottom'): Record<string, { x: number; y: number; w: number; h: number }> {
  const rect = getBannerRect(state, which);
  if (!rect) return {};
  const banner = which === 'bottom' ? state.bannerBottom : state.bannerTop;
  const block = dockedTextBlock(state, which);
  const valign = banner?.valign ?? 'center';
  const vpad = bannerTextVPad(block);
  let y = valign === 'top' ? rect.y + vpad
    : valign === 'bottom' ? rect.y + rect.h - vpad - block.total
    : rect.y + rect.h / 2 - block.total / 2;
  const out: Record<string, { x: number; y: number; w: number; h: number }> = {};
  block.entries.forEach(e => {
    out[e.layer.id ?? ''] = { x: e.box.x, y, w: e.box.w, h: e.h };
    y += e.h + block.gap;
  });
  return out;
}

// SVG markup for a banner's background only (color/image fill) — matches
// renderBanner()'s background half in hole-sign-render.js. `idPrefix`
// namespaces the clipPath id to avoid collisions across signs on a sheet.
function renderBannerBg(state: HsState, which: 'top' | 'bottom', idPrefix: string): string {
  const banner = which === 'bottom' ? state.bannerBottom : state.bannerTop;
  const h = bannerEffectiveHeight(state, which);
  if (!banner || !banner.enabled || !(h > 0)) return '';
  const y = which === 'bottom' ? HS_H - h : 0;
  const bg = banner.bg ?? {};
  const clipId = `${idPrefix}-bannerClip-${which}`;
  const parts: string[] = [];
  parts.push(`<clipPath id="${clipId}"><rect x="0" y="${y}" width="${HS_W}" height="${h}"/></clipPath>`);
  parts.push(`<rect x="0" y="${y}" width="${HS_W}" height="${h}" fill="${esc(bg.color ?? '#E5E5E5')}"/>`);
  if (bg.type === 'image' && bg.imageUrl) {
    const scale = (bg.imageScale ?? 100) / 100;
    const imgW = HS_W * scale;
    const imgH = h * scale;
    const cx = (bg.imageX ?? 50) / 100 * HS_W;
    const cy = y + (bg.imageY ?? 50) / 100 * h;
    parts.push(`<image href="${esc(bg.imageUrl)}" x="${Math.round(cx - imgW / 2)}" y="${Math.round(cy - imgH / 2)}" width="${Math.round(imgW)}" height="${Math.round(imgH)}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})"/>`);
  }
  return parts.join('\n');
}

// SVG markup for every docked, non-empty layer in a banner zone — matches the
// docked branch of the free-layer render loop in makeHoleSignSvg()
// (hole-sign-render.js). Rendered after the banner background (see call site
// in buildSignContent) so captions always paint on top of it.
function renderDockedCaptions(state: HsState, which: 'top' | 'bottom'): string {
  const block = dockedTextBlock(state, which);
  const positions = dockedLayerPositions(state, which);
  const parts: string[] = [];
  block.entries.forEach(e => {
    const layer = e.layer;
    const pos = positions[layer.id ?? ''];
    if (!pos) return;
    const size = layer.size ?? 200;
    const anchor = layer.align === 'left' ? 'start' : layer.align === 'right' ? 'end' : 'middle';
    const tx = layer.align === 'left' ? pos.x : layer.align === 'right' ? pos.x + pos.w : pos.x + pos.w / 2;
    const firstBaseY = pos.y + size * 0.82;
    const tspans = e.lines.map((line, i) => `<tspan x="${tx}"${i === 0 ? '' : ` dy="${e.lineH}"`}>${esc(line)}</tspan>`).join('');
    parts.push(`<text x="${tx}" y="${Math.round(firstBaseY)}" text-anchor="${anchor}" font-family="${esc(FONT_MAP[layer.font ?? 'dm-serif'] ?? FONT_MAP['dm-sans'])}" font-size="${size}" fill="${esc(layer.color ?? '#111110')}">${tspans}</text>`);
  });
  return parts.join('\n');
}

// SVG markup for one free (non-docked) text layer, positioned by its own
// stored x/y/w — matches the non-dock branch of the free-layer render loop
// in makeHoleSignSvg() (hole-sign-render.js), so anything visible in the
// on-screen proof also reaches print.
function renderFreeTextLayer(layer: TextLayer): string {
  const size = layer.size ?? 200;
  const effX = layer.x ?? 0;
  const effY = layer.y ?? 0;
  const effW = layer.w ?? (HS_W - 2 * HS_MARGIN);
  const lines = wrapText(layer.text ?? '', effW, size);
  const lineH = size * 1.1;
  const anchor = layer.align === 'left' ? 'start' : layer.align === 'right' ? 'end' : 'middle';
  const tx = layer.align === 'left' ? effX : layer.align === 'right' ? effX + effW : effX + effW / 2;
  const firstBaseY = effY + size * 0.82;
  const tspans = lines.map((line, i) => `<tspan x="${tx}"${i === 0 ? '' : ` dy="${lineH}"`}>${esc(line)}</tspan>`).join('');
  return `<text x="${tx}" y="${Math.round(firstBaseY)}" text-anchor="${anchor}" font-family="${esc(FONT_MAP[layer.font ?? 'dm-serif'] ?? FONT_MAP['dm-sans'])}" font-size="${size}" fill="${esc(layer.color ?? '#111110')}">${tspans}</text>`;
}

// ── Template logos ────────────────────────────────────────────────────────────
// Ported from src/hole-sign-data.js / src/hole-sign-render.js — keep in sync
// when changing template-logo layout or rendering there.
const HS_TPL_LOGO_MIN = 220;
const HS_TPL_LOGO_MAX = 1400;
const HS_TPL_LOGO_DEFAULT = 700;
const HS_TPL_LOGO_SAFE_FRAC = 0.04;
const HS_TPL_LOGO_RADIUS = 50;

function normalizeTplLogoSize(v: unknown): number {
  if (typeof v === 'number' && isFinite(v)) return Math.max(HS_TPL_LOGO_MIN, Math.min(HS_TPL_LOGO_MAX, Math.round(v)));
  return HS_TPL_LOGO_DEFAULT;
}

// Slot width for the configured ratio — matches slotWidthForRatio() in
// hole-sign-render.js.
function slotWidthForRatio(slot: TemplateLogoSlot | undefined, slotH: number): number {
  if (!slot) return slotH * 2;
  const ratio = slot.ratio || '2:1';
  if (ratio === 'fit') {
    const a = slot.logoAspect;
    if (a && a > 0) return Math.max(slotH * 0.5, Math.min(slotH * 6, slotH / a));
    return slotH * 2;
  }
  const [w, h] = ratio.split(':').map(Number);
  if (w > 0 && h > 0) return slotH * w / h;
  return slotH * 2;
}

interface TplLogoLayout { stripH: number; widths: number[]; slotH: number; slotsRel: { dx: number; dy: number }[]; gap: number }

// Strip rect + per-slot rects for the template-logo group, or null when
// disabled — matches computeTemplateLogoLayout() in hole-sign-render.js.
function computeTemplateLogoLayout(tl: TemplateLogosConfig | undefined): TplLogoLayout | null {
  if (!tl || !tl.count || tl.count < 1) return null;
  const slotH = normalizeTplLogoSize(tl.size);
  const gap = HS_GAP * 2;
  const innerW = HS_W - 2 * HS_MARGIN;

  const widths: number[] = [];
  for (let i = 0; i < tl.count; i++) widths.push(slotWidthForRatio((tl.slots ?? [])[i], slotH));

  const stripH = slotH;
  const slotsRel: { dx: number; dy: number }[] = [];
  if (tl.hAlign === 'spread') {
    if (tl.count === 1) {
      slotsRel.push({ dx: (innerW - widths[0]) / 2, dy: 0 });
    } else if (tl.count === 2) {
      slotsRel.push({ dx: 0, dy: 0 });
      slotsRel.push({ dx: innerW - widths[1], dy: 0 });
    } else {
      slotsRel.push({ dx: 0, dy: 0 });
      slotsRel.push({ dx: (innerW - widths[1]) / 2, dy: 0 });
      slotsRel.push({ dx: innerW - widths[2], dy: 0 });
    }
  } else {
    const sum = widths.reduce((s, w) => s + w, 0);
    const groupW = sum + (tl.count - 1) * gap;
    const baseX = tl.hAlign === 'right' ? innerW - groupW
                : tl.hAlign === 'center' ? (innerW - groupW) / 2
                : 0;
    let x = baseX;
    for (let i = 0; i < tl.count; i++) { slotsRel.push({ dx: x, dy: 0 }); x += widths[i] + gap; }
  }

  return { stripH, widths, slotH, slotsRel, gap };
}

interface Layout {
  topH: number; botH: number; logoY: number; logoH: number;
  stripY: number; stripH: number; bannerTopH: number; bannerBotH: number;
}

function computeLayout(state: HsState, templateId: string): Layout {
  const bannerTopH = bannerEffectiveHeight(state, 'top');
  const bannerBotH = bannerEffectiveHeight(state, 'bottom');

  // Full-graphic's own image fills the sign edge-to-edge — banners and
  // template-logo slots paint as an overlay on top of it rather than
  // reserving space, so bannerTopH/bannerBotH are reported as 0 here (only
  // used for text positioning, and full-graphic never renders top/bot text).
  if (templateId === 'hole-sign-full-graphic') {
    const tll = computeTemplateLogoLayout(state.templateLogos);
    const stripH = tll ? tll.stripH : 0;
    let stripY = bannerTopH + HS_MARGIN;
    if (state.templateLogos?.vAlign === 'bottom') stripY = HS_H - bannerBotH - HS_MARGIN - stripH;
    return { topH: 0, botH: 0, logoY: 0, logoH: HS_H, stripY, stripH, bannerTopH: 0, bannerBotH: 0 };
  }
  if (templateId === 'hole-sign-logo-only') {
    const logoY = bannerTopH + HS_MARGIN;
    const logoH = Math.max(0, HS_H - bannerTopH - bannerBotH - 2 * HS_MARGIN);
    const tll = computeTemplateLogoLayout(state.templateLogos);
    const stripH = tll ? tll.stripH : 0;
    let stripY = logoY;
    if (state.templateLogos?.vAlign === 'bottom') stripY = HS_H - bannerBotH - HS_MARGIN - stripH;
    return { topH: 0, botH: 0, logoY, logoH, stripY, stripH, bannerTopH, bannerBotH };
  }
  const top  = state.topText;
  const bot  = state.bottomText;
  const topH = (top.text?.trim()) ? Math.round((top.size ?? 300) * 1.4 + 80) : 0;
  const botH = (bot.text?.trim()) ? Math.round((bot.size ?? 300) * 1.4 + 80) : 0;
  const topGap = topH > 0 ? HS_GAP : 0;
  const botGap = botH > 0 ? HS_GAP : 0;
  const logoY  = bannerTopH + HS_MARGIN + topH + topGap;
  const logoH  = Math.max(0, HS_H - bannerTopH - bannerBotH - 2 * HS_MARGIN - topH - topGap - botH - botGap);

  const tll = computeTemplateLogoLayout(state.templateLogos);
  const stripH = tll ? tll.stripH : 0;
  let stripY = logoY;
  if (state.templateLogos?.vAlign === 'bottom') {
    stripY = HS_H - bannerBotH - HS_MARGIN - botH - botGap - stripH;
  }

  return { topH, botH, logoY, logoH, stripY, stripH, bannerTopH, bannerBotH };
}

// Sponsor-logo placement zone, carving out the template-logo strip so the two
// never overlap under default (non-custom) placement — matches getLogoZone()
// in hole-sign-render.js.
function getLogoZone(state: HsState, templateId: string): { x: number; y: number; w: number; h: number } {
  if (templateId === 'hole-sign-full-graphic') return { x: 0, y: 0, w: HS_W, h: HS_H };
  const { logoY, logoH, stripY, stripH } = computeLayout(state, templateId);
  const x = HS_MARGIN, w = HS_W - 2 * HS_MARGIN;

  if (state.templateLogos?.customPositions) return { x, y: logoY, w, h: logoH };

  const tll = computeTemplateLogoLayout(state.templateLogos);
  if (!tll || stripH <= 0) return { x, y: logoY, w, h: logoH };

  const gap = HS_GAP;
  const vAlign = state.templateLogos?.vAlign || 'top';
  if (vAlign === 'bottom') {
    return { x, y: logoY, w, h: Math.max(0, stripY - logoY - gap) };
  } else {
    const newY = stripY + stripH + gap;
    return { x, y: newY, w, h: Math.max(0, logoY + logoH - newY) };
  }
}

// Resolved rects for each template-logo slot — matches getTemplateLogoSlots()
// in hole-sign-render.js.
function getTemplateLogoSlots(state: HsState, templateId: string): { x: number; y: number; w: number; h: number }[] {
  const tl = state.templateLogos;
  const tll = computeTemplateLogoLayout(tl);
  if (!tll) return [];
  const { stripY } = computeLayout(state, templateId);
  return tll.slotsRel.map(({ dx, dy }, i) => {
    const slot = (tl?.slots ?? [])[i];
    if (slot?.freeX != null) {
      return { x: slot.freeX!, y: slot.freeY ?? 0, w: slot.freeW ?? tll.widths[i], h: slot.freeH ?? tll.slotH };
    }
    return { x: HS_MARGIN + dx, y: stripY + dy, w: tll.widths[i], h: tll.slotH };
  });
}

// SVG markup for one template-logo slot (background + image + border), or ''
// when the slot has no logo assigned or its image failed to prefetch —
// matches renderTemplateLogoSlot() in hole-sign-render.js (which takes the
// raw logoSrc directly; here we take an already-prefetched data URI since
// resvg-wasm can't load external URLs, same as logos/backgrounds elsewhere
// in this file).
function renderTemplateLogoSlot(
  slot: TemplateLogoSlot | undefined,
  rect: { x: number; y: number; w: number; h: number },
  dataUri: string | null,
  clipId: string,
): string {
  if (!slot || !dataUri) return '';
  const aspect = slot.logoAspect != null ? slot.logoAspect : 0.5;
  const fit = slot.fit || 'width';
  const safeFrac = (slot.ratio === 'fit') ? 0 : HS_TPL_LOGO_SAFE_FRAC;
  const safe = 1 - 2 * safeFrac;
  const scale = (slot.scale ?? 100) / 100 * safe;
  const tx = slot.tx ?? 50;
  const ty = slot.ty ?? 50;

  let imgW: number, imgH: number;
  if (fit === 'height') { imgH = rect.h * scale; imgW = imgH / aspect; }
  else { imgW = rect.w * scale; imgH = imgW * aspect; }
  const cx = rect.x + (tx / 100) * rect.w;
  const cy = rect.y + (ty / 100) * rect.h;

  const bg = (slot.bg && slot.bg !== 'transparent') ? slot.bg : null;
  const bgRect = bg
    ? `<rect x="${rect.x}" y="${rect.y}" width="${rect.w}" height="${rect.h}" rx="${HS_TPL_LOGO_RADIUS}" ry="${HS_TPL_LOGO_RADIUS}" fill="${esc(bg)}"/>`
    : '';
  const borderColor = (slot.ratio === 'fit') ? null : slot.border?.color;
  const borderW = borderColor ? 16 : 0;
  const borderRect = borderColor
    ? `<rect x="${rect.x + borderW / 2}" y="${rect.y + borderW / 2}" width="${rect.w - borderW}" height="${rect.h - borderW}" rx="${Math.max(0, HS_TPL_LOGO_RADIUS - borderW / 2)}" ry="${Math.max(0, HS_TPL_LOGO_RADIUS - borderW / 2)}" fill="none" stroke="${esc(borderColor)}" stroke-width="${borderW}"/>`
    : '';
  return `<clipPath id="${clipId}"><rect x="${rect.x}" y="${rect.y}" width="${rect.w}" height="${rect.h}" rx="${HS_TPL_LOGO_RADIUS}" ry="${HS_TPL_LOGO_RADIUS}"/></clipPath>`
    + bgRect
    + `<image href="${dataUri}" x="${Math.round(cx - imgW / 2)}" y="${Math.round(cy - imgH / 2)}" width="${Math.round(imgW)}" height="${Math.round(imgH)}" preserveAspectRatio="xMidYMid meet" clip-path="url(#${clipId})"/>`
    + borderRect;
}

// Returns inner SVG content for one sign (no outer <svg> wrapper).
// clipPath ID is namespaced with signIdx to avoid collisions.
function buildSignContent(
  state: HsState,
  variation: Variation,
  logoDataUri: string | null,
  templateLogoDataUris: (string | null)[],
  signIdx: number,
): string {
  const tid  = variation.templateId ?? 'hole-sign-1';
  const { topH, botH, bannerTopH, bannerBotH } = computeLayout(state, tid);
  const bg   = state.background;
  const top  = state.topText;
  const bot  = state.bottomText;
  const cpId = `lzc-${signIdx}`;
  const parts: string[] = [];

  parts.push(`<rect x="0" y="0" width="${HS_W}" height="${HS_H}" fill="${esc(bg.color ?? '#1A3A6B')}"/>`);
  if (bg.type === 'image' && bg.imageUrl) {
    parts.push(`<image href="${esc(bg.imageUrl)}" x="0" y="0" width="${HS_W}" height="${HS_H}" preserveAspectRatio="xMidYMid slice"/>`);
  }

  // Banner backgrounds paint over full-graphic's image the same as every
  // other template (banners are an overlay, not a reserved zone — matches
  // makeHoleSignSvg() in hole-sign-render.js). Docked captions are painted
  // after (below) so they always show on top of these backgrounds.
  const bTopBg = renderBannerBg(state, 'top', cpId);
  const bBotBg = renderBannerBg(state, 'bottom', cpId);
  if (bTopBg) parts.push(bTopBg);
  if (bBotBg) parts.push(bBotBg);

  if (tid !== 'hole-sign-logo-only' && topH > 0 && top.text?.trim()) {
    const ty = Math.round(bannerTopH + HS_MARGIN + topH / 2 + (top.size ?? 300) * 0.38);
    parts.push(`<text x="${HS_W / 2}" y="${ty}" text-anchor="middle" font-family="${esc(FONT_MAP[top.font ?? 'dm-serif'])}" font-size="${top.size ?? 300}" fill="${esc(top.color ?? '#FFFFFF')}">${esc(top.text)}</text>`);
  }

  // Template logos — project-level, shared by every variation; paint above
  // the sponsor logo (see makeHoleSignSvg's frame-group ordering).
  const tplSlotConfigs = state.templateLogos?.slots ?? [];
  getTemplateLogoSlots(state, tid).forEach((rect, i) => {
    parts.push(renderTemplateLogoSlot(tplSlotConfigs[i], rect, templateLogoDataUris[i] ?? null, `${cpId}-tlc${i}`));
  });

  if (logoDataUri) {
    if (tid === 'hole-sign-full-graphic') {
      // Full-graphic's own per-variation image fills the sign edge-to-edge —
      // matches makeHoleSignSvg()'s templateId === 'hole-sign-full-graphic'
      // branch, not the inset getLogoZone() placement used below.
      parts.push(`<image href="${logoDataUri}" x="0" y="0" width="${HS_W}" height="${HS_H}" preserveAspectRatio="xMidYMid meet"/>`);
    } else {
      const ld  = variation.logoData ?? { x: 50, y: 50, w: 90 };
      const lz  = getLogoZone(state, tid);
      const lw  = lz.w * (ld.w / 100);
      const lh  = lw * (variation.logoAspect ?? 1);
      const cx  = lz.x + (ld.x / 100) * lz.w;
      const cy  = lz.y + (ld.y / 100) * lz.h;
      parts.push(`<clipPath id="${cpId}"><rect x="${lz.x}" y="${lz.y}" width="${lz.w}" height="${lz.h}"/></clipPath>`);
      parts.push(`<image href="${logoDataUri}" x="${Math.round(cx - lw / 2)}" y="${Math.round(cy - lh / 2)}" width="${Math.round(lw)}" height="${Math.round(lh)}" preserveAspectRatio="xMidYMid meet" clip-path="url(#${cpId})"/>`);
    }
  }

  // Free (non-docked) text layers — same content the on-screen proof shows,
  // so anything a user positions on the canvas actually reaches print.
  // Non-aboveFrame ones paint here (above the sponsor/template logos placed
  // above); aboveFrame ones paint last, after docked captions — matches the
  // `aboveFrame || layer.dock` split in makeHoleSignSvg()'s aboveParts flush.
  const freeLayers = (state.textLayers ?? []).filter(l => !l.dock && l.text?.trim());
  const belowFrameFree = freeLayers.filter(l => !l.aboveFrame).map(renderFreeTextLayer).join('\n');
  if (belowFrameFree) parts.push(belowFrameFree);

  if (tid !== 'hole-sign-logo-only' && botH > 0 && bot.text?.trim()) {
    const ty = Math.round(HS_H - bannerBotH - HS_MARGIN - botH + botH / 2 + (bot.size ?? 300) * 0.38);
    parts.push(`<text x="${HS_W / 2}" y="${ty}" text-anchor="middle" font-family="${esc(FONT_MAP[bot.font ?? 'dm-serif'])}" font-size="${bot.size ?? 300}" fill="${esc(bot.color ?? '#FFFFFF')}">${esc(bot.text ?? '')}</text>`);
  }

  // Docked banner captions — painted after the standard bottom text so they
  // sit above the banner backgrounds regardless of z-order elsewhere,
  // matching the `aboveFrame || layer.dock` rule in makeHoleSignSvg().
  const dTop = renderDockedCaptions(state, 'top');
  const dBot = renderDockedCaptions(state, 'bottom');
  if (dTop) parts.push(dTop);
  if (dBot) parts.push(dBot);

  const aboveFrameFree = freeLayers.filter(l => l.aboveFrame).map(renderFreeTextLayer).join('\n');
  if (aboveFrameFree) parts.push(aboveFrameFree);

  return parts.join('\n');
}

// ── PDF builder ───────────────────────────────────────────────────────────────
//
// Composes all signs into one sheet SVG, renders it once with resvg, then
// embeds the resulting PNG in a single-page PDF.  Doing one render instead
// of SIGNS_PER_SHEET renders keeps memory well within edge-function limits.
//
// Sheet SVG dimensions: COLS×HS_H wide × ROWS×HS_W tall
// Each cell: HS_H × HS_W (sign rotated 90° CW fits here)
// Front: col = i % COLS  |  Back: col = COLS-1 - (i % COLS)  (mirror for flip)
//
async function buildPdf(
  signContents: string[],
  mirrored: boolean,
): Promise<Uint8Array> {
  await ensureWasm();

  const sheetW = COLS * HS_H;   // 5 × 5475 = 27375
  const sheetH = ROWS * HS_W;   // 2 × 6375 = 12750
  const pngW   = Math.round(sheetW * SCALE);
  const pngH   = Math.round(sheetH * SCALE);

  const parts: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${sheetW} ${sheetH}" width="${pngW}" height="${pngH}">`,
  ];

  for (let i = 0; i < SIGNS_PER_SHEET; i++) {
    const col    = i % COLS;
    const row    = Math.floor(i / COLS);
    const pdfCol = mirrored ? (COLS - 1 - col) : col;
    const cellX  = pdfCol * HS_H;
    const cellY  = row * HS_W;

    // Rotate sign content 90° CW into HS_H×HS_W cell; mirror content for back
    const innerTransform = mirrored
      ? `translate(${HS_H}, 0) rotate(90) translate(${HS_W}, 0) scale(-1, 1)`
      : `translate(${HS_H}, 0) rotate(90)`;

    parts.push(`<g transform="translate(${cellX}, ${cellY})">`);
    parts.push(`  <g transform="${innerTransform}">`);
    parts.push(signContents[i]);
    parts.push(`  </g>`);
    parts.push(`</g>`);
  }

  parts.push(`</svg>`);

  const resvg    = new Resvg(parts.join('\n'), { fitTo: { mode: 'original' } });
  const pngData  = resvg.render().asPng();

  const pdfDoc   = await PDFDocument.create();
  const page     = pdfDoc.addPage([PDF_W, PDF_H]);
  const pngImage = await pdfDoc.embedPng(pngData);
  page.drawImage(pngImage, { x: 0, y: 0, width: PDF_W, height: PDF_H });

  return pdfDoc.save();
}

// ── Storage helpers ───────────────────────────────────────────────────────────
async function ensureBucket() {
  const headers = {
    Authorization: `Bearer ${SERVICE_KEY}`,
    apikey: SERVICE_KEY,
    'Content-Type': 'application/json',
  };
  await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
    method: 'POST', headers,
    body: JSON.stringify({ id: 'renders', name: 'renders', public: true }),
  });
  await fetch(`${SUPABASE_URL}/storage/v1/bucket/renders`, {
    method: 'PUT', headers,
    body: JSON.stringify({ public: true }),
  });
}

async function saveFile(path: string, data: Uint8Array, ct: string): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/renders/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      apikey: SERVICE_KEY,
      'Content-Type': ct,
      'x-upsert': 'true',
    },
    body: data,
  });
  if (!res.ok) throw new Error(`Storage upload failed: ${await res.text()}`);
  return `${SUPABASE_URL}/storage/v1/object/public/renders/${path}`;
}

// ── DB helpers ────────────────────────────────────────────────────────────────
async function dbGet<T>(table: string, filter: string): Promise<T | null> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/${table}?${filter}&limit=1`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
  );
  const rows: T[] = await res.json();
  return rows[0] ?? null;
}

async function dbList<T>(table: string, filter: string): Promise<T[]> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/${table}?${filter}`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
  );
  return res.json();
}

// ── Handler ───────────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const { projectId } = await req.json();
    if (!projectId) throw new Error('projectId required');

    const hsCfg = await dbGet<Record<string, unknown>>(
      'hole_sign_config',
      `project_id=eq.${encodeURIComponent(projectId)}&select=*`,
    );
    if (!hsCfg) throw new Error('No hole sign config found');

    const logos = await dbList<{ id: string; public_url: string }>(
      'project_logos',
      `project_id=eq.${encodeURIComponent(projectId)}&select=id,public_url`,
    );

    const colors     = (hsCfg.colors as Record<string, unknown>) ?? {};
    const variations = ((hsCfg.variations as Variation[]) ?? []).slice(0, SIGNS_PER_SHEET);

    const bannerTop    = colors.bannerTop    as (BannerConfig & LegacyBannerText) | undefined;
    const bannerBottom = colors.bannerBottom as (BannerConfig & LegacyBannerText) | undefined;
    const rawTextLayers = (colors.textLayers as TextLayer[] | undefined) ?? [];
    // A project saved before docking shipped stores banner captions as
    // bannerTop/Bottom.topText/subText rather than docked textLayers — only
    // synthesize the legacy conversion when no docked layer already exists for
    // that zone, so a project re-saved through the editor (which performs this
    // same migration for real, see hs/app.js) isn't double-converted.
    const hasDockedTop    = rawTextLayers.some(l => l.dock === 'top');
    const hasDockedBottom = rawTextLayers.some(l => l.dock === 'bottom');
    const textLayers: TextLayer[] = [
      ...rawTextLayers,
      ...(hasDockedTop    ? [] : migrateLegacyBannerCaptions(bannerTop, 'top')),
      ...(hasDockedBottom ? [] : migrateLegacyBannerCaptions(bannerBottom, 'bottom')),
    ];

    const templateLogos = colors.templateLogos as TemplateLogosConfig | undefined;

    const state: HsState = {
      background: (colors.background as BgConfig)  ?? { type: 'color', color: '#1A3A6B' },
      topText:    (colors.topText    as TextConfig) ?? { text: '', font: 'dm-serif', size: 300, color: '#FFFFFF' },
      bottomText: (colors.bottomText as TextConfig) ?? { text: '', font: 'dm-serif', size: 300, color: '#FFFFFF' },
      bannerTop, bannerBottom, textLayers, templateLogos,
    };

    // Prefetch logos
    const logoDataUris: (string | null)[] = await Promise.all(
      variations.map(async (v) => {
        const src = v.logoSrc ?? '';
        if (!src || src.startsWith('blob:')) return null;
        try { return await fetchBase64(src); } catch { return null; }
      }),
    );

    // Prefetch template-logo slot images — project-level, shared by every
    // variation, so this runs once rather than per-sign.
    const templateLogoDataUris: (string | null)[] = await Promise.all(
      (templateLogos?.slots ?? []).map(async (slot) => {
        const src = slot.logoSrcTight ?? slot.logoSrc ?? '';
        if (!src || src.startsWith('blob:')) return null;
        try { return await fetchBase64(src); } catch { return null; }
      }),
    );

    // Patch background image if needed
    let bgDataUri: string | null = null;
    if (state.background.type === 'image' && state.background.imageUrl &&
        !state.background.imageUrl.startsWith('blob:')) {
      try { bgDataUri = await fetchBase64(state.background.imageUrl); } catch { /* skip */ }
    }
    // Banner background images likewise need to be data URIs — resvg-wasm
    // can't load external URLs (same reason logos/page background are
    // prefetched above).
    async function patchBannerBg(banner: BannerConfig | undefined): Promise<BannerConfig | undefined> {
      if (!banner?.enabled || banner.bg?.type !== 'image' || !banner.bg.imageUrl || banner.bg.imageUrl.startsWith('blob:')) {
        return banner;
      }
      try {
        const dataUri = await fetchBase64(banner.bg.imageUrl);
        return { ...banner, bg: { ...banner.bg, imageUrl: dataUri } };
      } catch { return banner; }
    }
    const [patchedBannerTop, patchedBannerBottom] = await Promise.all([
      patchBannerBg(state.bannerTop),
      patchBannerBg(state.bannerBottom),
    ]);
    const patchedState: HsState = {
      ...state,
      background: { ...state.background, imageUrl: bgDataUri ?? state.background.imageUrl },
      bannerTop: patchedBannerTop,
      bannerBottom: patchedBannerBottom,
    };

    // Build sign content strings (padded to SIGNS_PER_SHEET)
    const signContents: string[] = [];
    for (let i = 0; i < SIGNS_PER_SHEET; i++) {
      if (i < variations.length) {
        signContents.push(buildSignContent(patchedState, variations[i], logoDataUris[i], templateLogoDataUris, i));
      } else {
        signContents.push(`<rect x="0" y="0" width="${HS_W}" height="${HS_H}" fill="${esc(patchedState.background.color ?? '#1A3A6B')}"/>`);
      }
    }

    await ensureBucket();

    // Build front then back sequentially to stay within memory/CPU limits
    const frontPdf = await buildPdf(signContents, false);
    const backPdf  = await buildPdf(signContents, true);

    const [frontUrl, backUrl] = await Promise.all([
      saveFile(`${projectId}/hole-signs/front.pdf`, frontPdf, 'application/pdf'),
      saveFile(`${projectId}/hole-signs/back.pdf`,  backPdf,  'application/pdf'),
    ]);

    return new Response(JSON.stringify({ ok: true, front_url: frontUrl, back_url: backUrl }), {
      status: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[render-hole-signs]', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
});

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { esc, wrapEmailHtml, PLAIN_TEXT_FOOTER } from '../_shared/email-layout.ts';

// SENDGRID_API_KEY_2 is the current key; SENDGRID_API_KEY is kept as a fallback
// during rotation and can be removed once SENDGRID_API_KEY_2 is confirmed live everywhere.
const SENDGRID_API_KEY = Deno.env.get('SENDGRID_API_KEY_2') ?? Deno.env.get('SENDGRID_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FROM_EMAIL = 'design@gsds.space';
const FROM_NAME = 'Design Studio';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
};

type ProductType = 'flags' | 'hole-signs';

// The caller is the anonymous review page, so nothing identity- or
// address-related is taken from the request body: the recipient is the
// approver email stamped on the design by client_approve_design_proof, the
// contact/shipping/variation data is read here with the service role, and the
// function refuses unless the design is actually approved. The body only
// supplies the rendered preview images (which only the browser can produce),
// keyed by variation id.
interface Payload {
  projectId: string;
  productType: ProductType;
  previews?: Record<string, { label: string; base64: string }[]>;
}

const MAX_PREVIEW_B64 = 2_000_000; // per image, ~1.5MB decoded
const MAX_IMAGES = 60;

async function rest(path: string): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) throw new Error(`REST ${path} failed: ${res.status}`);
  return await res.json();
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

function addressLines(c: Record<string, any>): string[] {
  const cityLine = [c.city, [c.state_province, c.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [c.attn, c.address_line1, c.address_line2, cityLine, c.country && c.country !== 'US' ? c.country : '']
    .map((s) => String(s ?? '').trim()).filter(Boolean);
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const payload: Payload = await req.json();
    const { projectId, productType } = payload;
    if (!projectId || (productType !== 'flags' && productType !== 'hole-signs')) {
      return json({ error: 'Invalid request' }, 400);
    }

    const cfgTable = productType === 'flags' ? 'flag_config' : 'hole_sign_config';
    const [cfgRows, projectRows, intakeRows] = await Promise.all([
      rest(`${cfgTable}?project_id=eq.${encodeURIComponent(projectId)}&select=status,variations,approved_by_name,approved_by_email&limit=1`),
      rest(`projects?id=eq.${encodeURIComponent(projectId)}&select=name,customer_info&limit=1`),
      rest(`order_intakes?project_id=eq.${encodeURIComponent(projectId)}&select=*&limit=1`),
    ]);
    const cfg = cfgRows[0];
    const project = projectRows[0];
    if (!cfg || !project) return json({ error: 'Invalid project' }, 403);
    if (cfg.status !== 'approved' && cfg.status !== 'sent_to_print') return json({ error: 'Design is not approved' }, 409);
    const to = String(cfg.approved_by_email ?? '').trim();
    if (!to) return json({ ok: true, skipped: 'no approver email' });

    // Same precedence as the Customer details modal: staff-corrected
    // customer_info first, original order intake for anything untouched.
    const ci = project.customer_info || {};
    const intake = intakeRows[0] || {};
    const get = (k: string) => ci[k] ?? intake[k] ?? '';
    const contact = { name: get('contact_name'), email: get('contact_email') };
    const ship = {
      attn: get('attn'), address_line1: get('address_line1'), address_line2: get('address_line2'),
      city: get('city'), state_province: get('state_province'), postal_code: get('postal_code'), country: get('country'),
    };
    const eventName = get('event_name') || project.name;
    const noun = productType === 'flags' ? 'flag' : 'sign';
    const productLabel = productType === 'flags' ? 'Flags' : 'Hole Signs';
    const approverName = cfg.approved_by_name || contact.name || '';

    // flag_config.variations is { items, layout, ... }; older rows and
    // hole_sign_config store a bare array (same handling as review.js).
    const variations: any[] = Array.isArray(cfg.variations) ? cfg.variations : (cfg.variations?.items ?? []);
    const rows = variations.map((v) => ({
      id: String(v.id), name: String(v.name ?? 'Untitled'), qty: parseInt(v.qty, 10) || 1,
    }));
    const total = rows.reduce((s, r) => s + r.qty, 0);

    // Preview images → inline (CID) attachments.
    const attachments: { content: string; filename: string; type: string; disposition: string; content_id: string }[] = [];
    const cidsByVariation = new Map<string, { label: string; cid: string }[]>();
    for (const r of rows) {
      for (const img of payload.previews?.[r.id] ?? []) {
        if (attachments.length >= MAX_IMAGES) break;
        if (typeof img.base64 !== 'string' || img.base64.length > MAX_PREVIEW_B64 || !/^[A-Za-z0-9+/=]+$/.test(img.base64)) continue;
        const cid = `preview-${attachments.length}`;
        attachments.push({ content: img.base64, filename: `${cid}.png`, type: 'image/png', disposition: 'inline', content_id: cid });
        const list = cidsByVariation.get(r.id) ?? [];
        list.push({ label: String(img.label ?? ''), cid });
        cidsByVariation.set(r.id, list);
      }
    }

    const td = 'padding:14px 0;border-top:1px solid #eee;vertical-align:top;';
    const variationHtml = rows.map((r) => {
      const imgs = (cidsByVariation.get(r.id) ?? []).map((i) =>
        `<div style="display:inline-block;margin:8px 8px 0 0;"><img src="cid:${i.cid}" alt="${esc(r.name)} ${esc(i.label)}" style="display:block;width:220px;max-width:100%;border:1px solid #eee;border-radius:6px;">${i.label ? `<span style="font-size:11px;color:#999;">${esc(i.label)}</span>` : ''}</div>`).join('');
      return `<tr>
        <td style="${td}"><div style="color:#333;font-size:15px;font-weight:600;">${esc(r.name)}</div>${imgs}</td>
        <td style="${td}text-align:right;color:#333;font-size:15px;white-space:nowrap;">&times; ${r.qty}</td>
      </tr>`;
    }).join('');

    const addr = addressLines(ship);
    const box = 'margin:0 0 24px;color:#333;font-size:15px;line-height:1.6;background:#f8f8f8;padding:14px 16px;border-radius:8px;';
    const bodyHtml = `<p style="margin:0 0 20px;color:#333;font-size:16px;">Hi ${esc(approverName)},</p>
      <p style="margin:0 0 24px;color:#555;font-size:15px;line-height:1.6;">Thanks for approving your ${esc(productLabel.toLowerCase())} design for <strong>${esc(eventName)}</strong>. Your order is now being sent to print. As soon as we can, we'll email you a shipping label.</p>
      <h2 style="margin:0 0 8px;font-size:15px;color:#1a1a2e;">Contact</h2>
      <p style="${box}">${esc(contact.name)}<br>${esc(contact.email)}</p>
      <h2 style="margin:0 0 8px;font-size:15px;color:#1a1a2e;">Shipping address</h2>
      <p style="${box}">${addr.length ? addr.map(esc).join('<br>') : 'No shipping address on file.'}</p>
      <h2 style="margin:0 0 8px;font-size:15px;color:#1a1a2e;">What you approved</h2>
      <table style="width:100%;border-collapse:collapse;margin:0 0 8px;">${variationHtml}
        <tr><td style="${td}color:#333;font-size:15px;font-weight:600;">Total ${noun}s</td><td style="${td}text-align:right;color:#333;font-size:15px;font-weight:600;">${total}</td></tr>
      </table>
      <p style="margin:16px 0 0;color:#888;font-size:13px;line-height:1.6;">If anything above is wrong, just reply to this email right away.</p>`;

    const text = [
      `Hi ${approverName},`, '',
      `Thanks for approving your ${productLabel.toLowerCase()} design for ${eventName}. Your order is now being sent to print. As soon as we can, we'll email you a shipping label.`, '',
      'Contact:', contact.name, contact.email, '',
      'Shipping address:', ...(addr.length ? addr : ['No shipping address on file.']), '',
      'What you approved:', ...rows.map((r) => `- ${r.name} x ${r.qty}`), `Total ${noun}s: ${total}`, '',
      'If anything above is wrong, just reply to this email right away.', '',
      PLAIN_TEXT_FOOTER,
    ].join('\n');

    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to, name: approverName || undefined }] }],
        from: { email: FROM_EMAIL, name: FROM_NAME },
        reply_to: { email: FROM_EMAIL, name: FROM_NAME },
        tracking_settings: { click_tracking: { enable: false } },
        subject: `Your ${productLabel.toLowerCase()} order is approved — ${eventName}`,
        content: [
          { type: 'text/plain', value: text },
          { type: 'text/html', value: wrapEmailHtml({ title: 'Order Approved', bodyHtml }) },
        ],
        ...(attachments.length ? { attachments } : {}),
      }),
    });
    if (!res.ok) {
      console.error('SendGrid error', res.status, await res.text());
      return json({ error: 'SendGrid request failed', status: res.status }, 500);
    }
    return json({ ok: true });
  } catch (err) {
    console.error(err);
    return json({ error: String(err) }, 500);
  }
});

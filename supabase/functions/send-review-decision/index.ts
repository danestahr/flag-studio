import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { esc, wrapEmailHtml, ctaButton, linkFallback, PLAIN_TEXT_FOOTER } from '../_shared/email-layout.ts';

// SENDGRID_API_KEY_2 is the current key; SENDGRID_API_KEY is kept as a fallback
// during rotation and can be removed once SENDGRID_API_KEY_2 is confirmed live everywhere.
const SENDGRID_API_KEY = Deno.env.get('SENDGRID_API_KEY_2') ?? Deno.env.get('SENDGRID_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FROM_EMAIL = 'design@gsds.space';
const FROM_NAME = 'Design Studio';
const TO_EMAIL = 'dane@danestahr.com';
const TO_NAME = 'Dane';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
};

type Decision = 'approved' | 'changes_requested';

interface DecisionPayload {
  decision: Decision;
  projectName: string;
  projectId: string;
  projectUrl: string;
  note?: string;
  reviewerName?: string;
  reviewerEmail?: string;
  generalNote?: string;
}

function subjectFor(p: DecisionPayload): string {
  return p.decision === 'approved'
    ? `Proof approved — ready for print — ${p.projectName}`
    : `Changes requested — ${p.projectName}`;
}

function buildHtml(p: DecisionPayload & { safeUrl: string }): string {
  const intro = p.decision === 'approved'
    ? `<strong>${esc(p.projectName)}</strong> has been approved by the client and is ready for print.`
    : `The client has requested changes on <strong>${esc(p.projectName)}</strong>.`;
  const reviewer = p.reviewerName
    ? `<p style="margin:0 0 4px;color:#555;font-size:14px;">Reviewer: ${esc(p.reviewerName)}${p.reviewerEmail ? ` (${esc(p.reviewerEmail)})` : ''}</p>`
    : (p.reviewerEmail ? `<p style="margin:0 0 4px;color:#555;font-size:14px;">Reviewer email: ${esc(p.reviewerEmail)}</p>` : '');
  const note = p.note ? `<p style="margin:16px 0 24px;color:#555;font-size:15px;line-height:1.6;background:#f8f8f8;padding:14px 16px;border-radius:8px;">${esc(p.note)}</p>` : '';
  const generalNote = p.generalNote ? `<p style="margin:8px 0 24px;color:#555;font-size:15px;line-height:1.6;background:#f8f8f8;padding:14px 16px;border-radius:8px;"><strong>General notes:</strong><br>${esc(p.generalNote)}</p>` : '';
  const body = `<p style="margin:0 0 20px;color:#333;font-size:16px;">${intro}</p>
      ${reviewer}
      ${note}
      ${generalNote}
      ${ctaButton(esc(p.safeUrl), 'View Project')}
      ${linkFallback(esc(p.safeUrl))}`;
  return wrapEmailHtml({ title: p.decision === 'approved' ? 'Proof Approved' : 'Changes Requested', bodyHtml: body });
}

function buildText(p: DecisionPayload & { safeUrl: string }): string {
  const intro = p.decision === 'approved'
    ? `${p.projectName} has been approved by the client and is ready for print.`
    : `The client has requested changes on ${p.projectName}.`;
  return [
    intro,
    '',
    ...(p.reviewerName ? [`Reviewer: ${p.reviewerName}${p.reviewerEmail ? ` (${p.reviewerEmail})` : ''}`, ''] : (p.reviewerEmail ? [`Reviewer email: ${p.reviewerEmail}`, ''] : [])),
    ...(p.note ? [p.note, ''] : []),
    ...(p.generalNote ? ['General notes:', p.generalNote, ''] : []),
    `View project: ${p.safeUrl}`,
    '',
    PLAIN_TEXT_FOOTER,
  ].join('\n');
}

async function projectExists(projectId: string): Promise<boolean> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/projects?id=eq.${encodeURIComponent(projectId)}&select=id&limit=1`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) return false;
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  try {
    const payload: DecisionPayload = await req.json();

    if (payload.decision !== 'approved' && payload.decision !== 'changes_requested') {
      return new Response(JSON.stringify({ error: 'Invalid decision' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
    if (!payload.projectName || !payload.projectId) {
      return new Response(JSON.stringify({ error: 'Missing project info' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
    if (!(await projectExists(payload.projectId))) {
      return new Response(JSON.stringify({ error: 'Invalid project' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    let safeUrl: string;
    try {
      const u = new URL(payload.projectUrl);
      const isLocalhost = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocalhost)) {
        throw new Error('not https');
      }
      safeUrl = u.toString();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid project URL' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: TO_EMAIL, name: TO_NAME }] }],
        from: { email: FROM_EMAIL, name: FROM_NAME },
        reply_to: { email: FROM_EMAIL, name: FROM_NAME },
        subject: subjectFor(payload),
        content: [
          { type: 'text/plain', value: buildText({ ...payload, safeUrl }) },
          { type: 'text/html', value: buildHtml({ ...payload, safeUrl }) },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error('SendGrid error', res.status, body);
      return new Response(JSON.stringify({ error: 'SendGrid request failed', status: res.status }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
});

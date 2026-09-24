import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { wrapEmailHtml } from '../_shared/email-layout.ts';

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
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
};

async function projectExists(projectId: string): Promise<boolean> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/projects?id=eq.${encodeURIComponent(projectId)}&select=id&limit=1`,
    { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } },
  );
  if (!res.ok) return false;
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const url = new URL(req.url);
    const projectId = url.searchParams.get('projectId');
    const projectName = url.searchParams.get('projectName') || 'Flag Order';
    const zipBuffer = await req.arrayBuffer();

    if (!projectId || !zipBuffer.byteLength) {
      return new Response(JSON.stringify({ error: 'Missing zip or projectId' }), {
        status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    if (!(await projectExists(projectId))) {
      return new Response(JSON.stringify({ error: 'Invalid project' }), {
        status: 403, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    // Base64 encode the zip for SendGrid attachment
    const bytes = new Uint8Array(zipBuffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    const zipBase64 = btoa(binary);

    const name = projectName;
    const subject = `${name} - Flag Order`;
    const filename = `${name.replace(/[^a-zA-Z0-9_\- ]/g, '_')}-flags.zip`;
    const html = wrapEmailHtml({
      title: name,
      bodyHtml: `<p style="margin:0 0 20px;color:#333;font-size:15px;line-height:1.6;">
      Hey Tom,<br><br>
      Here's the flag order for <strong>${name}</strong>. The zip file is attached and includes everything you should need to know about the order.
    </p>
    <p style="margin:24px 0 0;color:#999;font-size:13px;line-height:1.6;">
      Let me know if you have any questions!
    </p>`,
    });

    const text = `Hey Tom,\n\nHere's the flag order for ${name}. The zip file is attached and includes everything you should need to know about the order.\n\nLet me know if you have any questions!`;

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
        subject,
        content: [
          { type: 'text/plain', value: text },
          { type: 'text/html', value: html },
        ],
        attachments: [{
          content: zipBase64,
          type: 'application/zip',
          filename,
          disposition: 'attachment',
        }],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error('SendGrid error', res.status, body);
      return new Response(JSON.stringify({ error: 'SendGrid failed', status: res.status, detail: body }), {
        status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
});

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

// SENDGRID_API_KEY_2 is the current key; SENDGRID_API_KEY is kept as a fallback
// during rotation and can be removed once SENDGRID_API_KEY_2 is confirmed live everywhere.
const SENDGRID_API_KEY = Deno.env.get('SENDGRID_API_KEY_2') ?? Deno.env.get('SENDGRID_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FROM_EMAIL = 'designstudio@golfstatus.com';
const FROM_NAME = 'GolfStatus Design Studio';
const TO_EMAIL = 'dane@danestahr.com';
const TO_NAME = 'Tom';

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
    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;margin:0;padding:32px 16px;">
<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;">
  <div style="background:#1A4A2E;padding:24px 32px;">
    <p style="margin:0;color:rgba(255,255,255,.6);font-size:12px;text-transform:uppercase;letter-spacing:.08em;">GolfStatus Design Studio</p>
    <h1 style="margin:4px 0 0;color:#fff;font-size:20px;font-weight:600;">${name}</h1>
  </div>
  <div style="padding:32px;">
    <p style="margin:0 0 20px;color:#333;font-size:15px;line-height:1.6;">
      Hey Tom,<br><br>
      Here's the flag order for <strong>${name}</strong>. The zip file is attached and includes everything you should need to know about the order.
    </p>
    <p style="margin:24px 0 0;color:#999;font-size:13px;line-height:1.6;">
      Let me know if you have any questions!
    </p>
  </div>
</div>
</body>
</html>`;

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
        content: [{ type: 'text/html', value: html }],
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

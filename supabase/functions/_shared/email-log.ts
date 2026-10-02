// Records each SendGrid attempt in public.email_log (service role). Never
// throws: a logging failure must not turn a delivered email into an error.
export async function logEmail(entry: {
  kind: string;
  projectId?: string | null;
  recipient: string;
  ok: boolean;
  httpStatus?: number;
  error?: string;
}): Promise<void> {
  try {
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/rest/v1/email_log`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({
        kind: entry.kind,
        project_id: entry.projectId ?? null,
        recipient: entry.recipient,
        status: entry.ok ? 'sent' : 'failed',
        http_status: entry.httpStatus ?? null,
        error: entry.error ? entry.error.slice(0, 2000) : null,
      }),
    });
    if (!res.ok) console.error('email_log insert failed', res.status, await res.text());
  } catch (err) {
    console.error('email_log insert threw', err);
  }
}

// Re-derive the caller's role server-side from their JWT (never trust a client-supplied role).
// Returns 'customer' | 'staff' | 'admin', or null for an anon/invalid token. See CLAUDE.md
// "Three-layer enforcement model" - same approach as send-print-sheet-ready / pipedrive.
export async function getCallerRole(authHeader: string | null): Promise<string | null> {
  if (!authHeader) return null;
  const url = Deno.env.get('SUPABASE_URL')!;
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const userRes = await fetch(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: authHeader } });
  if (!userRes.ok) return null;
  const user = await userRes.json();
  if (!user?.id) return null;
  const res = await fetch(`${url}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=role&limit=1`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) return null;
  return (await res.json())?.[0]?.role ?? null;
}

export async function isStaffOrAdminCaller(authHeader: string | null): Promise<boolean> {
  const role = await getCallerRole(authHeader);
  return role === 'staff' || role === 'admin';
}

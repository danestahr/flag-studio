// Test-send override shared by the request-driven email functions. A payload
// may carry `testTo`; only this one address is honored so the (anon-callable)
// endpoints can't be used to mail arbitrary recipients. The client adds it
// automatically on localhost (see callEdgeFunction in src/supabase.js).
export const TEST_TO_EMAIL = 'dane@danestahr.com';

export function testRedirect(testTo: unknown, realTo: string): { to: string; prefix: string } {
  const isTest = String(testTo ?? '').trim().toLowerCase() === TEST_TO_EMAIL;
  return { to: isTest ? TEST_TO_EMAIL : realTo, prefix: isTest ? '[TEST] ' : '' };
}

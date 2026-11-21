export function onRequestGet({ env }) {
  if (!env.LIFF_ID) return Response.json({ error: 'configuration' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  return Response.json({ liffId: env.LIFF_ID }, { headers: { 'Cache-Control': 'no-store' } });
}

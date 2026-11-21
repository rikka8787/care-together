const DEFAULT_LIFF_ID = '2012741362-xQV1Y9gJ';

export function onRequestGet({ env }) {
  return Response.json({ liffId: env.LIFF_ID || DEFAULT_LIFF_ID }, { headers: { 'Cache-Control': 'no-store' } });
}

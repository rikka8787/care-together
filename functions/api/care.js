const actions = new Set(['session', 'state', 'members', 'member_save', 'member_remove', 'record_add', 'check_set', 'log_add', 'comment_add', 'reaction_set', 'medicine_add', 'medicine_remove', 'appointment_save']);
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const DEFAULT_LINE_CHANNEL_ID = '2012741362';
const reply = (data, status = 200) => Response.json(data, { status, headers });
const userIdPattern = /^U[0-9a-f]{32}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const text = (value, max, required = false) => typeof value === 'string' && value.length <= max && (!required || value.trim().length > 0);
const photo = value => value === '' || (typeof value === 'string' && value.length <= 1400000 && /^data:image\/(?:jpeg|png|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value));
const valueIn = (v, min, max, integer = true) => v === null || (typeof v === 'number' && Number.isFinite(v) && (!integer || Number.isInteger(v)) && v >= min && v <= max);
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const id = value => typeof value === 'string' && uuidPattern.test(value);
async function readBody(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('invalid');
  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 1600000) { await reader.cancel(); throw new Error('too_large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function valid(action, p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  switch (action) {
    case 'session': case 'state': case 'members': return true;
    case 'member_save': return userIdPattern.test(p.userId || '') && text(p.name, 80, true) && typeof p.isAdmin === 'boolean';
    case 'member_remove': return userIdPattern.test(p.userId || '');
    case 'record_add': {
      const timestamp = Date.parse(p.measuredAt);
      return id(p.id) && typeof p.measuredAt === 'string' && Number.isFinite(timestamp) && timestamp <= Date.now() &&
        valueIn(p.systolic,40,300) && valueIn(p.diastolic,20,200) && valueIn(p.pulse,20,250) &&
        valueIn(p.spo2,50,100) && valueIn(p.temperature,30,45,false) &&
        (p.temperature === null || Number.isInteger(Math.round(p.temperature * 10)) && Math.abs(p.temperature * 10 - Math.round(p.temperature * 10)) < 1e-8) &&
        (p.systolic === null) === (p.diastolic === null) && (p.systolic === null || p.systolic > p.diastolic) &&
        [p.systolic,p.pulse,p.spo2,p.temperature].some(v => v !== null) &&
        ['', '早上', '下午', '睡前', '不適時'].includes(p.period) && text(p.note,500) && photo(p.photo);
    }
    case 'check_set': return date(p.day) && ['breakfast','lunch','dinner','morningMedicine','eveningMedicine','bowel'].includes(p.item) && typeof p.done === 'boolean';
    case 'log_add': return id(p.id) && text(p.text,500,true) && photo(p.photo);
    case 'comment_add': return id(p.id) && id(p.targetId) && ['record','log'].includes(p.targetType) && text(p.text,200,true);
    case 'reaction_set': return id(p.targetId) && ['record','log'].includes(p.targetType) && ['thanks','seen'].includes(p.kind) && typeof p.selected === 'boolean';
    case 'medicine_add': return id(p.id) && text(p.name,80,true) && ['飯前','飯後','睡前','依醫囑'].includes(p.timing) && text(p.dose,80,true) && photo(p.photo);
    case 'medicine_remove': return id(p.id);
    case 'appointment_save': return date(p.date) && text(p.department,100,true) && text(p.instructions,500);
    default: return false;
  }
}

export async function onRequestPost({ request, env }) {
  const lineChannelId = env.LINE_CHANNEL_ID || DEFAULT_LINE_CHANNEL_ID;
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
    console.error('Configuration error: missing', !env.SUPABASE_URL ? 'SUPABASE_URL' : 'SUPABASE_SECRET_KEY');
    return reply({ error: 'configuration' }, 503);
  }
  let supabaseUrl;
  try { supabaseUrl = new URL(env.SUPABASE_URL); } catch {
    console.error('Configuration error: invalid SUPABASE_URL');
    return reply({ error:'configuration' },503);
  }
  if (supabaseUrl.protocol !== 'https:' || !supabaseUrl.hostname.endsWith('.supabase.co') || supabaseUrl.username || supabaseUrl.password || supabaseUrl.port || supabaseUrl.pathname !== '/' || supabaseUrl.search || supabaseUrl.hash) {
    console.error('Configuration error: invalid SUPABASE_URL');
    return reply({ error:'configuration' },503);
  }
  const token = request.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1];
  if (!token || token.length > 10000) {
    console.error('LINE authentication error: missing or oversized token');
    return reply({ error: 'unauthorized' }, 401);
  }
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) return reply({ error: 'invalid' }, 400);
  if (Number(request.headers.get('Content-Length') || 0) > 1600000) return reply({ error: 'too_large' }, 413);
  let body;
  try {
    body = await readBody(request);
  } catch (error) { return error.message === 'too_large' ? reply({ error:'too_large' },413) : reply({ error:'invalid' },400); }
  if (!actions.has(body?.action) || !valid(body.action, body.payload)) return reply({ error: 'invalid' }, 400);

  let verified;
  try {
    const response = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method:'POST', headers:{ 'Content-Type':'application/x-www-form-urlencoded' },
      body:new URLSearchParams({ id_token:token, client_id:lineChannelId }), signal:AbortSignal.timeout(10000)
    });
    if (response.status === 400 || response.status === 401) {
      console.error('LINE authentication error: verification rejected', response.status);
      return reply({ error:'unauthorized' },401);
    }
    if (!response.ok) return reply({ error:'identity_unavailable' },503);
    verified = await response.json();
  } catch { return reply({ error:'identity_unavailable' },503); }
  if (!userIdPattern.test(verified?.sub || '') || String(verified?.aud) !== String(lineChannelId) || verified?.iss !== 'https://access.line.me' || !Number.isFinite(verified?.exp) || verified.exp * 1000 <= Date.now()) {
    console.error('LINE authentication error: invalid verified claims', {
      userIdValid: userIdPattern.test(verified?.sub || ''),
      audienceMatches: String(verified?.aud) === String(lineChannelId),
      issuerMatches: verified?.iss === 'https://access.line.me',
      expirationValid: Number.isFinite(verified?.exp) && verified.exp * 1000 > Date.now()
    });
    return reply({ error:'unauthorized' },401);
  }

  try {
    const response = await fetch(`${supabaseUrl.origin}/rest/v1/rpc/care_api`, {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'apikey':env.SUPABASE_SECRET_KEY },
      body:JSON.stringify({ p_actor:verified.sub, p_action:body.action, p_payload:body.payload }), signal:AbortSignal.timeout(15000)
    });
    if (!response.ok) {
      console.error('Supabase care API error', response.status);
      return reply({ error: response.status === 400 ? 'invalid' : 'database_unavailable' }, response.status === 400 ? 400 : 503);
    }
    const result = await response.json();
    if (result?.error === 'forbidden') return reply({ error:'forbidden', userId: verified.sub },403);
    return reply(result);
  } catch (error) {
    console.error('Supabase request failed', error.message);
    return reply({ error:'database_unavailable' },503);
  }
}

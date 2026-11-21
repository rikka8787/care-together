import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost } from '../functions/api/care.js';
import { onRequestGet } from '../functions/api/config.js';

const realFetch = globalThis.fetch;
const env = { LIFF_ID:'liff-id', LINE_CHANNEL_ID:'123456', SUPABASE_URL:'https://example.supabase.co', SUPABASE_SECRET_KEY:'test-server-secret' };
const userId = 'U00000000000000000000000000000001';
const verified = { sub:userId, aud:'123456', iss:'https://access.line.me', exp:Math.floor(Date.now()/1000)+3600 };
const makeRequest = (action,payload={},token='test-token') => new Request('https://care.example/api/care',{
  method:'POST', headers:{'content-type':'application/json',...(token ? {authorization:`Bearer ${token}`} : {})}, body:JSON.stringify({action,payload})
});
const mock = (line=verified, database={records:[]}) => {
  const calls=[];
  globalThis.fetch=async (url,options)=>{
    calls.push({url,options});
    return Response.json(url.startsWith('https://api.line.me/') ? line : database);
  };
  return calls;
};
afterEach(()=>{ globalThis.fetch=realFetch; });

test('configuration endpoint exposes only LIFF ID',async()=>{
  const result=await onRequestGet({env});
  assert.deepEqual(await result.json(),{liffId:'liff-id'});
  const configured=await onRequestGet({env:{}});
  assert.deepEqual(await configured.json(),{liffId:'2012741362-xQV1Y9gJ'});
});
test('rejects missing token without touching external services',async()=>{
  const calls=mock();
  const result=await onRequestPost({request:makeRequest('state',{},null),env});
  assert.equal(result.status,401); assert.equal(calls.length,0);
});
test('refuses non-Supabase or insecure URLs before transmitting a secret',async()=>{
  const calls=mock();
  for (const url of ['http://example.supabase.co','https://example.supabase.co.attacker.invalid','https://attacker.invalid']) {
    const response=await onRequestPost({request:makeRequest('state'),env:{...env,SUPABASE_URL:url}});
    assert.equal(response.status,503);
  }
  assert.equal(calls.length,0);
});
test('validates LINE claims and never trusts a caller-supplied user ID',async()=>{
  const calls=mock();
  const result=await onRequestPost({request:makeRequest('state',{userId:'Uffffffffffffffffffffffffffffffff'}),env});
  assert.equal(result.status,200); assert.equal(calls.length,2);
  const request=JSON.parse(calls[1].options.body);
  assert.equal(request.p_actor,userId);
  assert.equal(calls[1].options.headers.apikey,env.SUPABASE_SECRET_KEY);
});
test('uses the provided LINE Channel ID when no environment override is set',async()=>{
  const channelId='2012741362';
  const calls=mock({...verified,aud:channelId});
  const response=await onRequestPost({request:makeRequest('state'),env:{...env,LINE_CHANNEL_ID:undefined}});
  assert.equal(response.status,200);
  assert.equal(new URLSearchParams(calls[0].options.body).get('client_id'),channelId);
});
test('rejects mismatched audience or expired LINE token before database access',async()=>{
  for (const claims of [{...verified,aud:'wrong'},{...verified,exp:1}]) {
    const calls=mock(claims);
    const response=await onRequestPost({request:makeRequest('state'),env});
    assert.equal(response.status,401); assert.equal(calls.length,1);
  }
});
test('denied identity returns only the verified caller ID',async()=>{
  mock(verified,{error:'forbidden'});
  const response=await onRequestPost({request:makeRequest('state'),env});
  assert.equal(response.status,403);
  assert.deepEqual(await response.json(),{error:'forbidden',userId});
});
test('accepts a blood-pressure-only record and rejects partial pressure and unsafe photos',async()=>{
  const record={id:'10000000-0000-4000-8000-000000000001',measuredAt:'2026-01-01T10:00:00Z',systolic:120,diastolic:80,pulse:null,spo2:null,temperature:null,period:'',note:'',photo:''};
  mock();
  assert.equal((await onRequestPost({request:makeRequest('record_add',record),env})).status,200);
  assert.equal((await onRequestPost({request:makeRequest('record_add',{...record,diastolic:null}),env})).status,400);
  assert.equal((await onRequestPost({request:makeRequest('record_add',{...record,photo:'data:image/svg+xml;base64,PHN2Zz4='}),env})).status,400);
});
test('returns service failure when LINE cannot be reached',async()=>{
  globalThis.fetch=async()=>{throw new Error('offline');};
  assert.equal((await onRequestPost({request:makeRequest('state'),env})).status,503);
});
test('rejects an oversized body without calling identity provider',async()=>{
  const calls=mock();
  const request=makeRequest('log_add',{text:'x'.repeat(1600001)});
  assert.equal((await onRequestPost({request,env})).status,413);
  assert.equal(calls.length,0);
});

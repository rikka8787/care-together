import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenExpired, reauthenticate, clearReauthenticationAttempt } from '../public/auth.js';

const storage = () => {
  const entries = new Map();
  return {
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: key => entries.delete(key)
  };
};

test('only treats a known expired ID token as expired', () => {
  assert.equal(tokenExpired({getDecodedIDToken:()=>({exp:Math.floor(Date.now()/1000)-1})}),true);
  assert.equal(tokenExpired({getDecodedIDToken:()=>({exp:Math.floor(Date.now()/1000)+60})}),false);
  assert.equal(tokenExpired({getDecodedIDToken:()=>null}),false);
});

test('reauthenticates once in an external browser and stops redirect loops', () => {
  const calls = [];
  const liff = {isInClient:()=>false, logout:()=>calls.push('logout'), login:options=>calls.push(options)};
  const store = storage();
  const location = {origin:'https://care.example',pathname:'/'};
  assert.equal(reauthenticate(liff,store,location),true);
  assert.equal(reauthenticate(liff,store,location),false);
  assert.deepEqual(calls,['logout',{redirectUri:'https://care.example/'}]);
  clearReauthenticationAttempt(store);
  assert.equal(reauthenticate(liff,store,location),true);
});

test('reinitializes once in a LIFF browser without invoking login or logout', () => {
  let reloads = 0;
  const store = storage();
  const liff = {isInClient:()=>true};
  const location = {reload:()=>reloads++};
  assert.equal(reauthenticate(liff,store,location),true);
  assert.equal(reauthenticate(liff,store,location),false);
  assert.equal(reloads,1);
});

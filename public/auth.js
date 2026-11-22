const retryKey = 'care-together-liff-expiry-retry';

export function tokenExpired(liff) {
  const claims = liff.getDecodedIDToken();
  return Number.isFinite(claims?.exp) && claims.exp * 1000 <= Date.now();
}

export function reauthenticate(liff, storage, location) {
  if (storage.getItem(retryKey)) return false;
  storage.setItem(retryKey, '1');
  if (liff.isInClient()) {
    location.reload();
  } else {
    liff.logout();
    liff.login({ redirectUri: location.origin + location.pathname });
  }
  return true;
}

export function clearReauthenticationAttempt(storage) {
  storage.removeItem(retryKey);
}

/**
 * License manager — Mikaju Payroll.
 *
 * Entitlement (free / basic / enterprise) has to be checkable WITHOUT a
 * network connection, since this is an offline-first desktop app. The
 * `license-issue` edge function signs a compact token with the server-side
 * ECDSA private key (MIKAJU_LICENSE_PRIVATE_KEY); this module verifies that
 * signature locally against the committed publicKey.json. Nobody can forge
 * an "enterprise" entitlement without the private key, even fully offline.
 *
 * Token shape (JSON, base64url-encoded, ES256-signed — same structure as a
 * JWT but we roll our own tiny verifier so this file has zero dependencies
 * beyond Node's built-in crypto):
 *   { companyId, plan: 'free'|'basic'|'enterprise', issuedAt, expiresAt }
 *
 * GRACE PERIOD: if the cached token has expired but the app can't reach the
 * server to refresh it (offline), we allow a 14-day grace period at the
 * last-known plan before silently downgrading to 'free'. This avoids
 * punishing a paying, offline user while still bounding how long a token
 * can be relied on without server contact.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PUBLIC_KEY_JWK = JSON.parse(fs.readFileSync(path.join(__dirname, 'publicKey.json'), 'utf8'));
const GRACE_PERIOD_MS = 14 * 24 * 60 * 60 * 1000;

let _publicKeyObj = null;
function publicKey() {
  if (!_publicKeyObj) {
    _publicKeyObj = crypto.createPublicKey({ key: PUBLIC_KEY_JWK, format: 'jwk' });
  }
  return _publicKeyObj;
}

function b64urlToBuf(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Verifies a signed entitlement token. Returns the parsed payload if the
 * signature is valid, or null if it isn't (tampered, wrong key, malformed).
 * Does NOT check expiry — callers decide how to treat an expired-but-valid
 * token (see GRACE_PERIOD_MS above).
 */
function verifyToken(token) {
  try {
    const [payloadB64, sigB64] = token.split('.');
    if (!payloadB64 || !sigB64) return null;

    const signature = b64urlToBuf(sigB64);
    const verified = crypto.verify(
      null, // ES256 uses the hash embedded in the key algorithm
      Buffer.from(payloadB64),
      { key: publicKey(), dsaEncoding: 'ieee-p1363' },
      signature
    );
    if (!verified) return null;

    return JSON.parse(b64urlToBuf(payloadB64).toString('utf8'));
  } catch {
    return null;
  }
}

function loadCachedToken() {
  const { getDb } = require('../db');
  const row = getDb().prepare("select value from app_meta where key = 'license_token'").get();
  return row ? row.value : null;
}

function setCachedEntitlement(responseBody) {
  // license-issue returns { token: '<payload>.<signature>' }
  const token = typeof responseBody === 'string' ? responseBody : responseBody.token;
  if (!token || !verifyToken(token)) {
    console.warn('[Mikaju] Rejected license token — invalid signature.');
    return;
  }
  const { getDb } = require('../db');
  getDb()
    .prepare(
      "insert into app_meta (key,value) values ('license_token',?) on conflict(key) do update set value=excluded.value"
    )
    .run(token);
}

/**
 * The single function the rest of the app (IPC handler, payslip PDF
 * generator) should call. Never throws — always returns a usable
 * entitlement, defaulting to 'free' when nothing valid is available.
 */
function getCurrentEntitlement() {
  const FREE = { plan: 'free', companyId: null, source: 'default' };

  const token = loadCachedToken();
  if (!token) return FREE;

  const payload = verifyToken(token);
  if (!payload) return FREE; // corrupted or tampered cache — do not trust it

  const now = Date.now();
  const expiresAt = new Date(payload.expiresAt).getTime();

  if (now <= expiresAt) {
    return { ...payload, source: 'verified' };
  }
  if (now <= expiresAt + GRACE_PERIOD_MS) {
    return { ...payload, source: 'grace-period', graceExpiresAt: new Date(expiresAt + GRACE_PERIOD_MS).toISOString() };
  }
  return FREE; // expired past grace — downgrade until we can reach the server again
}

module.exports = { getCurrentEntitlement, setCachedEntitlement, verifyToken };

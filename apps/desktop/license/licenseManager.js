/**
 * License manager — Mikaju Payroll.
 *
 * Verifies the entitlement token issued by the license-issue edge function
 * WITHOUT needing a network connection, since this is an offline-first
 * desktop app. Nobody can forge a paid entitlement offline without the
 * server-side ECDSA private key (MIKAJU_LICENSE_PRIVATE_KEY) — this module
 * only holds the matching public key and verifies signatures against it.
 *
 * REAL wire format (confirmed from the deployed license-issue source,
 * 2026-08-21 — this comment exists because an earlier version of this file
 * was written against an invented format that didn't match the deployed
 * function at all):
 *
 *   { payload: { company_id, plan_tier, employee_limit, issued_at, expires_at },
 *     signature: "<base64url, no padding, IEEE-P1363 raw r||s>" }
 *
 * Signature covers JSON.stringify(payload) exactly as constructed server-
 * side — company_id, plan_tier, employee_limit, issued_at, expires_at, in
 * that insertion order. Verification re-serializes the payload object we
 * received (JS preserves string-key insertion order from JSON.parse) and
 * checks it against the same bytes. Signed with ECDSA P-256 / SHA-256 via
 * Deno's Web Crypto — verified here with the same explicit digest, not a
 * null/implicit one, so a Node crypto default can never silently diverge
 * from what the server actually used.
 *
 * GRACE PERIOD: license-issue itself already bakes a short validity window
 * into expires_at (7 days for active, 2 for past_due, 30 for free — see
 * its GRACE_DAYS map), based on subscription health. On top of that, this
 * module adds a further 14-day OFFLINE grace period after expires_at, so a
 * paying customer who can't reach the internet for two weeks (travel, a
 * bad connection) doesn't get silently downgraded mid-trip. These are two
 * different concerns: the server's window reflects subscription health;
 * this module's window reflects "we simply haven't been able to ask".
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PUBLIC_KEY_JWK = JSON.parse(fs.readFileSync(path.join(__dirname, 'publicKey.json'), 'utf8'));
const OFFLINE_GRACE_PERIOD_MS = 14 * 24 * 60 * 60 * 1000;

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
 * Verifies a { payload, signature } envelope. Returns the payload object
 * (with the server's real field names — company_id, plan_tier, etc.) if
 * the signature checks out, or null if it doesn't (tampered, wrong key,
 * malformed, or re-serialization didn't match — see canonicalization note
 * above). Does NOT check expiry — callers decide how to treat that.
 */
function verifyToken(envelope) {
  try {
    const { payload, signature } = typeof envelope === 'string' ? JSON.parse(envelope) : envelope;
    if (!payload || !signature) return null;

    const canonicalBytes = Buffer.from(JSON.stringify(payload));
    const sigBuf = b64urlToBuf(signature);

    const verified = crypto.verify(
      'sha256',
      canonicalBytes,
      { key: publicKey(), dsaEncoding: 'ieee-p1363' },
      sigBuf
    );
    return verified ? payload : null;
  } catch {
    return null;
  }
}

function loadCachedEnvelope() {
  const { getDb } = require('../db');
  const row = getDb().prepare("select value from app_meta where key = 'license_token'").get();
  return row ? row.value : null;
}

/**
 * Called by syncEngine.js with the raw { payload, signature } body
 * returned by license-issue. Rejects and discards anything that doesn't
 * verify — a corrupted or tampered cache must never silently grant access.
 */
function setCachedEntitlement(responseBody) {
  if (!verifyToken(responseBody)) {
    console.warn('[Mikaju] Rejected license token — invalid signature.');
    return;
  }
  const { getDb } = require('../db');
  getDb()
    .prepare(
      "insert into app_meta (key,value) values ('license_token',?) on conflict(key) do update set value=excluded.value"
    )
    .run(JSON.stringify(responseBody));
}

/**
 * The single function the rest of the app (IPC handler, payslip PDF
 * generator, employee-limit enforcement) should call. Never throws —
 * always returns a usable entitlement, defaulting to 'free' when nothing
 * valid is available. Translates the server's field names into a stable
 * internal shape ONCE, here, so the rest of the codebase never has to
 * know or care that the wire format uses snake_case Postgres-style names.
 */
function getCurrentEntitlement() {
  const FREE = { plan: 'free', companyId: null, employeeLimit: 3, source: 'default' };

  const envelope = loadCachedEnvelope();
  if (!envelope) return FREE;

  const payload = verifyToken(envelope);
  if (!payload) return FREE; // corrupted or tampered cache — do not trust it

  const now = Date.now();
  const expiresAt = new Date(payload.expires_at).getTime();

  const normalized = {
    plan: payload.plan_tier,
    companyId: payload.company_id,
    employeeLimit: payload.employee_limit ?? null, // null = unlimited (enterprise)
  };

  if (now <= expiresAt) {
    return { ...normalized, source: 'verified' };
  }
  if (now <= expiresAt + OFFLINE_GRACE_PERIOD_MS) {
    return { ...normalized, source: 'grace-period', graceExpiresAt: new Date(expiresAt + OFFLINE_GRACE_PERIOD_MS).toISOString() };
  }
  return FREE; // expired past grace — downgrade until we can reach the server again
}

module.exports = { getCurrentEntitlement, setCachedEntitlement, verifyToken };

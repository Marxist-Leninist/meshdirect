// WebAuthn / passkey support (Windows Hello, Touch ID, security keys).
//
// Deliberately dependency-free: node:crypto covers everything we need.
// We avoid CBOR entirely by taking the SPKI public key straight from the
// browser's AuthenticatorAttestationResponse.getPublicKey(), which Chrome/Edge
// (and therefore Windows Hello) provide. Registration is only reachable from an
// already-authenticated session, so a client-supplied key at *enrolment* time
// adds no new trust; every later login is verified against that stored key.
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_CREDENTIALS = 20;

// COSE algorithm identifiers we accept.
const ALG = { ES256: -7, EDDSA: -8, RS256: -257 };
const SUPPORTED_ALGS = [ALG.ES256, ALG.RS256, ALG.EDDSA];

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const unb64url = (s) => Buffer.from(String(s || ''), 'base64url');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------- credentials

class CredentialStore {
  constructor(storePath) {
    this.storePath = storePath;
    this.creds = new Map(); // credId(b64url) -> record
    this.load();
  }

  load() {
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(this.storePath, 'utf8')); } catch { return; }
    if (!parsed || !Array.isArray(parsed.credentials)) return;
    for (const c of parsed.credentials) {
      if (!c || typeof c.id !== 'string' || typeof c.publicKeySpki !== 'string') continue;
      if (typeof c.username !== 'string') continue;
      this.creds.set(c.id, {
        id: c.id,
        username: c.username,
        publicKeySpki: c.publicKeySpki,
        alg: Number(c.alg),
        signCount: Number(c.signCount) || 0,
        label: typeof c.label === 'string' ? c.label : 'Passkey',
        createdAt: Number(c.createdAt) || Date.now(),
        lastUsedAt: Number(c.lastUsedAt) || 0,
      });
    }
  }

  save() {
    const payload = { version: 1, credentials: [...this.creds.values()] };
    const tmp = `${this.storePath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
      fs.renameSync(tmp, this.storePath);
    } catch (e) {
      console.error('[meshdirect] passkey store write failed:', e.message);
    }
  }

  add(record) {
    if (this.creds.size >= MAX_CREDENTIALS && !this.creds.has(record.id)) {
      throw new Error('passkey limit reached');
    }
    this.creds.set(record.id, record);
    this.save();
  }

  get(id) { return this.creds.get(id) || null; }
  remove(id) { const ok = this.creds.delete(id); if (ok) this.save(); return ok; }
  listFor(username) { return [...this.creds.values()].filter((c) => c.username === username); }
  get size() { return this.creds.size; }
}

// ----------------------------------------------------------------- challenges

// In-memory and single-use. A restart invalidates outstanding ceremonies, which
// is correct: a challenge older than the process has no one waiting on it.
class ChallengeStore {
  constructor() {
    this.pending = new Map(); // challenge(b64url) -> {kind, username, expiresAt}
    const t = setInterval(() => this.prune(), 60 * 1000);
    t.unref();
  }

  issue(kind, username) {
    const challenge = b64url(crypto.randomBytes(32));
    this.pending.set(challenge, { kind, username: username || null, expiresAt: Date.now() + CHALLENGE_TTL_MS });
    return challenge;
  }

  // Single-use: consuming removes it, so a replayed assertion cannot succeed.
  consume(challenge, kind) {
    const key = String(challenge || '');
    const row = this.pending.get(key);
    if (!row) return null;
    this.pending.delete(key);
    if (row.expiresAt <= Date.now()) return null;
    if (row.kind !== kind) return null;
    return row;
  }

  prune() {
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.expiresAt <= now) this.pending.delete(k);
  }
}

// ------------------------------------------------------------- ceremony parts

function parseClientData(clientDataJSONb64, expectedType, expectedChallenge, allowedOrigins) {
  let data;
  try {
    data = JSON.parse(unb64url(clientDataJSONb64).toString('utf8'));
  } catch {
    throw new Error('clientDataJSON is not valid JSON');
  }
  if (data.type !== expectedType) throw new Error(`unexpected ceremony type ${data.type}`);
  if (!timingSafeEqualStr(data.challenge, expectedChallenge)) throw new Error('challenge mismatch');
  if (!allowedOrigins.includes(data.origin)) throw new Error(`origin not allowed: ${data.origin}`);
  return data;
}

// authenticatorData layout: rpIdHash(32) flags(1) signCount(4) [attestedCredentialData…]
function parseAuthenticatorData(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 37) throw new Error('authenticatorData too short');
  const flags = buf[32];
  return {
    rpIdHash: buf.subarray(0, 32),
    flags,
    userPresent: !!(flags & 0x01),
    userVerified: !!(flags & 0x04),
    signCount: buf.readUInt32BE(33),
  };
}

function assertRpAndPresence(authData, rpId, requireUserVerification) {
  if (!authData.rpIdHash.equals(sha256(Buffer.from(rpId, 'utf8')))) {
    throw new Error('RP ID hash mismatch');
  }
  if (!authData.userPresent) throw new Error('user presence flag not set');
  if (requireUserVerification && !authData.userVerified) {
    throw new Error('user verification required but not performed');
  }
}

function publicKeyFromSpki(spkiB64url) {
  return crypto.createPublicKey({ key: unb64url(spkiB64url), format: 'der', type: 'spki' });
}

function verifySignature(alg, publicKey, signedData, signature) {
  if (alg === ALG.ES256) {
    // WebAuthn ES256 signatures are ASN.1 DER, which is node's default.
    return crypto.verify('sha256', signedData, { key: publicKey, dsaEncoding: 'der' }, signature);
  }
  if (alg === ALG.RS256) {
    return crypto.verify('sha256', signedData, publicKey, signature);
  }
  if (alg === ALG.EDDSA) {
    return crypto.verify(null, signedData, publicKey, signature);
  }
  throw new Error(`unsupported algorithm ${alg}`);
}

// --------------------------------------------------------------------- module

function initWebAuthn(config) {
  const storePath = config.webauthnStorePath
    || path.join(config.sessionsDir || '/opt/meshdirect/sessions', 'webauthn-credentials.json');
  const credentials = new CredentialStore(storePath);
  const challenges = new ChallengeStore();

  const rpId = config.webauthnRpId;
  const rpName = config.webauthnRpName || config.modelLabel || 'MeshDirect';
  const origins = config.originAllow.slice();
  const requireUv = config.webauthnRequireUserVerification !== false;

  function registrationOptions(username) {
    const challenge = challenges.issue('registration', username);
    return {
      challenge,
      rp: { id: rpId, name: rpName },
      user: {
        // Stable per-username handle: re-registering replaces rather than piles up
        // credentials inside the authenticator.
        id: b64url(sha256(Buffer.from(`meshdirect:${username}`, 'utf8')).subarray(0, 16)),
        name: username,
        displayName: username,
      },
      pubKeyCredParams: SUPPORTED_ALGS.map((alg) => ({ type: 'public-key', alg })),
      timeout: CHALLENGE_TTL_MS,
      attestation: 'none',
      authenticatorSelection: {
        // platform => Windows Hello / Touch ID rather than a roaming key.
        authenticatorAttachment: 'platform',
        residentKey: 'preferred',
        requireResidentKey: false,
        userVerification: requireUv ? 'required' : 'preferred',
      },
      excludeCredentials: credentials.listFor(username).map((c) => ({ type: 'public-key', id: c.id })),
    };
  }

  function verifyRegistration(username, body) {
    const { id, clientDataJSON, authenticatorData, publicKeySpki, alg, label } = body || {};
    if (typeof id !== 'string' || !id) throw new Error('missing credential id');
    if (typeof publicKeySpki !== 'string' || !publicKeySpki) {
      throw new Error('missing public key (browser did not expose getPublicKey)');
    }
    const algNum = Number(alg);
    if (!SUPPORTED_ALGS.includes(algNum)) throw new Error(`unsupported algorithm ${alg}`);

    // Challenge must be one we issued for *registration*, and it is burned here.
    let clientData;
    try {
      clientData = JSON.parse(unb64url(clientDataJSON).toString('utf8'));
    } catch {
      throw new Error('clientDataJSON is not valid JSON');
    }
    const row = challenges.consume(clientData.challenge, 'registration');
    if (!row) throw new Error('unknown or expired challenge');
    if (row.username !== username) throw new Error('challenge was issued for a different user');

    parseClientData(clientDataJSON, 'webauthn.create', clientData.challenge, origins);
    const authData = parseAuthenticatorData(unb64url(authenticatorData));
    assertRpAndPresence(authData, rpId, requireUv);

    // Reject a key we cannot actually parse, so a broken enrolment can never
    // become an un-loginable credential.
    let parsedKey;
    try { parsedKey = publicKeyFromSpki(publicKeySpki); } catch (e) {
      throw new Error(`public key is not valid SPKI: ${e.message}`);
    }
    if (!parsedKey) throw new Error('public key could not be parsed');

    const record = {
      id,
      username,
      publicKeySpki,
      alg: algNum,
      signCount: authData.signCount,
      label: (typeof label === 'string' && label.trim()) ? label.trim().slice(0, 64) : 'Windows Hello',
      createdAt: Date.now(),
      lastUsedAt: 0,
    };
    credentials.add(record);
    return publicRecord(record);
  }

  function loginOptions() {
    const challenge = challenges.issue('assertion', null);
    return {
      challenge,
      rpId,
      timeout: CHALLENGE_TTL_MS,
      userVerification: requireUv ? 'required' : 'preferred',
      // No allowCredentials: discoverable credentials let the browser offer the
      // right passkey without us naming an account first.
      allowCredentials: [],
    };
  }

  function verifyAssertion(body) {
    const { id, clientDataJSON, authenticatorData, signature } = body || {};
    if (typeof id !== 'string' || !id) throw new Error('missing credential id');

    const cred = credentials.get(id);
    if (!cred) throw new Error('unknown credential');

    let clientData;
    try { clientData = JSON.parse(unb64url(clientDataJSON).toString('utf8')); } catch {
      throw new Error('clientDataJSON is not valid JSON');
    }
    const row = challenges.consume(clientData.challenge, 'assertion');
    if (!row) throw new Error('unknown or expired challenge');

    parseClientData(clientDataJSON, 'webauthn.get', clientData.challenge, origins);

    const authDataBuf = unb64url(authenticatorData);
    const authData = parseAuthenticatorData(authDataBuf);
    assertRpAndPresence(authData, rpId, requireUv);

    const signedData = Buffer.concat([authDataBuf, sha256(unb64url(clientDataJSON))]);
    const ok = verifySignature(cred.alg, publicKeyFromSpki(cred.publicKeySpki), signedData, unb64url(signature));
    if (!ok) throw new Error('signature verification failed');

    // Clone detection. Many platform authenticators legitimately report 0, so a
    // zero counter is not evidence of anything and must not lock the user out.
    if (authData.signCount !== 0 || cred.signCount !== 0) {
      if (authData.signCount <= cred.signCount) {
        console.warn(`[meshdirect] passkey ${id.slice(0, 12)}… sign count did not advance ` +
          `(${cred.signCount} -> ${authData.signCount}); possible clone`);
      }
    }
    cred.signCount = Math.max(cred.signCount, authData.signCount);
    cred.lastUsedAt = Date.now();
    credentials.save();

    return { username: cred.username, credential: publicRecord(cred) };
  }

  function publicRecord(c) {
    return {
      id: c.id,
      label: c.label,
      createdAt: c.createdAt,
      lastUsedAt: c.lastUsedAt,
      alg: c.alg,
    };
  }

  return {
    rpId,
    credentials,
    challenges,
    registrationOptions,
    verifyRegistration,
    loginOptions,
    verifyAssertion,
    list: (username) => credentials.listFor(username).map(publicRecord),
    remove: (username, id) => {
      const c = credentials.get(id);
      if (!c || c.username !== username) return false;
      return credentials.remove(id);
    },
    hasAny: () => credentials.size > 0,
  };
}

module.exports = { initWebAuthn, ALG, SUPPORTED_ALGS };

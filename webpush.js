'use strict';
/**
 * Web Push tanpa dependensi (Node >= 22): VAPID (RFC 8292) + enkripsi payload aes128gcm (RFC 8291).
 * Dipakai server.js untuk mengirim notifikasi ke HP (Chrome/Android, Firefox, Edge, Safari iOS 16.4+ PWA).
 */
const crypto = require('crypto');

const b64u = (b) => Buffer.from(b).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s || ''), 'base64url');

// Hanya layanan push resmi browser yang boleh dituju (mencegah SSRF lewat endpoint buatan).
const BASE_HOSTS = [
  /(^|\.)googleapis\.com$/i,            // Chrome / Android / Opera / Samsung (FCM)
  /(^|\.)push\.services\.mozilla\.com$/i, // Firefox
  /(^|\.)push\.apple\.com$/i,           // Safari / iOS
  /(^|\.)notify\.windows\.com$/i,       // Edge (WNS)
];
function hostAllowed(endpoint, extra) {
  let u; try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  if (u.port && u.port !== '443') return false;
  const rules = BASE_HOSTS.concat((extra || []).map((h) => new RegExp('(^|\\.)' + h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i')));
  return rules.some((re) => re.test(u.hostname));
}

function loadVapid(kvGet, kvSet) {
  try {
    const saved = JSON.parse(kvGet('vapid') || 'null');
    if (saved && saved.privateJwk) {
      const privateKey = crypto.createPrivateKey({ key: saved.privateJwk, format: 'jwk' });
      return { privateKey, publicKey: saved.publicKey };
    }
  } catch {}
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const publicKey = b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)]));
  kvSet('vapid', JSON.stringify({ privateJwk: jwk, publicKey }));
  return { privateKey, publicKey };
}

// Enkripsi payload sesuai RFC 8291. `fixed` hanya untuk pengujian (kunci ephemeral & salt tetap).
function encrypt(payload, p256dhB64, authB64, fixed) {
  const uaPublic = fromB64u(p256dhB64), authSecret = fromB64u(authB64);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) throw new Error('Kunci langganan tidak valid');
  const ecdh = crypto.createECDH('prime256v1');
  if (fixed && fixed.asPrivate) ecdh.setPrivateKey(fixed.asPrivate); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = fixed && fixed.salt ? fixed.salt : crypto.randomBytes(16);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const data = Buffer.concat([Buffer.from(payload), Buffer.from([2])]);   // 0x02 = pembatas record terakhir
  if (data.length > 3990) throw new Error('Payload terlalu besar');
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(data), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

function init({ db, kvGet, kvSet, subject, extraHosts, log }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user', user_id INTEGER, guest_id TEXT, ua TEXT DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(endpoint, role)
    );
    CREATE INDEX IF NOT EXISTS idx_ps_user ON push_subs(user_id);
    CREATE INDEX IF NOT EXISTS idx_ps_guest ON push_subs(guest_id);
    CREATE INDEX IF NOT EXISTS idx_ps_role ON push_subs(role);
  `);
  const vapid = loadVapid(kvGet, kvSet);
  const say = log || (() => {});
  const MAX_SUBS = 20000;

  function jwt(aud) {
    const h = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const c = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject() }));
    const sig = crypto.sign('sha256', Buffer.from(h + '.' + c), { key: vapid.privateKey, dsaEncoding: 'ieee-p1363' });
    return h + '.' + c + '.' + b64u(sig);
  }

  async function sendOne(sub, payload, opts) {
    const o = opts || {};
    const body = encrypt(JSON.stringify(payload), sub.p256dh, sub.auth);
    const aud = new URL(sub.endpoint).origin;
    const r = await fetch(sub.endpoint, {
      method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: {
        'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
        TTL: String(o.ttl || 86400), Urgency: o.urgency || 'normal',
        Authorization: 'vapid t=' + jwt(aud) + ', k=' + vapid.publicKey,
      },
    });
    if (r.status === 404 || r.status === 410) { db.prepare('DELETE FROM push_subs WHERE id=?').run(sub.id); return 'gone'; }
    if (!r.ok) { say('[PUSH] ' + r.status + ' dari ' + aud); return 'fail'; }
    return 'ok';
  }

  async function sendMany(subs, payload, opts) {
    let ok = 0; const queue = subs.slice();
    const worker = async () => {
      for (let s = queue.shift(); s; s = queue.shift()) {
        if (!hostAllowed(s.endpoint, extraHosts)) { db.prepare('DELETE FROM push_subs WHERE id=?').run(s.id); continue; }
        try { if ((await sendOne(s, payload, opts)) === 'ok') ok++; } catch (e) { say('[PUSH] gagal: ' + (e && e.message)); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, subs.length) }, worker));
    return ok;
  }

  const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
  const clean = (p) => ({ title: clip(p.title, 80), body: clip(p.body, 220), url: clip(p.url || '/', 300), tag: clip(p.tag || '', 80), icon: clip(p.icon || '', 400) });
  const fire = (subs, payload, opts) => { if (!subs.length) return Promise.resolve(0); return sendMany(subs, clean(payload), opts).catch((e) => { say('[PUSH] ' + (e && e.message)); return 0; }); };

  return {
    publicKey: vapid.publicKey,
    hostAllowed: (e) => hostAllowed(e, extraHosts),
    canAdd: () => db.prepare('SELECT COUNT(*) AS n FROM push_subs').get().n < MAX_SUBS,
    save({ endpoint, p256dh, auth, role, userId, guestId, ua }) {
      const ts = new Date().toISOString();
      db.prepare(`INSERT INTO push_subs(endpoint,p256dh,auth,role,user_id,guest_id,ua,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(endpoint, role) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth, user_id=excluded.user_id, guest_id=excluded.guest_id, ua=excluded.ua, updated_at=excluded.updated_at`)
        .run(endpoint, p256dh, auth, role, userId || null, guestId || null, clip(ua, 200), ts, ts);
      // satu perangkat = satu pemilik: langganan lama endpoint yang sama dengan peran lain tetap boleh (admin + pembeli di HP yang sama)
    },
    remove(endpoint, role) { db.prepare('DELETE FROM push_subs WHERE endpoint=? AND role=?').run(endpoint, role); },
    find: (endpoint, role) => db.prepare('SELECT * FROM push_subs WHERE endpoint=? AND role=?').get(endpoint, role),
    toAdmins: (payload, opts) => fire(db.prepare("SELECT * FROM push_subs WHERE role='admin'").all(), payload, opts),
    toUser: (userId, payload, opts) => fire(db.prepare("SELECT * FROM push_subs WHERE role='user' AND user_id=?").all(userId), payload, opts),
    toGuest: (guestId, payload, opts) => fire(db.prepare("SELECT * FROM push_subs WHERE role='user' AND user_id IS NULL AND guest_id=?").all(guestId), payload, opts),
    toEveryone: (payload, opts) => fire(db.prepare("SELECT * FROM push_subs WHERE role='user'").all(), payload, opts),
    toOne: (sub, payload, opts) => fire([sub], payload, opts),
  };
}

module.exports = { init, encrypt, hostAllowed };

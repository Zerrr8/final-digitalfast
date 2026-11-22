'use strict';
/**
 * LuthzzStore server — zero dependency (Node.js >= 22.13).
 * Database: SQLite bawaan Node (node:sqlite) -> file tunggal di ./data/store.db
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- .env loader (tanpa dotenv) ----------
(function loadEnv() {
  const f = path.join(__dirname, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
})();

let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); }
catch {
  console.error('[ERROR] Node.js ' + process.version + ' tidak mendukung node:sqlite. Gunakan Node.js 22.13+ (disarankan 22 atau 24).');
  process.exit(1);
}

const PORT = parseInt(process.env.SERVER_PORT || process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_PATH = path.resolve(__dirname, process.env.DB_PATH || './data/store.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// ---------- Database ----------
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'Lainnya',
    price INTEGER NOT NULL, old_price INTEGER, image TEXT DEFAULT '', badge TEXT,
    rating REAL DEFAULT 0, stock INTEGER DEFAULT 0, description TEXT DEFAULT '', created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS categories (position INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
  CREATE TABLE IF NOT EXISTS banners (
    position INTEGER PRIMARY KEY, tag TEXT, title TEXT, desc TEXT, bg TEXT, cta TEXT
  );
  CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL DEFAULT 'info', title TEXT NOT NULL, message TEXT NOT NULL DEFAULT '',
    cta_text TEXT DEFAULT '', cta_url TEXT DEFAULT '', image TEXT DEFAULT '', active INTEGER NOT NULL DEFAULT 1, created_at TEXT, updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS orders (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, customer TEXT NOT NULL, phone TEXT NOT NULL,
    address TEXT, payment TEXT, items INTEGER NOT NULL, total INTEGER NOT NULL,
    detail TEXT, status TEXT NOT NULL DEFAULT 'pending', date TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
    pass_hash TEXT, google_sub TEXT UNIQUE, picture TEXT DEFAULT '', created_at TEXT NOT NULL, last_login TEXT
  );
`);
if (!db.prepare("SELECT 1 FROM pragma_table_info('orders') WHERE name='user_id'").get()) db.exec('ALTER TABLE orders ADD COLUMN user_id INTEGER');
const addCol = (t, c, def) => { if (!db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name=?').get(t, c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
addCol('users', 'balance', 'INTEGER NOT NULL DEFAULT 0');
addCol('users', 'phone', "TEXT DEFAULT ''");
addCol('users', 'banned', 'INTEGER NOT NULL DEFAULT 0');
for (const [c, d] of [['pay_method', "TEXT DEFAULT 'wa'"], ['pay_status', "TEXT NOT NULL DEFAULT 'paid'"], ['trx_id', 'TEXT'], ['qr_url', 'TEXT'], ['payment_url', 'TEXT'],
  ['total_pay', 'INTEGER'], ['expired_at', 'TEXT'], ['is_test', 'INTEGER DEFAULT 0'], ['last_check', 'INTEGER DEFAULT 0']]) addCol('orders', c, d);
addCol('announcements', 'image', "TEXT DEFAULT ''");
addCol('products', 'custom', 'INTEGER NOT NULL DEFAULT 0');
db.exec(`
  CREATE TABLE IF NOT EXISTS custom_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, product_id INTEGER, product_name TEXT NOT NULL, category TEXT DEFAULT '',
    project_name TEXT NOT NULL, features TEXT NOT NULL, contact_wa TEXT DEFAULT '', contact_email TEXT DEFAULT '',
    reference TEXT DEFAULT '', budget TEXT DEFAULT '', deadline TEXT DEFAULT '', notes TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'new', admin_note TEXT DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT
  );
  CREATE INDEX IF NOT EXISTS custom_requests_user ON custom_requests(user_id, id);
`);
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS orders_trx ON orders(trx_id) WHERE trx_id IS NOT NULL;
  CREATE TABLE IF NOT EXISTS deliveries (
    did INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER UNIQUE, type TEXT NOT NULL DEFAULT 'text',
    text TEXT DEFAULT '', file TEXT DEFAULT '', filename TEXT DEFAULT '', size INTEGER DEFAULT 0, updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, order_seq INTEGER NOT NULL, product_id INTEGER, name TEXT, price INTEGER, qty INTEGER, did INTEGER
  );
  CREATE INDEX IF NOT EXISTS order_items_seq ON order_items(order_seq);
  CREATE TABLE IF NOT EXISTS deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, amount INTEGER NOT NULL, total_pay INTEGER, trx_id TEXT UNIQUE,
    qr_url TEXT, payment_url TEXT, status TEXT NOT NULL DEFAULT 'pending', is_test INTEGER DEFAULT 0,
    created_at TEXT, expired_at TEXT, last_check INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS wallet_tx (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, type TEXT NOT NULL, amount INTEGER NOT NULL,
    balance_after INTEGER NOT NULL, ref TEXT, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS wallet_tx_user ON wallet_tx(user_id, id);
`);
// ---------- ID publik acak (7 karakter huruf besar & angka) ----------
// ID tidak lagi berurutan: tidak membocorkan jumlah transaksi & tidak bisa ditebak.
// Kunci internal (seq/id) tetap angka; yang tampil ke pengguna/admin adalah kolom `code`.
// Format tampil: DGF-XXXXXXX (kolom `code` hanya menyimpan 7 karakter acaknya)
const ID_PREFIX = 'DGF-';
const pubId = (c) => (c ? ID_PREFIX + c : '');
const rawId = (v) => String(v || '').trim().toUpperCase().replace(/^DGF-/, '');
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // tanpa 0/O/1/I agar tidak membingungkan
const genCode = (table) => {
  for (;;) {
    let c = ''; for (let i = 0; i < 7; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!db.prepare(`SELECT 1 FROM ${table} WHERE code=?`).get(c)) return c;
  }
};
for (const [t, pk, prefix] of [['orders', 'seq', 'ORD-'], ['custom_requests', 'id', 'REQ-'], ['deposits', 'id', 'DEP-']]) {
  addCol(t, 'code', 'TEXT');
  const old = db.prepare(`SELECT ${pk} AS k FROM ${t} WHERE code IS NULL`).all();
  if (old.length) {
    db.exec('BEGIN');
    try {
      for (const r of old) {
        const c = genCode(t);
        db.prepare(`UPDATE ${t} SET code=? WHERE ${pk}=?`).run(c, r.k);
        db.prepare('UPDATE wallet_tx SET ref=? WHERE ref=?').run(ID_PREFIX + c, prefix + String(r.k).padStart(4, '0')); // riwayat saldo ikut ID baru
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    console.log(`[ID] ${old.length} data lama di tabel ${t} diberi ID acak baru.`);
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${t}_code ON ${t}(code)`);
}
const codeOf = (table, pk, v) => { const r = db.prepare(`SELECT code FROM ${table} WHERE ${pk}=?`).get(v); return r ? pubId(r.code) : ''; };
const CODE_RE = 'DGF-[A-Z0-9]{7}';
// perbaiki riwayat saldo yang sempat memakai kode tanpa prefix (idempoten)
db.exec(`UPDATE wallet_tx SET ref='DGF-'||ref WHERE ref IN (SELECT code FROM orders WHERE code IS NOT NULL UNION SELECT code FROM deposits WHERE code IS NOT NULL)`);

const FILES_DIR = path.join(path.dirname(DB_PATH), 'files');
fs.mkdirSync(FILES_DIR, { recursive: true });
const MAX_UPLOAD = Math.max(1, parseInt(process.env.MAX_UPLOAD_MB || '200', 10) || 200) * 1024 * 1024;

const DEFAULT_SETTINGS = {
  storeName: 'LuthzzStore', wa: '6281234567890', email: 'hello@luthzzstore.com', address: 'Indonesia',
  description: 'Premium digital store dengan produk berkualitas, harga terbaik, dan pelayanan profesional.',
  instagram: '', tiktok: '', facebook: '', youtube: '',
  logo: '', logoShowName: true,
  orderNotif: true, stockNotif: true, emailMarketing: false
};

function seedIfEmpty() {
  if (db.prepare('SELECT COUNT(*) c FROM products').get().c === 0 && !db.prepare("SELECT 1 FROM kv WHERE key='seeded'").get()) {
    const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed.json'), 'utf8'));
    replaceCatalog({ products: seed.products, categories: seed.categories, banners: seed.banners });
    kvSet('settings', JSON.stringify(DEFAULT_SETTINGS));
    kvSet('seeded', '1');
    console.log('[DB] Data awal (produk, kategori, banner) dimasukkan.');
  }
}
const kvGet = (k) => { const r = db.prepare('SELECT value FROM kv WHERE key=?').get(k); return r ? r.value : null; };
const kvSet = (k, v) => db.prepare('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v);

// ---------- Helpers: sanitasi ----------
const str = (v, max = 500) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim().slice(0, max);
const int = (v, d = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const url = (v) => { const s = str(v, 2000); return /^(https?:)?\/\//i.test(s) || s.startsWith('/') || s === '' ? s : ''; };

function replaceCatalog({ products, categories, banners }) {
  db.exec('BEGIN');
  try {
    if (Array.isArray(products)) {
      db.exec('DELETE FROM products');
      const ins = db.prepare('INSERT OR REPLACE INTO products(id,name,category,price,old_price,image,badge,rating,stock,description,created_at,custom) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
      for (const p of products.slice(0, 5000)) {
        const id = int(p.id); const name = str(p.name, 200);
        if (!id || !name) continue;
        const badge = ['SALE', 'NEW', 'BEST'].includes(p.badge) ? p.badge : null;
        const custom = p.custom ? 1 : 0; // produk custom: harga tidak ditentukan, stok tidak dipakai
        // stok: 0 = tanpa batas (tidak ditampilkan), >0 = terbatas, -1 = habis (otomatis saat terjual semua)
        ins.run(id, name, str(p.category, 80) || 'Lainnya', custom ? 0 : Math.max(0, int(p.price)), custom || !p.oldPrice ? null : int(p.oldPrice),
          url(p.image), badge, Math.min(5, Math.max(0, parseFloat(p.rating) || 0)), custom ? 0 : Math.max(-1, int(p.stock)),
          str(p.description, 3000), str(p.createdAt, 20) || today(), custom);
      }
    }
    if (Array.isArray(categories)) {
      db.exec('DELETE FROM categories');
      const ins = db.prepare('INSERT OR IGNORE INTO categories(position,name) VALUES(?,?)');
      categories.slice(0, 200).forEach((c, i) => { const n = str(c && c.name, 80); if (n) ins.run(i, n); });
    }
    if (Array.isArray(banners)) {
      db.exec('DELETE FROM banners');
      const ins = db.prepare('INSERT INTO banners(position,tag,title,desc,bg,cta) VALUES(?,?,?,?,?,?)');
      banners.slice(0, 20).forEach((b, i) => ins.run(i, str(b.tag, 60), str(b.title, 200), str(b.desc, 500), url(b.bg), str(b.cta, 60)));
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());

function getSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(kvGet('settings') || '{}') }; } catch { return { ...DEFAULT_SETTINGS }; }
}
function cleanSettings(s) {
  s = s && typeof s === 'object' ? s : {};
  const out = {};
  for (const k of ['storeName', 'wa', 'email', 'address', 'description', 'instagram', 'tiktok', 'facebook', 'youtube'])
    out[k] = str(s[k], k === 'description' ? 1000 : 300);
  out.wa = out.wa.replace(/\D/g, '');
  for (const k of ['instagram', 'tiktok', 'facebook', 'youtube']) out[k] = url(out[k]);
  out.logo = url(s.logo); out.logoShowName = s.logoShowName !== false;
  out.orderNotif = s.orderNotif !== false; out.stockNotif = s.stockNotif !== false; out.emailMarketing = !!s.emailMarketing;
  if (!out.storeName) out.storeName = DEFAULT_SETTINGS.storeName;
  return out;
}


// ---------- Banner promo (slider 16:9 di atas hero toko, dikelola dari dashboard admin) ----------
const bnLink = (v) => { const t = str(v, 2000); return t.startsWith('#') && /^#[\w-]*$/.test(t) ? t : url(t); };
function getPromoBanners(activeOnly) {
  let a = []; try { a = JSON.parse(kvGet('promoBanners') || '[]'); } catch {}
  if (!Array.isArray(a)) a = [];
  return activeOnly ? a.filter((x) => x && x.active && x.image) : a;
}
function cleanPromoBanners(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set(), out = [];
  for (const b of list.slice(0, 12)) {
    if (!b || typeof b !== 'object') continue;
    const image = url(b.image); if (!image) continue;
    let id = str(b.id, 24).replace(/[^\w-]/g, ''); if (!id || seen.has(id)) id = crypto.randomBytes(6).toString('hex');
    seen.add(id);
    out.push({ id, image, link: bnLink(b.link), alt: str(b.alt, 120), title: str(b.title, 80), btnText: str(b.btnText, 30), active: b.active !== false });
  }
  return out;
}
const promoUses = (u) => getPromoBanners(false).some((b) => b && b.image === u);

// ---------- Pengumuman (popup di toko, dikelola dari dashboard admin) ----------
const ANN_TYPES = ['info', 'success', 'warning', 'promo'];
const annView = (r) => ({ id: r.id, type: r.type, title: r.title, message: r.message, ctaText: r.cta_text || '', ctaUrl: r.cta_url || '', image: r.image || '', active: !!r.active, updatedAt: r.updated_at || r.created_at || '' });
const getAnnouncements = (activeOnly) => db.prepare('SELECT * FROM announcements ' + (activeOnly ? 'WHERE active=1 ' : '') + 'ORDER BY id DESC LIMIT 100').all().map(annView);
function cleanAnn(b) {
  b = b && typeof b === 'object' ? b : {};
  const type = ANN_TYPES.includes(b.type) ? b.type : 'info';
  const title = str(b.title, 120), message = str(b.message, 1000);
  if (!title) throw httpErr(400, 'Judul pengumuman wajib diisi');
  if (!message) throw httpErr(400, 'Isi pesan pengumuman wajib diisi');
  const rawUrl = str(b.ctaUrl, 2000);
  const ctaUrl = rawUrl.startsWith('#') ? rawUrl : url(rawUrl);
  if (rawUrl && !ctaUrl) throw httpErr(400, 'Link tombol harus diawali https://, / atau #');
  const ctaText = ctaUrl ? (str(b.ctaText, 40) || 'Lihat Detail') : '';
  const rawImg = str(b.image, 2000), image = url(rawImg);
  if (rawImg && !image) throw httpErr(400, 'Link gambar harus diawali https:// atau /');
  return { type, title, message, ctaText, ctaUrl, image, active: b.active === false || b.active === 0 ? 0 : 1 };
}

// Gambar pengumuman: diunggah admin, disimpan di folder uploads/ (publik, nama acak), dicek lewat magic bytes.
const ANN_DIR = path.join(path.dirname(DB_PATH), 'uploads');
fs.mkdirSync(ANN_DIR, { recursive: true });
const IMG_MIME = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
function sniffImage(b) {
  if (!b || b.length < 12) return '';
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpg';
  if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (b.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return '';
}
// Foto profil pengguna: disimpan di folder uploads/ yang sama (nama acak), hanya file lokal milik pengguna yang dihapus.
function dropAvatar(u) {
  const m = /^\/uploads\/([a-f0-9]{32}\.(?:jpg|png|gif|webp))$/.exec(u || ''); if (!m) return;
  if (db.prepare('SELECT 1 FROM announcements WHERE image=? LIMIT 1').get(u) || db.prepare('SELECT 1 FROM users WHERE picture=? LIMIT 1').get(u) || getSettings().logo === u || promoUses(u)) return;
  fs.rm(path.join(ANN_DIR, m[1]), { force: true }, () => {});
}
const adminUserView = (r) => ({ id: r.id, name: r.name, email: r.email, phone: r.phone || '', picture: r.picture || '', balance: r.balance || 0, banned: !!r.banned,
  google: !!r.google_sub, hasPassword: !!r.pass_hash, createdAt: r.created_at, lastLogin: r.last_login || '', orders: r.n || 0, spent: r.spent || 0 });
// Nomor WhatsApp: boleh 08xx / 628xx / +628xx; disimpan sebagai 628xx. Kosong = hapus.
function cleanPhone(v) {
  let d = String(v == null ? '' : v).replace(/[\s\-().]/g, '');
  if (d === '') return '';
  if (!/^\+?\d+$/.test(d)) return null;
  d = d.replace(/^\+/, '');
  if (d.startsWith('0')) d = '62' + d.slice(1);
  return d.length >= 9 && d.length <= 15 ? d : null;
}
function dropAnnImage(u) {
  const m = /^\/uploads\/([a-f0-9]{32}\.(?:jpg|png|gif|webp))$/.exec(u || ''); if (!m) return;
  if (db.prepare('SELECT 1 FROM announcements WHERE image=? LIMIT 1').get(u) || getSettings().logo === u || promoUses(u)) return;
  fs.rm(path.join(ANN_DIR, m[1]), { force: true }, () => {});
}

function getCatalog() {
  const digitalIds = new Set(db.prepare('SELECT product_id FROM deliveries WHERE product_id IS NOT NULL').all().map((r) => r.product_id));
  const products = db.prepare('SELECT * FROM products ORDER BY id').all().map((r) => ({
    id: r.id, name: r.name, category: r.category, price: r.price, oldPrice: r.old_price, image: r.image,
    badge: r.badge, rating: r.rating, stock: r.stock, description: r.description, createdAt: r.created_at,
    digital: digitalIds.has(r.id), custom: !!r.custom
  }));
  const categories = db.prepare('SELECT name FROM categories ORDER BY position').all().map((r) => ({ name: r.name, count: 0 }));
  const banners = db.prepare('SELECT tag,title,desc,bg,cta FROM banners ORDER BY position').all().map((r) => ({ ...r }));
  return { products, categories, banners, announcements: getAnnouncements(true), promoBanners: getPromoBanners(true).map(({ image, link, alt, title, btnText }) => ({ image, link, alt, title: title || '', btnText: btnText || '' })), settings: getSettings(), pay: { qris: BQ_ON, test: BQ.test, minDeposit: BQ.min, maxDeposit: BQ.max } };
}
const orderRow = (r) => ({ id: pubId(r.code), customer: r.customer, phone: r.phone, address: r.address, payment: r.payment, items: r.items, total: r.total, status: r.status, date: r.date, payMethod: r.pay_method, test: !!r.is_test });
const getOrders = () => db.prepare("SELECT * FROM orders WHERE pay_status='paid' ORDER BY seq DESC LIMIT 2000").all().map(orderRow);
const seqFromId = (id) => { const r = db.prepare('SELECT seq FROM orders WHERE code=?').get(rawId(id)); return r ? r.seq : 0; };


// ---------- Request produk custom (custom bot / web: harga tidak ditentukan, pembeli mengisi form kebutuhan) ----------
const REQ_STATUS = ['new', 'process', 'done', 'cancelled'];
const reqFromId = (v) => { const r = db.prepare('SELECT id FROM custom_requests WHERE code=?').get(rawId(v)); return r ? r.id : 0; };
const reqView = (r, admin) => {
  const v = { id: pubId(r.code), productId: r.product_id, productName: r.product_name, category: r.category || '', projectName: r.project_name, features: r.features,
    contactWa: r.contact_wa || '', contactEmail: r.contact_email || '', reference: r.reference || '', budget: r.budget || '', deadline: r.deadline || '', notes: r.notes || '',
    status: r.status, adminNote: r.admin_note || '', createdAt: r.created_at, updatedAt: r.updated_at || r.created_at };
  if (admin) { v.userId = r.user_id; v.userName = r.user_name || ''; v.userEmail = r.user_email || ''; }
  return v;
};
const getCustomRequests = () => db.prepare('SELECT r.*, u.name AS user_name, u.email AS user_email FROM custom_requests r LEFT JOIN users u ON u.id=r.user_id ORDER BY r.id DESC LIMIT 2000').all().map((r) => reqView(r, true));
function cleanCustomRequest(b) {
  b = b && typeof b === 'object' ? b : {};
  const projectName = str(b.projectName, 120), features = str(b.features, 3000);
  if (!projectName) throw httpErr(400, 'Nama web/bot wajib diisi');
  if (features.length < 10) throw httpErr(400, 'Jelaskan fitur yang diinginkan (minimal 10 karakter)');
  const rawWa = str(b.contactWa, 40), rawMail = str(b.contactEmail, 200).toLowerCase();
  const contactWa = rawWa ? cleanPhone(rawWa) : '';
  if (rawWa && contactWa === null) throw httpErr(400, 'Nomor WhatsApp tidak valid');
  if (rawMail && !validEmail(rawMail)) throw httpErr(400, 'Format email tidak valid');
  if (!contactWa && !rawMail) throw httpErr(400, 'Isi minimal satu kontak: WhatsApp atau email');
  const reference = str(b.reference, 1000);
  return { projectName, features, contactWa: contactWa || '', contactEmail: rawMail, reference, budget: str(b.budget, 80), deadline: str(b.deadline, 80), notes: str(b.notes, 2000) };
}

// ---------- Auth ----------
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
if (!ADMIN_PASSWORD) {
  const f = path.join(path.dirname(DB_PATH), '.initial-admin-password');
  if (fs.existsSync(f)) ADMIN_PASSWORD = fs.readFileSync(f, 'utf8').trim();
  else {
    ADMIN_PASSWORD = crypto.randomBytes(9).toString('base64url');
    fs.writeFileSync(f, ADMIN_PASSWORD, { mode: 0o600 });
  }
  console.warn('[AUTH] ADMIN_PASSWORD belum diset. Password sementara: ' + ADMIN_PASSWORD + '  (tersimpan di ' + f + ')');
  console.warn('[AUTH] Segera set ADMIN_PASSWORD di file .env lalu restart server.');
}
let SECRET = process.env.SESSION_SECRET || kvGet('session_secret');
if (!SECRET) { SECRET = crypto.randomBytes(32).toString('hex'); kvSet('session_secret', SECRET); }
const SESSION_TTL = 7 * 24 * 3600 * 1000;
const sign = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
const safeEq = (a, b) => { const x = crypto.createHash('sha256').update(String(a)).digest(); const y = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };
const makeToken = () => { const exp = String(Date.now() + SESSION_TTL); return exp + '.' + sign(exp + '|' + crypto.createHash('sha256').update(ADMIN_PASSWORD).digest('hex')); };
function isAuthed(req) {
  const m = /(?:^|;\s*)adm=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEq(sig, sign(exp + '|' + crypto.createHash('sha256').update(ADMIN_PASSWORD).digest('hex')));
}
const isHttps = (req) => process.env.COOKIE_SECURE === 'true' || (process.env.COOKIE_SECURE !== 'false' && req.headers['x-forwarded-proto'] === 'https');


// ---------- Akun pengguna (daftar email+password & Google) ----------
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
const nowIso = () => new Date().toISOString();
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k))));
async function hashPassword(pw) { const salt = crypto.randomBytes(16); return 'scrypt$' + salt.toString('hex') + '$' + (await scrypt(pw, salt)).toString('hex'); }
async function checkPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) { await scrypt(pw, Buffer.alloc(16)); return false; }
  const a = await scrypt(pw, Buffer.from(saltHex, 'hex')); const b = Buffer.from(hashHex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const USER_TTL = 30 * 24 * 3600 * 1000;
const makeUserToken = (id) => { const body = id + '.' + (Date.now() + USER_TTL); return body + '.' + sign('u|' + body); };
function currentUser(req) {
  const m = /(?:^|;\s*)usr=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const [id, exp, sig] = m[1].split('.');
  if (!id || !exp || !sig || Number(exp) < Date.now() || !safeEq(sig, sign('u|' + id + '.' + exp))) return null;
  const u = db.prepare('SELECT id,email,name,picture,balance,phone,pass_hash,google_sub,created_at,banned FROM users WHERE id=?').get(int(id));
  return u && !u.banned ? { id: u.id, email: u.email, name: u.name, picture: u.picture, balance: u.balance, phone: u.phone || '', hasPassword: !!u.pass_hash, google: !!u.google_sub, createdAt: u.created_at } : null;
}
const cookieFlags = (req) => '; Path=/; HttpOnly; SameSite=Lax' + (isHttps(req) ? '; Secure' : '');
const userCookie = (req, id) => `usr=${makeUserToken(id)}${cookieFlags(req)}; Max-Age=${USER_TTL / 1000}`;
const safeNext = (n) => (typeof n === 'string' && /^\/(?![\/\\])/.test(n) && n.length < 200 ? n : '/');
const validEmail = (e) => e.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

// Verifikasi ID token Google (RS256) memakai kunci publik Google — tanpa library tambahan.
let jwks = { keys: [], at: 0 };
async function googleKeys(force) {
  if (!force && jwks.keys.length && Date.now() - jwks.at < 3600e3) return jwks.keys;
  const r = await fetch('https://www.googleapis.com/oauth2/v3/certs', { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('Gagal mengambil kunci Google: HTTP ' + r.status);
  jwks = { keys: (await r.json()).keys || [], at: Date.now() };
  return jwks.keys;
}
async function verifyGoogleToken(idToken) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('Token tidak valid');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  if (header.alg !== 'RS256') throw new Error('Algoritma token tidak didukung');
  let key = (await googleKeys(false)).find((k) => k.kid === header.kid);
  if (!key) key = (await googleKeys(true)).find((k) => k.kid === header.kid);
  if (!key) throw new Error('Kunci token tidak dikenal');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), crypto.createPublicKey({ key, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new Error('Tanda tangan token salah');
  if (claims.aud !== GOOGLE_CLIENT_ID) throw new Error('Client ID tidak cocok');
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)) throw new Error('Penerbit token salah');
  if (!claims.exp || claims.exp * 1000 < Date.now()) throw new Error('Token kedaluwarsa');
  if (!claims.sub || !claims.email || claims.email_verified !== true) throw new Error('Email Google belum terverifikasi');
  return claims;
}
function upsertGoogleUser(c) {
  const email = String(c.email).toLowerCase(); const name = str(c.name || email.split('@')[0], 100); const pic = url(c.picture);
  let u = db.prepare('SELECT * FROM users WHERE google_sub=?').get(c.sub) || db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (u) db.prepare('UPDATE users SET google_sub=?, picture=CASE WHEN picture=\'\' THEN ? ELSE picture END, last_login=? WHERE id=?').run(c.sub, pic, nowIso(), u.id);
  else u = { id: Number(db.prepare('INSERT INTO users(email,name,google_sub,picture,created_at,last_login) VALUES(?,?,?,?,?,?)').run(email, name, c.sub, pic, nowIso(), nowIso()).lastInsertRowid) };
  return u.id;
}
function readForm(req, limit = 20 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))));
    req.on('error', reject);
  });
}
const cookieOf = (req, name) => { const m = new RegExp('(?:^|;\\s*)' + name + '=([^;]+)').exec(req.headers.cookie || ''); return m ? m[1] : ''; };

// ---------- Rate limit sederhana ----------
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(); const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now); hits.set(key, arr);
  return arr.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();
const ipOf = (req) => (req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '');

// ---------- HTTP helpers ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2', '.txt': 'text/plain' };
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'SAMEORIGIN' };
function send(res, code, body, headers = {}) { res.writeHead(code, { ...SEC, ...headers }); res.end(body); }
const json = (res, code, obj, h = {}) => send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...h });
function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('bad json'), { status: 400 })); } });
    req.on('error', reject);
  });
}
const inject = (html, varName, data) => {
  const js = JSON.stringify(data).replace(/</g, "\\u003c").replace(/[\u2028\u2029]/g, (c) => "\\u" + c.charCodeAt(0).toString(16));
  return html.replace('</head>', () => `<script>window.${varName}=${js};</script>\n</head>`);
};
const readPublic = (f) => fs.readFileSync(path.join(PUBLIC_DIR, f), 'utf8');

function serveStatic(req, res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || ['admin.html', 'login.html', 'index.html', 'auth.html', 'account.html'].includes(path.basename(file))) return false;
  let st; try { st = fs.statSync(file); } catch { return false; }
  if (!st.isFile()) return false;
  const ext = path.extname(file).toLowerCase();
  const etag = '"' + st.size + '-' + st.mtimeMs.toString(36) + '"';
  if (req.headers['if-none-match'] === etag) return send(res, 304, ''), true;
  send(res, 200, fs.readFileSync(file), { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=0, must-revalidate', ETag: etag });
  return true;
}

// ---------- Pembayaran: BuatQris + saldo + pengiriman produk otomatis ----------
const flagOn = (v) => ['1', 'true', 'yes', 'on'].includes(String(v || '').trim().toLowerCase());
const BQ = {
  base: (process.env.BUATQRIS_BASE_URL || 'https://api.buatqris.site').trim(),
  account: (process.env.BUATQRIS_ACCOUNT_ID || '').trim(),
  secret: (process.env.BUATQRIS_SECRET_TOKEN || '').trim(),
  signing: (process.env.BUATQRIS_SIGNING_SECRET || '').trim(),
  test: flagOn(process.env.BUATQRIS_TEST),
  feeBy: (process.env.BUATQRIS_FEE_BY || 'buyer').trim() === 'user' ? 'user' : 'buyer',
  method: (process.env.BUATQRIS_METHOD || '').trim(),
  min: int(process.env.QRIS_MIN, 1000), max: int(process.env.QRIS_MAX, 5000000),
};
let BQ_ON = false;
// Pengaturan dari dashboard admin (kv 'buatqris') menimpa nilai .env; kolom yang belum diisi memakai .env.
const BQ_ENV = { ...BQ };
function bqSaved() { try { return JSON.parse(kvGet('buatqris') || '{}') || {}; } catch { return {}; } }
function applyBQ() {
  const c = bqSaved(), has = (k) => Object.prototype.hasOwnProperty.call(c, k);
  BQ.account = has('account') ? c.account : BQ_ENV.account;
  BQ.secret = has('secret') ? c.secret : BQ_ENV.secret;
  BQ.signing = has('signing') ? c.signing : BQ_ENV.signing;
  BQ.test = has('test') ? !!c.test : BQ_ENV.test;
  BQ.feeBy = has('feeBy') ? c.feeBy : BQ_ENV.feeBy;
  BQ.method = has('method') ? c.method : BQ_ENV.method;
  BQ.min = has('min') ? c.min : BQ_ENV.min; BQ.max = has('max') ? c.max : BQ_ENV.max;
  BQ_ON = !!(BQ.account && BQ.secret);
}
applyBQ();
const maskKey = (k) => (k ? '••••••••' + k.slice(-4) : '');
function bqView() {
  return { accountId: BQ.account, secretSet: !!BQ.secret, secretHint: maskKey(BQ.secret), signingSet: !!BQ.signing, signingHint: maskKey(BQ.signing),
    feeBy: BQ.feeBy, method: BQ.method, min: BQ.min, max: BQ.max, test: BQ.test, active: BQ_ON, fromEnv: !('account' in bqSaved()) && !!BQ_ENV.account };
}
// Panggilan mentah ke BuatQris dengan kredensial tertentu (dipakai Tes Koneksi); mengembalikan pesan penyedia apa adanya.
async function bqProbe(account, secret, test) {
  const body = new URLSearchParams({ action: 'api_create_qris', account_id: account, secret_token: secret, amount: String(Math.max(1000, BQ.min)), description: 'Tes koneksi LuthzzStore', fee_by: BQ.feeBy, test: '1' });
  try {
    const r = await fetch(BQ.base, { method: 'POST', body, signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-App-Name': 'LuthzzStore', 'X-App-Version': '1.0' } });
    const j = await r.json().catch(() => null);
    if (j && j.success === true) return { ok: true, message: 'Terhubung ke BuatQris. Transaksi uji (sandbox) berhasil dibuat.' };
    return { ok: false, message: str((j && j.message) || ('Ditolak penyedia (HTTP ' + r.status + ')'), 200) };
  } catch (e) { return { ok: false, message: 'Tidak dapat menghubungi BuatQris: ' + e.message }; }
}
if (!BQ_ON) console.warn('[PAY] BUATQRIS_ACCOUNT_ID / BUATQRIS_SECRET_TOKEN belum diisi: deposit & bayar QRIS nonaktif (bayar pakai saldo tetap jalan).');
else if (!BQ.signing) console.warn('[PAY] BUATQRIS_SIGNING_SECRET belum diisi: webhook ditolak, status dicek lewat polling saja.');
if (BQ_ON && BQ.test) console.warn('[PAY] MODE SANDBOX aktif (BUATQRIS_TEST=true): tidak ada uang asli.');

const httpErr = (status, message) => Object.assign(new Error(message), { status });
const pad = (n) => String(n).padStart(4, '0');
const orderId = (seq) => codeOf('orders', 'seq', seq);
const depId = (id) => codeOf('deposits', 'id', id);

async function bqCall(action, params = {}) {
  const body = new URLSearchParams({ action, account_id: BQ.account, secret_token: BQ.secret, ...params });
  let r, j = null;
  try {
    r = await fetch(BQ.base, { method: 'POST', body, signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-App-Name': 'LuthzzStore', 'X-App-Version': '1.0' } });
    j = await r.json();
  } catch (e) { console.error('[BQ]', action, 'gagal:', e.message); throw httpErr(502, 'Tidak dapat terhubung ke penyedia pembayaran. Coba lagi.'); }
  if (!j || j.success !== true) {
    console.error('[BQ]', action, 'ditolak:', (j && j.message) || ('HTTP ' + r.status));
    throw httpErr(502, 'Pembayaran gagal dibuat. Coba lagi sebentar lagi.');
  }
  return j.data || {};
}
const safeQr = (u) => (/^https:\/\//i.test(u || '') || /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(u || '') ? u : '');
async function createQris(amount, description) {
  const p = { amount: String(amount), description: description.slice(0, 100), fee_by: BQ.feeBy };
  if (BQ.method) p.qris_method = BQ.method;
  if (BQ.test) p.test = '1';
  const d = await bqCall('api_create_qris', p);
  if (!d.transaction_id) throw httpErr(502, 'Respons pembayaran tidak lengkap');
  return {
    trx: String(d.transaction_id), total: int(d.total_amount, amount), qrUrl: safeQr(d.qr_url) || safeQr(d.qris_image),
    paymentUrl: /^https:\/\//i.test(d.payment_url || '') ? d.payment_url : '', expiredAt: str(d.expired_at, 40),
  };
}

const tx = (fn) => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; } };
function addWalletTx(uid, type, amount, ref) {
  const bal = db.prepare('SELECT balance FROM users WHERE id=?').get(uid).balance;
  db.prepare('INSERT INTO wallet_tx(user_id,type,amount,balance_after,ref,created_at) VALUES(?,?,?,?,?,?)').run(uid, type, amount, bal, ref, nowIso());
  return bal;
}

// --- Pengiriman produk ---
const deliveryPublic = (did, oid) => {
  const d = db.prepare('SELECT * FROM deliveries WHERE did=?').get(did);
  if (!d) return null;
  return d.type === 'file' ? { type: 'file', filename: d.filename, size: d.size, url: `/download/${oid}/${did}` } : { type: 'text', text: d.text };
};
function adminDeliveries() {
  const out = {};
  for (const d of db.prepare('SELECT * FROM deliveries WHERE product_id IS NOT NULL').all()) out[d.product_id] = { type: d.type, text: d.text, filename: d.filename, size: d.size };
  return out;
}
function removeFile(name) { if (name && /^[a-f0-9]{32}$/.test(name)) fs.rm(path.join(FILES_DIR, name), { force: true }, () => {}); }
function cleanupDeliveries() {
  const alive = new Set(db.prepare('SELECT id FROM products').all().map((r) => r.id));
  for (const d of db.prepare('SELECT * FROM deliveries WHERE product_id IS NOT NULL').all()) {
    if (alive.has(d.product_id)) continue;
    const sold = db.prepare("SELECT 1 FROM order_items oi JOIN orders o ON o.seq=oi.order_seq WHERE oi.did=? AND o.pay_status='paid' LIMIT 1").get(d.did);
    if (sold) db.prepare('UPDATE deliveries SET product_id=NULL WHERE did=?').run(d.did); // pembeli lama tetap bisa unduh
    else { db.prepare('DELETE FROM deliveries WHERE did=?').run(d.did); removeFile(d.file); }
  }
}

// --- Order & saldo ---
const getOrderRow = (seq) => db.prepare('SELECT * FROM orders WHERE seq=?').get(seq);
const STATE = { unpaid: 'pending', paid: 'paid', expired: 'expired', failed: 'failed', cancelled: 'cancelled' };
function orderView(row) {
  const id = pubId(row.code); const paid = row.pay_status === 'paid';
  const items = db.prepare('SELECT * FROM order_items WHERE order_seq=? ORDER BY id').all(row.seq).map((it) => ({
    name: it.name, qty: it.qty, price: it.price, delivery: paid && it.did ? deliveryPublic(it.did, id) : null, manual: paid && !it.did,
  }));
  const v = { id, state: STATE[row.pay_status] || 'paid', total: row.total, totalPay: row.total_pay || row.total, payMethod: row.pay_method, date: row.date, test: !!row.is_test, items };
  if (row.pay_status === 'unpaid') { v.qrUrl = row.qr_url || ''; v.paymentUrl = row.payment_url || ''; v.expiresAt = row.expired_at || ''; }
  return v;
}
const depositView = (r) => {
  const v = { id: pubId(r.code), state: r.status === 'success' ? 'paid' : r.status, amount: r.amount, totalPay: r.total_pay || r.amount, test: !!r.is_test, date: (r.created_at || '').slice(0, 10) };
  if (r.status === 'pending') { v.qrUrl = r.qr_url || ''; v.paymentUrl = r.payment_url || ''; v.expiresAt = r.expired_at || ''; }
  return v;
};

// Dipanggil di dalam transaksi. Idempoten: hanya sekali berhasil per order.
function settleOrderTx(seq) {
  const r = db.prepare("UPDATE orders SET pay_status='paid' WHERE seq=? AND pay_status IN ('unpaid','expired','cancelled')").run(seq);
  if (r.changes !== 1) return false;
  db.prepare('UPDATE order_items SET did=(SELECT did FROM deliveries d WHERE d.product_id=order_items.product_id) WHERE order_seq=?').run(seq);
  for (const it of db.prepare('SELECT product_id,qty FROM order_items WHERE order_seq=?').all(seq))
    db.prepare('UPDATE products SET stock=CASE WHEN stock>0 THEN (CASE WHEN stock-? <= 0 THEN -1 ELSE stock-? END) ELSE stock END WHERE id=?').run(it.qty, it.qty, it.product_id);
  const manual = db.prepare('SELECT 1 FROM order_items WHERE order_seq=? AND did IS NULL').get(seq);
  db.prepare('UPDATE orders SET status=? WHERE seq=?').run(manual ? 'pending' : 'completed', seq);
  return true;
}
const settleOrder = (seq) => { const ok = tx(() => settleOrderTx(seq)); if (ok) onOrderPaid(seq); return ok; };
function settleDeposit(id) {
  const done = tx(() => {
    const d = db.prepare('SELECT * FROM deposits WHERE id=?').get(id);
    if (!d || db.prepare("UPDATE deposits SET status='success' WHERE id=? AND status IN ('pending','expired','cancelled')").run(id).changes !== 1) return false;
    db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(d.amount, d.user_id);
    addWalletTx(d.user_id, 'deposit', d.amount, depId(id));
    return true;
  });
  if (done) onDepositPaid(id);
  return done;
}
// status dari penyedia -> status lokal. Nominal wajib cocok sebelum dianggap lunas.
function applyProviderStatus(kind, row, status, data) {
  const expected = kind === 'order' ? row.total : row.amount;
  if (status === 'success') {
    if (data && data.amount != null && int(data.amount, -1) !== expected) { console.error('[PAY] nominal tidak cocok', kind, row.trx_id, data.amount, expected); return false; }
    return kind === 'order' ? settleOrder(row.seq) : settleDeposit(row.id);
  }
  if (status === 'expired' || status === 'failed') {
    if (kind === 'order') db.prepare("UPDATE orders SET pay_status=? WHERE seq=? AND pay_status='unpaid'").run(status, row.seq);
    else db.prepare("UPDATE deposits SET status=? WHERE id=? AND status='pending'").run(status, row.id);
  }
  return false;
}
// Cek ke penyedia (maks 1x/21 dtk per transaksi, sesuai batas API) — cadangan bila webhook belum masuk.
async function refreshPayment(kind, row) {
  const pending = kind === 'order' ? row.pay_status === 'unpaid' : row.status === 'pending';
  if (!pending || !row.trx_id || !BQ_ON || Date.now() - (row.last_check || 0) < 21000) return;
  db.prepare(`UPDATE ${kind === 'order' ? 'orders SET last_check=? WHERE seq=?' : 'deposits SET last_check=? WHERE id=?'}`).run(Date.now(), kind === 'order' ? row.seq : row.id);
  try { const d = await bqCall('api_check_status', { transaction_id: row.trx_id }); applyProviderStatus(kind, row, d.status, d); }
  catch (e) { /* sudah dicatat di bqCall */ }
}

function receiveFile(req, dest, limit) {
  return new Promise((resolve, reject) => {
    let size = 0, failed = false; const ws = fs.createWriteStream(dest, { mode: 0o600 });
    const fail = (e) => { if (failed) return; failed = true; ws.destroy(); fs.rm(dest, { force: true }, () => {}); reject(e); };
    req.on('data', (c) => { size += c.length; if (size > limit) { fail(httpErr(413, 'File terlalu besar (maks ' + Math.floor(limit / 1048576) + ' MB)')); req.destroy(); } });
    req.on('error', fail); req.on('aborted', () => fail(httpErr(400, 'Upload terputus')));
    ws.on('error', fail); ws.on('finish', () => { if (!failed) resolve(size); });
    req.pipe(ws);
  });
}
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(httpErr(413, 'too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject);
  });
}

// ---------- Notifikasi HP (Web Push: muncul di notifikasi handphone walau web ditutup) ----------
const webpush = require('./webpush.js');
const push = webpush.init({
  db, kvGet, kvSet, log: (m) => console.warn(m),
  subject: () => process.env.VAPID_SUBJECT || ('mailto:' + (validEmail(String(getSettings().email || '')) ? getSettings().email : 'admin@example.com')),
  extraHosts: (process.env.PUSH_ALLOW_HOSTS || '').split(',').map((x) => x.trim()).filter(Boolean),
});
const rupiah = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
const safePush = (fn) => { try { const r = fn(); if (r && r.catch) r.catch(() => {}); } catch (e) { console.warn('[PUSH]', e && e.message); } };
function pushAdmin(kind, payload) {
  const st = getSettings();
  if (kind === 'order' && st.orderNotif === false) return;
  if (kind === 'stock' && st.stockNotif === false) return;
  safePush(() => push.toAdmins(payload));
}
const pushUserId = (uid, payload) => { if (uid) safePush(() => push.toUser(uid, payload)); };
const itemsLabel = (items) => (items.length === 1 ? items[0].name : items.length + ' produk');
function onOrderPaid(seq) {
  try {
    const o = getOrderRow(seq); if (!o) return;
    const id = pubId(o.code);
    const items = db.prepare('SELECT product_id,name,qty FROM order_items WHERE order_seq=?').all(seq);
    const label = itemsLabel(items), manual = o.status === 'pending';
    pushUserId(o.user_id, manual
      ? { title: 'Pembayaran diterima ✅', body: id + ' · ' + label + ' sudah dibayar dan sedang diproses admin.', url: '/account#orders', tag: 'order-' + id }
      : { title: 'Pesanan berhasil ✅', body: id + ' · ' + label + ' siap! Buka Akun untuk melihat/mengunduh produk.', url: '/account#orders', tag: 'order-' + id });
    const buyer = o.user_id ? db.prepare('SELECT name FROM users WHERE id=?').get(o.user_id) : null;
    pushAdmin('order', { title: 'Pesanan baru 🛒', body: id + ' · ' + ((buyer && buyer.name) || 'Pembeli') + ' · ' + label + ' · ' + rupiah(o.total), url: '/admin#orders', tag: 'admin-order-' + id });
    const low = [];
    for (const it of items) {
      const pr = db.prepare('SELECT name,stock FROM products WHERE id=?').get(it.product_id);
      if (pr && pr.stock === -1) low.push(pr.name + ' (habis)');
      else if (pr && pr.stock > 0 && pr.stock < 5) low.push(pr.name + ' (sisa ' + pr.stock + ')');
    }
    if (low.length) pushAdmin('stock', { title: 'Stok menipis ⚠️', body: low.slice(0, 4).join(', '), url: '/admin#products', tag: 'admin-stock' });
  } catch (e) { console.warn('[PUSH] onOrderPaid', e && e.message); }
}
function onDepositPaid(id) {
  try {
    const d = db.prepare('SELECT * FROM deposits WHERE id=?').get(id); if (!d) return;
    const u2 = db.prepare('SELECT name,balance FROM users WHERE id=?').get(d.user_id);
    pushUserId(d.user_id, { title: 'Deposit berhasil 💰', body: 'Saldo bertambah ' + rupiah(d.amount) + (u2 ? '. Saldo sekarang ' + rupiah(u2.balance) + '.' : '.'), url: '/account#saldo', tag: 'dep-' + pubId(d.code) });
    pushAdmin('deposit', { title: 'Deposit masuk 💰', body: ((u2 && u2.name) || 'Pengguna') + ' · ' + rupiah(d.amount), url: '/admin#users', tag: 'admin-dep-' + pubId(d.code) });
  } catch (e) { console.warn('[PUSH] onDepositPaid', e && e.message); }
}
const chatPreview = (msg) => msg.text || (msg.att ? (msg.att.type === 'video' ? '🎥 Video' : '📷 Foto') : '');
const pushChatToAdmin = (t, msg) => pushAdmin('chat', { title: '💬 ' + (t.name || 'Pelanggan'), body: chatPreview(msg), url: '/admin#livechat', tag: 'chat-' + t.id });
function pushChatToUser(t, msg) {
  const payload = { title: getSettings().storeName + ' membalas 💬', body: chatPreview(msg), url: '/#chat', tag: 'chat-reply' };
  if (t.user_id) pushUserId(t.user_id, payload); else if (t.guest_id) safePush(() => push.toGuest(t.guest_id, payload));
}
const REQ_LABEL = { new: 'sudah kami terima', process: 'sedang dikerjakan ⚙️', done: 'sudah selesai 🎉', cancelled: 'dibatalkan' };

async function handlePush(req, res, p, m) {
  if (p === '/api/push/key' && m === 'GET') return json(res, 200, { key: push.publicKey });
  if (p === '/api/push/subscribe' && m === 'POST') {
    if (limited('pushsub:' + ipOf(req), 300, 3600e3)) return json(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
    const b = await readBody(req, 4 * 1024); const s = b.subscription || {}, keys = s.keys || {};
    const endpoint = str(s.endpoint, 1000), p256dh = str(keys.p256dh, 200), auth = str(keys.auth, 100);
    if (!endpoint || !p256dh || !auth || !push.hostAllowed(endpoint)) return json(res, 400, { error: 'Langganan notifikasi tidak valid' });
    const role = b.role === 'admin' ? 'admin' : 'user';
    let userId = null, guestId = null, ck = {};
    if (role === 'admin') { if (!isAuthed(req)) return json(res, 401, { error: 'Unauthorized' }); }
    else { const a = chatActor(req); if (a.user) userId = a.user.id; else { guestId = a.gid; if (a.fresh) ck = { 'Set-Cookie': `gid=${a.gid}${cookieFlags(req)}; Max-Age=31536000` }; } }
    if (!push.find(endpoint, role) && !push.canAdd()) return json(res, 503, { error: 'Kapasitas notifikasi penuh' });
    push.save({ endpoint, p256dh, auth, role, userId, guestId, ua: req.headers['user-agent'] });
    if (b.welcome) {
      const name = getSettings().storeName;
      safePush(() => push.toOne(push.find(endpoint, role), role === 'admin'
        ? { title: 'Notifikasi admin aktif ✅', body: 'Pesanan baru, deposit, chat pelanggan & stok menipis akan muncul di HP ini.', url: '/admin', tag: 'welcome' }
        : { title: 'Notifikasi ' + name + ' aktif ✅', body: 'Status pesanan, saldo, balasan chat & info promo akan muncul di HP ini.', url: '/', tag: 'welcome' }));
    }
    return json(res, 200, { ok: true }, ck);
  }
  if (p === '/api/push/unsubscribe' && m === 'POST') {
    const b = await readBody(req, 2 * 1024); const endpoint = str(b.endpoint, 1000), role = b.role === 'admin' ? 'admin' : 'user';
    if (role === 'admin' && !isAuthed(req)) return json(res, 401, { error: 'Unauthorized' });
    if (endpoint) push.remove(endpoint, role);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/push/test' && m === 'POST') {
    if (limited('pushtest:' + ipOf(req), 10, 3600e3)) return json(res, 429, { error: 'Terlalu banyak percobaan. Coba lagi nanti.' });
    const b = await readBody(req, 2 * 1024); const endpoint = str(b.endpoint, 1000), role = b.role === 'admin' ? 'admin' : 'user';
    const sub = endpoint ? push.find(endpoint, role) : null;
    if (!sub) return json(res, 404, { error: 'Perangkat ini belum berlangganan notifikasi' });
    if (role === 'admin') { if (!isAuthed(req)) return json(res, 401, { error: 'Unauthorized' }); }
    else { const a = chatActor(req); if (!(a.user ? sub.user_id === a.user.id : (!a.fresh && sub.guest_id === a.gid))) return json(res, 403, { error: 'Bukan langganan Anda' }); }
    const sent = await push.toOne(sub, { title: 'Tes notifikasi 🔔', body: 'Berhasil! Notifikasi dari ' + getSettings().storeName + ' akan muncul seperti ini.', url: role === 'admin' ? '/admin' : '/', tag: 'test' });
    return json(res, 200, { ok: sent > 0, sent });
  }
  return json(res, 404, { error: 'Not found' });
}

// ---------- Router ----------
// ---------- Live chat (realtime lewat Server-Sent Events, tanpa dependensi tambahan) ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, guest_id TEXT, name TEXT NOT NULL DEFAULT '', email TEXT DEFAULT '',
    created_at TEXT NOT NULL, last_at TEXT NOT NULL, last_text TEXT DEFAULT '', last_sender TEXT DEFAULT '',
    user_seen INTEGER NOT NULL DEFAULT 0, admin_seen INTEGER NOT NULL DEFAULT 0, closed INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_ct_user ON chat_threads(user_id);
  CREATE INDEX IF NOT EXISTS idx_ct_guest ON chat_threads(guest_id);
  CREATE TABLE IF NOT EXISTS chat_msgs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id INTEGER NOT NULL, sender TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, att TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_cm_thread ON chat_msgs(thread_id, id);
`);
if (!db.prepare("SELECT 1 FROM pragma_table_info('chat_msgs') WHERE name='att'").get()) db.exec("ALTER TABLE chat_msgs ADD COLUMN att TEXT DEFAULT ''");
const CHAT_MAX = 1000;
// Lampiran chat (foto & video): disimpan di data/chat dengan nama acak, tipe file dicek dari isi (bukan nama/ekstensi).
const CHAT_DIR = path.join(path.dirname(DB_PATH), 'chat');
fs.mkdirSync(CHAT_DIR, { recursive: true });
const CHAT_IMG_MAX = 10 * 1024 * 1024;
const CHAT_VIDEO_MAX = Math.max(1, parseInt(process.env.CHAT_VIDEO_MB || '50', 10) || 50) * 1024 * 1024;
const CHAT_MIME = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };
function sniffMedia(b) {
  const img = sniffImage(b); if (img) return { ext: img, type: 'image' };
  if (b.length < 12) return null;
  if (b.toString('latin1', 4, 8) === 'ftyp') {
    const brand = b.toString('latin1', 8, 12);
    if (/^(heic|heix|hevc|hevx|mif1|msf1|avif)/.test(brand)) return null;   // foto HEIC/AVIF tidak didukung browser
    return { ext: brand.startsWith('qt') ? 'mov' : 'mp4', type: 'video' };
  }
  if (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) return { ext: 'webm', type: 'video' };
  return null;
}
async function chatSaveUpload(req) {
  if (int(req.headers['content-length'], 0) > CHAT_VIDEO_MAX) { req.resume(); throw httpErr(413, 'File terlalu besar (maks video ' + Math.floor(CHAT_VIDEO_MAX / 1048576) + ' MB)'); }
  const name = crypto.randomBytes(16).toString('hex'), tmp = path.join(CHAT_DIR, name + '.part');
  const size = await receiveFile(req, tmp, CHAT_VIDEO_MAX);
  let kind = null;
  try { const fd = fs.openSync(tmp, 'r'); const head = Buffer.alloc(16); const n = fs.readSync(fd, head, 0, 16, 0); fs.closeSync(fd); kind = sniffMedia(head.subarray(0, n)); } catch {}
  if (!kind) { fs.rmSync(tmp, { force: true }); throw httpErr(415, 'Format tidak didukung. Kirim foto (JPG/PNG/GIF/WebP) atau video (MP4/MOV/WebM).'); }
  if (kind.type === 'image' && size > CHAT_IMG_MAX) { fs.rmSync(tmp, { force: true }); throw httpErr(413, 'Foto terlalu besar (maks 10 MB)'); }
  const file = name + '.' + kind.ext; fs.renameSync(tmp, path.join(CHAT_DIR, file));
  return { file, type: kind.type };
}
const chatDropFiles = (tid) => { for (const r of db.prepare("SELECT att FROM chat_msgs WHERE thread_id=? AND att<>''").all(tid)) fs.rm(path.join(CHAT_DIR, r.att), { force: true }, () => {}); };
// buang sisa upload yang terputus
try { for (const f of fs.readdirSync(CHAT_DIR)) if (f.endsWith('.part')) fs.rmSync(path.join(CHAT_DIR, f), { force: true }); } catch {}
const chatUserStreams = new Map();   // key ('u:<id>' | 'g:<gid>') -> Set<res>
const chatAdminStreams = new Set();
const sseWrite = (res, evt) => { try { res.write('data: ' + JSON.stringify(evt) + '\n\n'); } catch {} };
const chatPushUser = (key, evt) => { const s = chatUserStreams.get(key); if (s) for (const r of s) sseWrite(r, evt); };
const chatPushAdmin = (evt) => { for (const r of chatAdminStreams) sseWrite(r, evt); };
const chatPresence = () => { const evt = { type: 'presence', online: chatAdminStreams.size > 0 }; for (const s of chatUserStreams.values()) for (const r of s) sseWrite(r, evt); };
function sseOpen(req, res, set, hello, cap, onClose) {
  res.writeHead(200, { ...SEC, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  if (cap && set.size >= cap) { const old = set.values().next().value; set.delete(old); try { old.end(); } catch {} }
  set.add(res); sseWrite(res, hello);
  const ka = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  let closed = false;
  const done = () => { if (closed) return; closed = true; clearInterval(ka); set.delete(res); if (onClose) onClose(); };
  req.on('close', done); res.on('error', done);
}
const chatMsgView = (r) => ({ id: r.id, from: r.sender, text: r.body, at: r.created_at, att: r.att ? { url: '/chatfile/' + r.att, type: /\.(mp4|mov|webm)$/.test(r.att) ? 'video' : 'image' } : null });
const chatUnread = (t) => db.prepare("SELECT COUNT(*) AS n FROM chat_msgs WHERE thread_id=? AND sender='user' AND id>?").get(t.id, t.admin_seen).n;
const chatTotalUnread = () => db.prepare("SELECT COUNT(*) AS n FROM chat_msgs m JOIN chat_threads t ON t.id=m.thread_id WHERE m.sender='user' AND m.id>t.admin_seen").get().n;
function chatThreadView(t) {
  const u = t.user_id ? db.prepare('SELECT picture,email FROM users WHERE id=?').get(t.user_id) : null;
  return { id: t.id, name: t.name, email: t.email || (u && u.email) || '', picture: (u && u.picture) || '', guest: !t.user_id, lastText: t.last_text || '', lastAt: t.last_at, lastFrom: t.last_sender, userSeen: t.user_seen, unread: chatUnread(t), closed: !!t.closed, createdAt: t.created_at };
}
const chatGet = (id) => db.prepare('SELECT * FROM chat_threads WHERE id=?').get(id);
const threadKey = (t) => (t.user_id ? 'u:' + t.user_id : 'g:' + t.guest_id);
function chatActor(req) {
  const user = currentUser(req);
  let gid = cookieOf(req, 'gid'); const fresh = !/^[a-f0-9]{32}$/.test(gid);
  if (fresh) gid = crypto.randomBytes(16).toString('hex');
  return { user, gid, fresh, key: user ? 'u:' + user.id : 'g:' + gid };
}
function chatFind(a) {
  if (a.user) {
    let t = db.prepare('SELECT * FROM chat_threads WHERE user_id=?').get(a.user.id);
    if (!t && !a.fresh) {   // percakapan saat masih tamu ikut pindah ke akun setelah login
      const g = db.prepare('SELECT * FROM chat_threads WHERE guest_id=? AND user_id IS NULL').get(a.gid);
      if (g) { db.prepare('UPDATE chat_threads SET user_id=?, name=?, email=? WHERE id=?').run(a.user.id, a.user.name, a.user.email, g.id); t = chatGet(g.id); }
    }
    return t;
  }
  return a.fresh ? null : db.prepare('SELECT * FROM chat_threads WHERE guest_id=? AND user_id IS NULL').get(a.gid);
}
function chatCreate(a) {
  const ts = nowIso();
  const name = a.user ? a.user.name : 'Pengunjung ' + a.gid.slice(0, 4).toUpperCase();
  const r = db.prepare('INSERT INTO chat_threads(user_id,guest_id,name,email,created_at,last_at) VALUES(?,?,?,?,?,?)').run(a.user ? a.user.id : null, a.user ? null : a.gid, name, a.user ? a.user.email : '', ts, ts);
  return chatGet(Number(r.lastInsertRowid));
}
function chatAdd(t, sender, body, up) {
  const ts = nowIso(), att = up ? up.file : '';
  const id = Number(db.prepare('INSERT INTO chat_msgs(thread_id,sender,body,created_at,att) VALUES(?,?,?,?,?)').run(t.id, sender, body, ts, att).lastInsertRowid);
  const preview = up ? (up.type === 'video' ? '🎥 Video' : '📷 Foto') + (body ? ': ' + body : '') : body;
  db.prepare('UPDATE chat_threads SET last_at=?, last_text=?, last_sender=?, closed=0 WHERE id=?').run(ts, preview.slice(0, 120), sender, t.id);
  db.prepare(sender === 'user' ? 'UPDATE chat_threads SET user_seen=? WHERE id=?' : 'UPDATE chat_threads SET admin_seen=? WHERE id=?').run(id, t.id);
  return chatMsgView({ id, sender, body, created_at: ts, att });
}
const chatMessages = (tid) => db.prepare('SELECT * FROM (SELECT * FROM chat_msgs WHERE thread_id=? ORDER BY id DESC LIMIT 300) ORDER BY id').all(tid).map(chatMsgView);

async function handle(req, res) {
  const u = new URL(req.url, 'http://x'); const p = u.pathname; const m = req.method;

  if (p === '/healthz') return json(res, 200, { ok: true });

  // Gambar pengumuman (publik, nama acak 32 hex)
  const upm = /^\/uploads\/([a-f0-9]{32})\.(jpg|png|gif|webp)$/.exec(p);
  if (upm && (m === 'GET' || m === 'HEAD')) {
    const fp = path.join(ANN_DIR, upm[1] + '.' + upm[2]); let st;
    try { st = fs.statSync(fp); } catch { return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' }); }
    res.writeHead(200, { ...SEC, 'Content-Type': IMG_MIME[upm[2]], 'Content-Length': st.size, 'Cache-Control': 'public, max-age=31536000, immutable' });
    if (m === 'HEAD') return res.end();
    return fs.createReadStream(fp).on('error', () => res.destroy()).pipe(res);
  }

  // Lampiran live chat (foto/video, mendukung Range agar video bisa di-seek di HP)
  const cfm = /^\/chatfile\/([a-f0-9]{32})\.(jpg|png|gif|webp|mp4|mov|webm)$/.exec(p);
  if (cfm && (m === 'GET' || m === 'HEAD')) {
    const fp = path.join(CHAT_DIR, cfm[1] + '.' + cfm[2]); let st;
    try { st = fs.statSync(fp); } catch { return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' }); }
    const size = st.size; let start = 0, end = size - 1, code = 200;
    const rg = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (rg && (rg[1] || rg[2])) {
      if (rg[1] === '') start = Math.max(0, size - int(rg[2])); else { start = int(rg[1]); if (rg[2] !== '') end = Math.min(end, int(rg[2])); }
      if (start > end || start >= size) return send(res, 416, '', { 'Content-Range': 'bytes */' + size });
      code = 206;
    }
    const h = { ...SEC, 'Content-Type': CHAT_MIME[cfm[2]], 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Security-Policy': "sandbox; default-src 'none'" };
    if (code === 206) h['Content-Range'] = `bytes ${start}-${end}/${size}`;
    res.writeHead(code, h);
    if (m === 'HEAD') return res.end();
    return fs.createReadStream(fp, { start, end }).on('error', () => res.destroy()).pipe(res);
  }

  // Halaman
  if ((p === '/' || p === '/index.html') && m === 'GET') {
    const c = getCatalog(); c.user = currentUser(req);
    return send(res, 200, inject(readPublic('index.html'), '__STORE__', c), { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
  }
  if ((p === '/admin' || p === '/admin.html') && m === 'GET') {
    if (!isAuthed(req)) return send(res, 200, readPublic('login.html'), { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
    const c = getCatalog(); c.orders = getOrders(); c.deliveries = adminDeliveries(); c.announcements = getAnnouncements(false); c.customRequests = getCustomRequests();
    return send(res, 200, inject(readPublic('admin.html'), '__ADMIN__', c), { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
  }


  // ----- Akun pengguna -----
  if (p === '/login' && m === 'GET') {
    const next = safeNext(u.searchParams.get('next'));
    if (currentUser(req)) return send(res, 302, '', { Location: next });
    return send(res, 200, inject(readPublic('auth.html'), '__AUTH__', { googleClientId: GOOGLE_CLIENT_ID, next, error: u.searchParams.get('error') || '', store: (({ storeName, logo, logoShowName }) => ({ storeName, logo, logoShowName }))(getSettings()) }), { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
  }
  if (p === '/api/me' && m === 'GET') return json(res, 200, { user: currentUser(req) });
  if (p === '/api/register' && m === 'POST') {
    if (limited('reg:' + ipOf(req), 6, 3600e3)) return json(res, 429, { error: 'Terlalu banyak pendaftaran dari jaringan ini. Coba lagi nanti.' });
    const b = await readBody(req, 10 * 1024);
    const name = str(b.name, 100), email = str(b.email, 200).toLowerCase(), password = typeof b.password === 'string' ? b.password : '';
    if (name.length < 2) return json(res, 400, { error: 'Nama minimal 2 karakter' });
    if (!validEmail(email)) return json(res, 400, { error: 'Format email tidak valid' });
    if (password.length < 8 || password.length > 200) return json(res, 400, { error: 'Password minimal 8 karakter' });
    if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return json(res, 409, { error: 'Email sudah terdaftar. Silakan masuk.' });
    const r = db.prepare('INSERT INTO users(email,name,pass_hash,created_at,last_login) VALUES(?,?,?,?,?)').run(email, name, await hashPassword(password), nowIso(), nowIso());
    return json(res, 201, { ok: true }, { 'Set-Cookie': userCookie(req, Number(r.lastInsertRowid)) });
  }
  if (p === '/api/user/login' && m === 'POST') {
    if (limited('ulogin:' + ipOf(req), 10, 15 * 60e3)) return json(res, 429, { error: 'Terlalu banyak percobaan. Coba lagi 15 menit lagi.' });
    const b = await readBody(req, 10 * 1024);
    const email = str(b.email, 200).toLowerCase(); const password = typeof b.password === 'string' ? b.password : '';
    const row = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (row && !row.pass_hash) return json(res, 400, { error: 'Akun ini terdaftar lewat Google. Gunakan tombol "Masuk dengan Google".' });
    if (!(await checkPassword(password, row && row.pass_hash)) || !row) return json(res, 401, { error: 'Email atau password salah' });
    if (row.banned) return json(res, 403, { error: 'Akun ini dinonaktifkan. Hubungi admin toko.' });
    db.prepare('UPDATE users SET last_login=? WHERE id=?').run(nowIso(), row.id);
    return json(res, 200, { ok: true }, { 'Set-Cookie': userCookie(req, row.id) });
  }
  // ----- Kelola akun (wajib login) -----
  if (p.startsWith('/api/profile')) {
    const cu = currentUser(req); if (!cu) return json(res, 401, { error: 'Silakan masuk', login: true });
    if (p === '/api/profile' && m === 'PUT') {
      const b = await readBody(req, 10 * 1024);
      const name = str(b.name, 100); if (name.length < 2) return json(res, 400, { error: 'Nama minimal 2 karakter' });
      const phone = cleanPhone(b.phone); if (phone === null) return json(res, 400, { error: 'Nomor WhatsApp tidak valid (contoh: 0812xxxxxxx)' });
      db.prepare('UPDATE users SET name=?, phone=? WHERE id=?').run(name, phone, cu.id);
      return json(res, 200, { ok: true, user: currentUser(req) });
    }
    if (p === '/api/profile/email' && m === 'POST') {
      if (limited('pemail:' + cu.id, 8, 3600e3)) return json(res, 429, { error: 'Terlalu banyak percobaan. Coba lagi nanti.' });
      const b = await readBody(req, 10 * 1024); const email = str(b.email, 200).toLowerCase();
      if (!validEmail(email)) return json(res, 400, { error: 'Format email tidak valid' });
      const row = db.prepare('SELECT pass_hash FROM users WHERE id=?').get(cu.id);
      if (row.pass_hash && !(await checkPassword(typeof b.password === 'string' ? b.password : '', row.pass_hash))) return json(res, 403, { error: 'Password saat ini salah' });
      if (db.prepare('SELECT 1 FROM users WHERE email=? AND id<>?').get(email, cu.id)) return json(res, 409, { error: 'Email sudah dipakai akun lain' });
      db.prepare('UPDATE users SET email=? WHERE id=?').run(email, cu.id);
      return json(res, 200, { ok: true, user: currentUser(req) });
    }
    if (p === '/api/profile/password' && m === 'POST') {
      if (limited('ppw:' + cu.id, 8, 3600e3)) return json(res, 429, { error: 'Terlalu banyak percobaan. Coba lagi nanti.' });
      const b = await readBody(req, 10 * 1024); const pw = typeof b.password === 'string' ? b.password : '';
      if (pw.length < 8 || pw.length > 200) return json(res, 400, { error: 'Password baru minimal 8 karakter' });
      const row = db.prepare('SELECT pass_hash FROM users WHERE id=?').get(cu.id);
      if (row.pass_hash && !(await checkPassword(typeof b.current === 'string' ? b.current : '', row.pass_hash))) return json(res, 403, { error: 'Password saat ini salah' });
      db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(await hashPassword(pw), cu.id);
      return json(res, 200, { ok: true, user: currentUser(req) });
    }
    if (p === '/api/profile/avatar' && m === 'POST') {
      if (limited('pava:' + cu.id, 20, 3600e3)) return json(res, 429, { error: 'Terlalu banyak unggahan. Coba lagi nanti.' });
      const buf = await readRaw(req, 3 * 1024 * 1024); const kind = sniffImage(buf);
      if (!kind) return json(res, 400, { error: 'File harus berupa gambar JPG, PNG, WEBP, atau GIF (maks 3 MB)' });
      const name = crypto.randomBytes(16).toString('hex') + '.' + kind;
      fs.writeFileSync(path.join(ANN_DIR, name), buf, { mode: 0o644 });
      const old = cu.picture; db.prepare('UPDATE users SET picture=? WHERE id=?').run('/uploads/' + name, cu.id); dropAvatar(old);
      return json(res, 200, { ok: true, user: currentUser(req) });
    }
    if (p === '/api/profile/avatar' && m === 'DELETE') {
      const old = cu.picture; db.prepare("UPDATE users SET picture='' WHERE id=?").run(cu.id); dropAvatar(old);
      return json(res, 200, { ok: true, user: currentUser(req) });
    }
    return json(res, 404, { error: 'Not found' });
  }
  if (p === '/api/user/logout' && m === 'POST') return json(res, 200, { ok: true }, { 'Set-Cookie': 'usr=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
  // Google Sign-In (mode redirect: Google mengirim POST form ke sini)
  if (p === '/auth/google/callback' && m === 'POST') {
    const f = await readForm(req);
    const back = (msg) => send(res, 303, '', { Location: '/login?error=' + encodeURIComponent(msg) });
    if (!GOOGLE_CLIENT_ID) return back('Login Google belum dikonfigurasi di server.');
    const csrf = cookieOf(req, 'g_csrf_token');
    if (!csrf || !f.g_csrf_token || !safeEq(csrf, f.g_csrf_token)) return back('Verifikasi keamanan gagal. Coba lagi.');
    if (limited('google:' + ipOf(req), 20, 15 * 60e3)) return back('Terlalu banyak percobaan. Coba lagi nanti.');
    try {
      const id = upsertGoogleUser(await verifyGoogleToken(f.credential));
      if (db.prepare('SELECT banned FROM users WHERE id=?').get(id).banned) return back('Akun ini dinonaktifkan. Hubungi admin toko.');
      return send(res, 303, '', { Location: '/', 'Set-Cookie': userCookie(req, id), 'Cache-Control': 'no-store' });
    } catch (e) { console.error('[GOOGLE]', e.message); return back('Login Google gagal: ' + e.message); }
  }

  // Auth admin
  if (p === '/api/login' && m === 'POST') {
    if (limited('login:' + ipOf(req), 8, 15 * 60e3)) return json(res, 429, { error: 'Terlalu banyak percobaan. Coba lagi 15 menit lagi.' });
    const b = await readBody(req, 10 * 1024);
    if (!safeEq(str(b.password, 200), ADMIN_PASSWORD)) return json(res, 401, { error: 'Password salah' });
    const cookie = `adm=${makeToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${isHttps(req) ? '; Secure' : ''}`;
    return json(res, 200, { ok: true }, { 'Set-Cookie': cookie });
  }
  if (p === '/api/logout' && m === 'POST') return json(res, 200, { ok: true }, { 'Set-Cookie': 'adm=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });

  // ----- Saldo, deposit, checkout (wajib login) -----
  if (p === '/api/wallet' && m === 'GET') {
    const cu = currentUser(req); if (!cu) return json(res, 401, { error: 'Silakan masuk', login: true });
    const history = db.prepare('SELECT type,amount,balance_after,ref,created_at FROM wallet_tx WHERE user_id=? ORDER BY id DESC LIMIT 40').all(cu.id);
    const pending = db.prepare("SELECT * FROM deposits WHERE user_id=? AND status='pending' ORDER BY id DESC LIMIT 3").all(cu.id).map(depositView);
    return json(res, 200, { balance: cu.balance, history, pending, pay: { qris: BQ_ON, test: BQ.test, minDeposit: BQ.min, maxDeposit: BQ.max } });
  }
  if (p === '/api/deposit' && m === 'POST') {
    const cu = currentUser(req); if (!cu) return json(res, 401, { error: 'Silakan masuk', login: true });
    if (!BQ_ON) return json(res, 503, { error: 'Deposit QRIS belum diaktifkan oleh admin.' });
    if (limited('dep:' + cu.id, 10, 3600e3)) return json(res, 429, { error: 'Terlalu banyak permintaan deposit. Coba lagi nanti.' });
    const amount = int((await readBody(req, 5 * 1024)).amount);
    if (amount < BQ.min || amount > BQ.max) return json(res, 400, { error: `Nominal deposit Rp ${BQ.min.toLocaleString('id-ID')} – Rp ${BQ.max.toLocaleString('id-ID')}` });
    const id = Number(db.prepare('INSERT INTO deposits(user_id,amount,status,is_test,created_at,code) VALUES(?,?,?,?,?,?)').run(cu.id, amount, 'pending', BQ.test ? 1 : 0, nowIso(), genCode('deposits')).lastInsertRowid);
    try {
      const q = await createQris(amount, 'Deposit saldo ' + depId(id));
      db.prepare('UPDATE deposits SET trx_id=?, qr_url=?, payment_url=?, total_pay=?, expired_at=? WHERE id=?').run(q.trx, q.qrUrl, q.paymentUrl, q.total, q.expiredAt, id);
    } catch (e) { db.prepare("UPDATE deposits SET status='failed' WHERE id=?").run(id); throw e; }
    return json(res, 201, { ok: true, deposit: depositView(db.prepare('SELECT * FROM deposits WHERE id=?').get(id)) });
  }
  const dcm = new RegExp('^/api/deposits/(' + CODE_RE + ')/cancel$').exec(p);
  if (dcm && m === 'POST') {
    const cu = currentUser(req); if (!cu) return json(res, 401, { error: 'Silakan masuk', login: true });
    const row = db.prepare('SELECT * FROM deposits WHERE code=? AND user_id=?').get(rawId(dcm[1]), cu.id);
    if (!row) return json(res, 404, { error: 'Deposit tidak ditemukan' });
    if (row.status === 'success') return json(res, 409, { error: 'Deposit sudah dibayar, tidak bisa dibatalkan.' });
    db.prepare("UPDATE deposits SET status='cancelled' WHERE id=? AND status='pending'").run(row.id);
    return json(res, 200, { ok: true, deposit: depositView(db.prepare('SELECT * FROM deposits WHERE id=?').get(row.id)) });
  }
  const dm = new RegExp('^/api/deposits/(' + CODE_RE + ')$').exec(p);
  if (dm && m === 'GET') {
    const cu = currentUser(req); if (!cu) return json(res, 401, { error: 'Silakan masuk', login: true });
    let row = db.prepare('SELECT * FROM deposits WHERE code=? AND user_id=?').get(rawId(dm[1]), cu.id);
    if (!row) return json(res, 404, { error: 'Deposit tidak ditemukan' });
    await refreshPayment('deposit', row);
    row = db.prepare('SELECT * FROM deposits WHERE id=?').get(row.id);
    return json(res, 200, { deposit: depositView(row), balance: currentUser(req).balance });
  }
  // ----- Request produk custom (pembeli) -----
  if (p === '/api/custom-request' && m === 'POST') {
    const cu = currentUser(req); if (!cu) return json(res, 401, { error: 'Silakan masuk terlebih dahulu untuk mengirim request.', login: true });
    if (limited('cr:' + cu.id, 8, 3600e3)) return json(res, 429, { error: 'Terlalu banyak request, coba lagi nanti.' });
    const b = await readBody(req, 30 * 1024);
    const pr = db.prepare('SELECT id,name,category,custom FROM products WHERE id=?').get(int(b.productId));
    if (!pr || !pr.custom) return json(res, 404, { error: 'Produk custom tidak ditemukan' });
    const d = cleanCustomRequest(b);
    const id = Number(db.prepare('INSERT INTO custom_requests(user_id,product_id,product_name,category,project_name,features,contact_wa,contact_email,reference,budget,deadline,notes,status,created_at,updated_at,code) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(cu.id, pr.id, pr.name, pr.category, d.projectName, d.features, d.contactWa, d.contactEmail, d.reference, d.budget, d.deadline, d.notes, 'new', nowIso(), nowIso(), genCode('custom_requests')).lastInsertRowid);
    pushAdmin('custom', { title: 'Request custom baru ✨', body: (d.projectName || pr.name) + ' · dari ' + cu.name, url: '/admin#custom', tag: 'admin-custom-' + id });
    return json(res, 201, { ok: true, request: reqView(db.prepare('SELECT * FROM custom_requests WHERE id=?').get(id)) });
  }
  if (p === '/api/my/custom-requests' && m === 'GET') {
    const cu = currentUser(req); if (!cu) return json(res, 401, { error: 'Silakan masuk', login: true });
    return json(res, 200, { requests: db.prepare('SELECT * FROM custom_requests WHERE user_id=? ORDER BY id DESC LIMIT 50').all(cu.id).map((r) => reqView(r)) });
  }
  if (p === '/api/checkout' && m === 'POST') {
    const cu = currentUser(req); if (!cu) return json(res, 401, { error: 'Silakan masuk terlebih dahulu untuk membayar.', login: true });
    if (limited('co:' + cu.id, 20, 600e3)) return json(res, 429, { error: 'Terlalu banyak pesanan, coba lagi nanti.' });
    const b = await readBody(req, 50 * 1024);
    if (!Array.isArray(b.items)) return json(res, 400, { error: 'Keranjang kosong' });
    const want = new Map();
    for (const it of b.items.slice(0, 100)) { const id = int(it && it.id); if (id) want.set(id, Math.min(99, (want.get(id) || 0) + Math.max(1, int(it.qty, 1)))); }
    const lines = []; let total = 0;
    const getP = db.prepare('SELECT id,name,price,stock,custom FROM products WHERE id=?');
    for (const [id, qty0] of want) {
      const pr = getP.get(id); if (!pr) continue;
      const qty = Math.min(99, qty0);
      if (pr.custom) return json(res, 400, { error: `"${pr.name}" adalah produk custom. Harganya ditentukan setelah request, silakan isi form request di halaman produk.` });
      if (pr.stock < 0) return json(res, 409, { error: `"${pr.name}" sedang habis.` });
      if (pr.stock > 0 && pr.stock < qty) return json(res, 409, { error: `Stok "${pr.name}" hanya tersisa ${pr.stock}.` });
      lines.push({ id: pr.id, name: pr.name, price: pr.price, qty }); total += pr.price * qty;
    }
    if (!lines.length) return json(res, 400, { error: 'Produk tidak valid' });
    const count = lines.reduce((a, l) => a + l.qty, 0);
    const insOrder = (method, payLabel) => {
      const seq = Number(db.prepare("INSERT INTO orders(customer,phone,address,payment,items,total,detail,status,date,user_id,pay_method,pay_status,is_test,code) VALUES(?,?,?,?,?,?,?,?,?,?,?,'unpaid',?,?)")
        .run(esc(cu.name), esc(cu.email), '', payLabel, count, total, JSON.stringify(lines), 'pending', today(), cu.id, method, BQ.test && method === 'qris' ? 1 : 0, genCode('orders')).lastInsertRowid);
      const ins = db.prepare('INSERT INTO order_items(order_seq,product_id,name,price,qty) VALUES(?,?,?,?,?)');
      for (const l of lines) ins.run(seq, l.id, l.name, l.price, l.qty);
      return seq;
    };
    if (cu.balance >= total) { // bayar pakai saldo -> langsung lunas & terkirim
      const seq = tx(() => {
        if (db.prepare('UPDATE users SET balance=balance-? WHERE id=? AND balance>=?').run(total, cu.id, total).changes !== 1) throw httpErr(409, 'Saldo tidak mencukupi');
        const s = insOrder('balance', 'Saldo');
        addWalletTx(cu.id, 'purchase', -total, orderId(s));
        settleOrderTx(s);
        return s;
      });
      onOrderPaid(seq);
      return json(res, 201, { ok: true, paid: true, order: orderView(getOrderRow(seq)), balance: currentUser(req).balance });
    }
    if (!BQ_ON) return json(res, 503, { error: 'Saldo tidak cukup dan pembayaran QRIS belum diaktifkan oleh admin.' });
    if (total < BQ.min) return json(res, 400, { error: `Saldo tidak cukup dan total di bawah minimal QRIS (Rp ${BQ.min.toLocaleString('id-ID')}). Silakan deposit dulu.` });
    if (total > BQ.max) return json(res, 400, { error: `Total melebihi batas QRIS (Rp ${BQ.max.toLocaleString('id-ID')}). Kurangi jumlah produk atau bayar dengan saldo.` });
    const seq = tx(() => insOrder('qris', 'QRIS'));
    try {
      const q = await createQris(total, 'Order ' + orderId(seq));
      db.prepare('UPDATE orders SET trx_id=?, qr_url=?, payment_url=?, total_pay=?, expired_at=? WHERE seq=?').run(q.trx, q.qrUrl, q.paymentUrl, q.total, q.expiredAt, seq);
    } catch (e) { db.prepare("UPDATE orders SET pay_status='failed' WHERE seq=?").run(seq); throw e; }
    return json(res, 201, { ok: true, paid: false, order: orderView(getOrderRow(seq)), balance: cu.balance });
  }
  if (p === '/api/my/orders' && m === 'GET') {
    const cu = currentUser(req); if (!cu) return json(res, 401, { error: 'Silakan masuk', login: true });
    const rows = db.prepare("SELECT * FROM orders WHERE user_id=? AND pay_method IN ('balance','qris') ORDER BY seq DESC LIMIT 50").all(cu.id);
    return json(res, 200, { orders: rows.map(orderView) });
  }
  const ocm = new RegExp('^/api/orders/(' + CODE_RE + ')/cancel$').exec(p);
  if (ocm && m === 'POST') {
    const cu = currentUser(req); if (!cu) return json(res, 401, { error: 'Silakan masuk', login: true });
    const row = db.prepare('SELECT * FROM orders WHERE seq=? AND user_id=?').get(seqFromId(ocm[1]), cu.id);
    if (!row) return json(res, 404, { error: 'Pesanan tidak ditemukan' });
    if (row.pay_status === 'paid') return json(res, 409, { error: 'Pesanan sudah dibayar, tidak bisa dibatalkan.' });
    db.prepare("UPDATE orders SET pay_status='cancelled' WHERE seq=? AND pay_status='unpaid'").run(row.seq);
    return json(res, 200, { ok: true, order: orderView(getOrderRow(row.seq)) });
  }
  const om2 = new RegExp('^/api/orders/(' + CODE_RE + ')$').exec(p);
  if (om2 && m === 'GET') {
    const cu = currentUser(req); if (!cu) return json(res, 401, { error: 'Silakan masuk', login: true });
    let row = db.prepare('SELECT * FROM orders WHERE seq=? AND user_id=?').get(seqFromId(om2[1]), cu.id);
    if (!row) return json(res, 404, { error: 'Pesanan tidak ditemukan' });
    await refreshPayment('order', row);
    return json(res, 200, { order: orderView(getOrderRow(row.seq)), balance: currentUser(req).balance });
  }
  const dl = new RegExp('^/download/(' + CODE_RE + ')/(\\d+)$').exec(p);
  if (dl && m === 'GET') {
    const cu = currentUser(req); if (!cu) return send(res, 302, '', { Location: '/login?next=' + encodeURIComponent('/account') });
    if (limited('dl:' + cu.id, 60, 3600e3)) return send(res, 429, 'Terlalu banyak unduhan, coba lagi nanti.', { 'Content-Type': 'text/plain; charset=utf-8' });
    const seq = seqFromId(dl[1]), did = int(dl[2]);
    const ok = db.prepare("SELECT 1 FROM orders o JOIN order_items oi ON oi.order_seq=o.seq WHERE o.seq=? AND o.user_id=? AND o.pay_status='paid' AND oi.did=?").get(seq, cu.id, did);
    const d = ok && db.prepare("SELECT * FROM deliveries WHERE did=? AND type='file'").get(did);
    if (!d || !/^[a-f0-9]{32}$/.test(d.file)) return send(res, 404, 'File tidak ditemukan', { 'Content-Type': 'text/plain; charset=utf-8' });
    const fp = path.join(FILES_DIR, d.file); let st; try { st = fs.statSync(fp); } catch { return send(res, 404, 'File tidak ditemukan', { 'Content-Type': 'text/plain; charset=utf-8' }); }
    res.writeHead(200, { ...SEC, 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'private, no-store',
      'Content-Disposition': `attachment; filename="${d.filename.replace(/[^\w.\-]+/g, '_')}"; filename*=UTF-8''${encodeURIComponent(d.filename)}` });
    return fs.createReadStream(fp).on('error', () => res.destroy()).pipe(res);
  }
  if (p === '/account' && m === 'GET') {
    if (!currentUser(req)) return send(res, 302, '', { Location: '/login?next=' + encodeURIComponent('/account') });
    return send(res, 200, readPublic('account.html'), { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
  }
  // Webhook BuatQris (publik, wajib bertanda tangan HMAC-SHA256 atas body mentah)
  if (p === '/api/buatqris/webhook' && m === 'POST') {
    if (!BQ.signing) return json(res, 503, { error: 'Signing secret belum dikonfigurasi' });
    const raw = await readRaw(req, 64 * 1024);
    const calc = 'sha256=' + crypto.createHmac('sha256', BQ.signing).update(raw).digest('hex');
    if (!safeEq(calc, String(req.headers['x-buatqris-signature'] || ''))) return json(res, 401, { error: 'Signature tidak valid' });
    let d; try { d = JSON.parse(raw.toString('utf8')); } catch { return json(res, 400, { error: 'JSON tidak valid' }); }
    const status = { 'payment.success': 'success', 'payment.expired': 'expired', 'payment.failed': 'failed' }[String(d.event || '')];
    const trx = String(d.transaction_id || '');
    if (!status || !trx) return json(res, 200, { ok: true, ignored: true });
    const o = db.prepare('SELECT * FROM orders WHERE trx_id=?').get(trx);
    const dep = o ? null : db.prepare('SELECT * FROM deposits WHERE trx_id=?').get(trx);
    const row = o || dep;
    if (!row) return json(res, 200, { ok: true, ignored: true });
    if (!!d.is_test !== !!row.is_test) { console.error('[PAY] webhook is_test tidak cocok', trx); return json(res, 200, { ok: true, ignored: true }); }
    applyProviderStatus(o ? 'order' : 'deposit', row, status, d);
    return json(res, 200, { ok: true });
  }


  // Daftar pengguna (khusus admin)
  if (p === '/admin/users' && m === 'GET') {
    if (!isAuthed(req)) return send(res, 302, '', { Location: '/admin' });
    const rows = db.prepare('SELECT u.*, (SELECT COUNT(*) FROM orders o WHERE o.user_id=u.id) AS n FROM users u ORDER BY u.id DESC LIMIT 5000').all();
    const tr = rows.map((r) => `<tr><td>${r.id}</td><td>${esc(r.name)}</td><td>${esc(r.email)}</td><td>${r.google_sub ? 'Google' : 'Email'}${r.google_sub && r.pass_hash ? ' + Email' : ''}</td><td>${r.n}</td><td>Rp ${Number(r.balance||0).toLocaleString('id-ID')}</td><td>${esc((r.created_at || '').slice(0, 16).replace('T', ' '))}</td><td>${esc((r.last_login || '').slice(0, 16).replace('T', ' '))}</td></tr>`).join('');
    const html = `<!DOCTYPE html><html lang="id"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Pengguna</title><style>body{font-family:system-ui,sans-serif;margin:0;padding:16px;background:#F8FAFC;color:#0F172A}h1{font-size:20px}a{color:#2563EB}.w{overflow-x:auto;background:#fff;border-radius:12px;box-shadow:0 1px 4px #0002}table{border-collapse:collapse;width:100%;font-size:13px;white-space:nowrap}th,td{padding:10px 12px;text-align:left;border-bottom:1px solid #E2E8F0}th{background:#F1F5F9}</style></head><body><p><a href="/admin">&larr; Admin</a></p><h1>Pengguna terdaftar (${rows.length})</h1><div class="w"><table><tr><th>ID</th><th>Nama</th><th>Email</th><th>Metode</th><th>Pesanan</th><th>Saldo</th><th>Daftar</th><th>Login terakhir</th></tr>${tr || '<tr><td colspan="8">Belum ada pengguna.</td></tr>'}</table></div></body></html>`;
    return send(res, 200, html, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
  }

  // PWA manifest (agar bisa dipasang di layar utama; wajib untuk notifikasi di iPhone)
  if ((p === '/manifest.webmanifest' || p === '/admin.webmanifest') && m === 'GET') {
    const st = getSettings(), adm = p.startsWith('/admin'), nm = String(st.storeName || 'Toko');
    const mf = { name: adm ? nm + ' Admin' : nm, short_name: (adm ? 'Admin ' : '') + nm.slice(0, 12), id: adm ? '/admin' : '/', start_url: adm ? '/admin' : '/', scope: adm ? '/admin' : '/',
      display: 'standalone', background_color: '#ffffff', theme_color: '#1E40AF', lang: 'id',
      icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' }, { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }, { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }] };
    return send(res, 200, JSON.stringify(mf), { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-cache' });
  }
  if (p.startsWith('/api/push/')) return handlePush(req, res, p, m);

  // ----- Live chat: pengunjung / pengguna -----
  if (p.startsWith('/api/chat')) {
    const a = chatActor(req);
    const ck = a.fresh && !a.user ? { 'Set-Cookie': `gid=${a.gid}${cookieFlags(req)}; Max-Age=31536000` } : {};
    if (p === '/api/chat' && m === 'GET') {
      const t = chatFind(a);
      return json(res, 200, { messages: t ? chatMessages(t.id) : [], adminSeen: t ? t.admin_seen : 0, userSeen: t ? t.user_seen : 0, closed: t ? !!t.closed : false, online: chatAdminStreams.size > 0, user: a.user ? { name: a.user.name } : null }, ck);
    }
    if (p === '/api/chat/stream' && m === 'GET') {
      if (a.fresh && !a.user) return json(res, 400, { error: 'Cookie diperlukan untuk live chat' });
      let set = chatUserStreams.get(a.key); if (!set) chatUserStreams.set(a.key, set = new Set());
      return sseOpen(req, res, set, { type: 'hello', online: chatAdminStreams.size > 0 }, 4, () => { if (!set.size && chatUserStreams.get(a.key) === set) chatUserStreams.delete(a.key); });
    }
    if (p === '/api/chat/send' && m === 'POST') {
      if (limited('chat:' + a.key + ':' + ipOf(req), 25, 60e3)) return json(res, 429, { error: 'Terlalu cepat. Tunggu sebentar ya.' });
      if (a.fresh && !a.user) return json(res, 400, { error: 'Aktifkan cookie browser untuk memakai live chat.' });
      const b = await readBody(req, 8 * 1024); const text = str(b.text, CHAT_MAX);
      if (!text) return json(res, 400, { error: 'Pesan kosong' });
      let t = chatFind(a) || chatCreate(a);
      if (a.user && (t.name !== a.user.name || t.email !== a.user.email)) db.prepare('UPDATE chat_threads SET name=?, email=? WHERE id=?').run(a.user.name, a.user.email, t.id);
      const msg = chatAdd(t, 'user', text); t = chatGet(t.id);
      chatPushUser(a.key, { type: 'msg', msg });
      chatPushAdmin({ type: 'msg', thread: chatThreadView(t), msg });
      pushChatToAdmin(t, msg);
      return json(res, 200, { ok: true, msg });
    }
    if (p === '/api/chat/upload' && m === 'POST') {
      if (limited('chatup:' + a.key + ':' + ipOf(req), 12, 60e3)) { req.resume(); return json(res, 429, { error: 'Terlalu banyak unggahan. Tunggu sebentar ya.' }); }
      if (a.fresh && !a.user) { req.resume(); return json(res, 400, { error: 'Aktifkan cookie browser untuk memakai live chat.' }); }
      const up = await chatSaveUpload(req); const text = str(u.searchParams.get('text'), CHAT_MAX);
      let t = chatFind(a) || chatCreate(a);
      if (a.user && (t.name !== a.user.name || t.email !== a.user.email)) db.prepare('UPDATE chat_threads SET name=?, email=? WHERE id=?').run(a.user.name, a.user.email, t.id);
      const msg = chatAdd(t, 'user', text, up); t = chatGet(t.id);
      chatPushUser(a.key, { type: 'msg', msg });
      chatPushAdmin({ type: 'msg', thread: chatThreadView(t), msg });
      pushChatToAdmin(t, msg);
      return json(res, 200, { ok: true, msg });
    }
    if (p === '/api/chat/seen' && m === 'POST') {
      const t = chatFind(a);
      if (t) { const r = db.prepare("SELECT MAX(id) AS id FROM chat_msgs WHERE thread_id=? AND sender='admin'").get(t.id); if (r.id) { db.prepare('UPDATE chat_threads SET user_seen=MAX(user_seen,?) WHERE id=?').run(r.id, t.id); chatPushAdmin({ type: 'thread', thread: chatThreadView(chatGet(t.id)) }); } }
      return json(res, 200, { ok: true }, ck);
    }
    if (p === '/api/chat/typing' && m === 'POST') {
      const t = chatFind(a);
      if (t && !limited('chatt:' + a.key, 40, 60e3)) chatPushAdmin({ type: 'typing', threadId: t.id });
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'Not found' });
  }

  // Admin API
  if (p.startsWith('/api/admin/')) {
    if (!isAuthed(req)) return json(res, 401, { error: 'Unauthorized' });
    // ----- Live chat: admin -----
    if (p === '/api/admin/chat/stream' && m === 'GET') {
      sseOpen(req, res, chatAdminStreams, { type: 'hello', unread: chatTotalUnread() }, 0, () => setTimeout(chatPresence, 4000));
      return chatPresence();
    }
    if (p === '/api/admin/chat/threads' && m === 'GET') {
      const rows = db.prepare('SELECT * FROM chat_threads ORDER BY last_at DESC LIMIT 300').all().map(chatThreadView);
      return json(res, 200, { threads: rows, unread: chatTotalUnread(), online: chatAdminStreams.size > 0 });
    }
    const cm = /^\/api\/admin\/chat\/threads\/(\d+)(?:\/(send|close|typing|seen|upload))?$/.exec(p);
    if (cm) {
      let t = chatGet(int(cm[1])); if (!t) return json(res, 404, { error: 'Percakapan tidak ditemukan' });
      const act = cm[2];
      const markSeen = () => {
        const r = db.prepare('SELECT MAX(id) AS id FROM chat_msgs WHERE thread_id=?').get(t.id);
        if (r.id && r.id > t.admin_seen) {
          db.prepare('UPDATE chat_threads SET admin_seen=? WHERE id=?').run(r.id, t.id); t = chatGet(t.id);
          chatPushUser(threadKey(t), { type: 'seen', upto: r.id });
          chatPushAdmin({ type: 'thread', thread: chatThreadView(t) });
        }
      };
      if (!act && m === 'GET') { markSeen(); return json(res, 200, { thread: chatThreadView(t), messages: chatMessages(t.id) }); }
      if (act === 'seen' && m === 'POST') { markSeen(); return json(res, 200, { ok: true }); }
      if (act === 'send' && m === 'POST') {
        const b = await readBody(req, 8 * 1024); const text = str(b.text, CHAT_MAX);
        if (!text) return json(res, 400, { error: 'Pesan kosong' });
        const msg = chatAdd(t, 'admin', text); t = chatGet(t.id);
        chatPushUser(threadKey(t), { type: 'msg', msg });
        chatPushAdmin({ type: 'msg', thread: chatThreadView(t), msg });
        pushChatToUser(t, msg);
        return json(res, 200, { ok: true, msg });
      }
      if (act === 'upload' && m === 'POST') {
        const up = await chatSaveUpload(req); const text = str(u.searchParams.get('text'), CHAT_MAX);
        const msg = chatAdd(t, 'admin', text, up); t = chatGet(t.id);
        chatPushUser(threadKey(t), { type: 'msg', msg });
        chatPushAdmin({ type: 'msg', thread: chatThreadView(t), msg });
        pushChatToUser(t, msg);
        return json(res, 200, { ok: true, msg });
      }
      if (act === 'typing' && m === 'POST') { chatPushUser(threadKey(t), { type: 'typing' }); return json(res, 200, { ok: true }); }
      if (act === 'close' && m === 'POST') {
        const b = await readBody(req, 1024); const closed = b.closed ? 1 : 0;
        db.prepare('UPDATE chat_threads SET closed=? WHERE id=?').run(closed, t.id); t = chatGet(t.id);
        chatPushUser(threadKey(t), { type: 'closed', closed: !!closed });
        chatPushAdmin({ type: 'thread', thread: chatThreadView(t) });
        return json(res, 200, { ok: true, thread: chatThreadView(t) });
      }
      if (!act && m === 'DELETE') {
        chatDropFiles(t.id); db.prepare('DELETE FROM chat_msgs WHERE thread_id=?').run(t.id); db.prepare('DELETE FROM chat_threads WHERE id=?').run(t.id);
        chatPushUser(threadKey(t), { type: 'reset' });
        chatPushAdmin({ type: 'deleted', id: t.id });
        return json(res, 200, { ok: true });
      }
    }

    if (p === '/api/admin/buatqris' && m === 'GET') return json(res, 200, bqView());
    if (p === '/api/admin/buatqris' && m === 'PUT') {
      const b = await readBody(req, 10 * 1024); const cur = bqSaved();
      const field = (v, old, max = 300) => { const t = str(v, max); return t === '' ? old : t; };   // kolom rahasia kosong = tidak diubah
      const min = Math.max(0, int(b.min, BQ.min)), max = Math.max(0, int(b.max, BQ.max));
      if (max < min) return json(res, 400, { error: 'Nominal maksimal harus lebih besar dari minimal' });
      const next = {
        account: str(b.accountId, 200), secret: field(b.secretToken, BQ.secret), signing: field(b.signingSecret, BQ.signing),
        test: !!b.test, feeBy: b.feeBy === 'user' ? 'user' : 'buyer',
        method: ['', 'qris_one', 'qris_two', 'qris_three', 'qris_four'].includes(b.method) ? b.method : '', min, max,
      };
      if (/\s/.test(next.account) || /\s/.test(next.secret) || /\s/.test(next.signing)) return json(res, 400, { error: 'Apikey tidak boleh mengandung spasi' });
      if (b.clearSecret === true) next.secret = '';
      if (b.clearSigning === true) next.signing = '';
      kvSet('buatqris', JSON.stringify({ ...cur, ...next })); applyBQ();
      return json(res, 200, { ok: true, ...bqView() });
    }
    if (p === '/api/admin/buatqris/test' && m === 'POST') {
      if (limited('bqtest', 10, 10 * 60e3)) return json(res, 429, { error: 'Terlalu banyak tes. Coba lagi beberapa menit lagi.' });
      const b = await readBody(req, 10 * 1024);
      const account = str(b.accountId, 200) || BQ.account, secret = str(b.secretToken, 300) || BQ.secret;
      if (!account || !secret) return json(res, 400, { ok: false, message: 'Isi Account ID dan Secret Token dulu.' });
      return json(res, 200, await bqProbe(account, secret));
    }
    // ----- Kelola pengguna -----
    if (p === '/api/admin/users' && m === 'GET') {
      const q = '%' + str(u.searchParams.get('q'), 80).replace(/[%_\\]/g, '') + '%';
      const rows = db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM orders o WHERE o.user_id=u.id AND o.pay_status='paid' AND o.pay_method IN ('balance','qris')) AS n,
        (SELECT COALESCE(SUM(o.total),0) FROM orders o WHERE o.user_id=u.id AND o.pay_status='paid' AND o.pay_method IN ('balance','qris')) AS spent
        FROM users u WHERE u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ? ORDER BY u.id DESC LIMIT 1000`).all(q, q, q);
      const all = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(balance),0) b, COALESCE(SUM(banned),0) x FROM users').get();
      return json(res, 200, { users: rows.map(adminUserView), stats: { users: all.c, balance: all.b, banned: all.x } });
    }
    const aum = /^\/api\/admin\/users\/(\d+)(?:\/(password|balance))?$/.exec(p);
    if (aum) {
      const uid = int(aum[1]), act = aum[2];
      const row = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
      if (!row) return json(res, 404, { error: 'Pengguna tidak ditemukan' });
      if (!act && m === 'GET') {
        const wallet = db.prepare('SELECT type,amount,balance_after,ref,created_at FROM wallet_tx WHERE user_id=? ORDER BY id DESC LIMIT 100').all(uid);
        const orders = db.prepare("SELECT * FROM orders WHERE user_id=? AND pay_method IN ('balance','qris') ORDER BY seq DESC LIMIT 50").all(uid).map((o) => {
          const v = orderView(o); return { id: v.id, state: v.state, total: v.total, payMethod: v.payMethod, date: v.date, test: v.test, items: v.items.map((i) => ({ name: i.name, qty: i.qty })) };
        });
        const deposits = db.prepare('SELECT id,code,amount,status,created_at FROM deposits WHERE user_id=? ORDER BY id DESC LIMIT 30').all(uid).map((d) => ({ id: pubId(d.code), amount: d.amount, status: d.status, createdAt: d.created_at }));
        return json(res, 200, { user: adminUserView({ ...row, n: orders.filter((o) => o.state === 'paid').length, spent: orders.filter((o) => o.state === 'paid').reduce((a, o) => a + o.total, 0) }), wallet, orders, deposits });
      }
      if (!act && m === 'PATCH') {
        const b = await readBody(req, 10 * 1024);
        const name = b.name === undefined ? row.name : str(b.name, 100), email = b.email === undefined ? row.email : str(b.email, 200).toLowerCase();
        const phone = b.phone === undefined ? (row.phone || '') : cleanPhone(b.phone);
        if (name.length < 2) return json(res, 400, { error: 'Nama minimal 2 karakter' });
        if (!validEmail(email)) return json(res, 400, { error: 'Format email tidak valid' });
        if (phone === null) return json(res, 400, { error: 'Nomor WhatsApp tidak valid' });
        if (db.prepare('SELECT 1 FROM users WHERE email=? AND id<>?').get(email, uid)) return json(res, 409, { error: 'Email sudah dipakai akun lain' });
        const banned = b.banned === undefined ? row.banned : (b.banned ? 1 : 0);
        db.prepare('UPDATE users SET name=?, email=?, phone=?, banned=? WHERE id=?').run(name, email, phone, banned, uid);
        return json(res, 200, { ok: true, user: adminUserView(db.prepare('SELECT * FROM users WHERE id=?').get(uid)) });
      }
      if (act === 'password' && m === 'POST') {
        const b = await readBody(req, 10 * 1024); const pw = typeof b.password === 'string' ? b.password : '';
        if (pw.length < 8 || pw.length > 200) return json(res, 400, { error: 'Password minimal 8 karakter' });
        db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(await hashPassword(pw), uid);
        return json(res, 200, { ok: true });
      }
      if (act === 'balance' && m === 'POST') {
        const b = await readBody(req, 10 * 1024); const mode = ['add', 'sub', 'set'].includes(b.mode) ? b.mode : '';
        const amt = int(b.amount, -1), note = str(b.note, 100);
        if (!mode) return json(res, 400, { error: 'Pilih jenis penyesuaian' });
        if (amt < 0 || amt > 1e9 || (mode !== 'set' && amt === 0)) return json(res, 400, { error: 'Nominal tidak valid' });
        const nb = tx(() => {
          const cur = db.prepare('SELECT balance FROM users WHERE id=?').get(uid).balance;
          const next = mode === 'set' ? amt : mode === 'add' ? cur + amt : cur - amt;
          if (next < 0) throw httpErr(400, 'Saldo tidak boleh minus (saldo sekarang Rp ' + cur.toLocaleString('id-ID') + ')');
          if (next > 2e9) throw httpErr(400, 'Saldo melebihi batas');
          if (next !== cur) { db.prepare('UPDATE users SET balance=? WHERE id=?').run(next, uid); addWalletTx(uid, 'adjust', next - cur, 'Admin' + (note ? ': ' + note : '')); }
          return next;
        });
        if (nb !== row.balance) pushUserId(uid, { title: 'Saldo diperbarui 💰', body: 'Saldo kamu sekarang ' + rupiah(nb) + (nb > row.balance ? ' (+' + rupiah(nb - row.balance) + ')' : '') + '.', url: '/account#saldo', tag: 'saldo-adjust' });
        return json(res, 200, { ok: true, balance: nb });
      }
      if (!act && m === 'DELETE') {
        tx(() => {
          db.prepare('UPDATE orders SET user_id=NULL WHERE user_id=?').run(uid);
          db.prepare('DELETE FROM wallet_tx WHERE user_id=?').run(uid);
          db.prepare('DELETE FROM deposits WHERE user_id=?').run(uid);
          db.prepare('DELETE FROM push_subs WHERE user_id=?').run(uid);
          db.prepare('DELETE FROM users WHERE id=?').run(uid);
        });
        dropAvatar(row.picture);
        return json(res, 200, { ok: true });
      }
      return json(res, 405, { error: 'Method not allowed' });
    }
    if (p === '/api/admin/state' && m === 'PUT') {
      const b = await readBody(req);
      replaceCatalog(b);
      cleanupDeliveries();
      if (b.settings) {
        const oldLogo = getSettings().logo;
        kvSet('settings', JSON.stringify(cleanSettings(b.settings)));
        if (oldLogo && oldLogo !== getSettings().logo) dropAvatar(oldLogo);
      }
      return json(res, 200, { ok: true });
    }
    const pm = /^\/api\/admin\/products\/(\d+)\/(delivery|file)$/.exec(p);
    if (pm) {
      const pid = int(pm[1]);
      if (!db.prepare('SELECT 1 FROM products WHERE id=?').get(pid)) return json(res, 404, { error: 'Simpan produk dulu sebelum mengatur pengiriman' });
      const cur = db.prepare('SELECT * FROM deliveries WHERE product_id=?').get(pid);
      if (pm[2] === 'delivery' && m === 'PUT') {
        const b = await readBody(req, 600 * 1024);
        if (b.type === 'none') { if (cur) { db.prepare('DELETE FROM deliveries WHERE did=?').run(cur.did); removeFile(cur.file); } return json(res, 200, { ok: true, delivery: null }); }
        if (b.type !== 'text') return json(res, 400, { error: 'Tipe tidak valid' });
        const text = typeof b.text === 'string' ? b.text.slice(0, 500000) : '';
        if (!text.trim()) return json(res, 400, { error: 'Isi produk (teks/link/lisensi) tidak boleh kosong' });
        if (cur) { db.prepare("UPDATE deliveries SET type='text', text=?, file='', filename='', size=0, updated_at=? WHERE did=?").run(text, nowIso(), cur.did); if (cur.file) removeFile(cur.file); }
        else db.prepare("INSERT INTO deliveries(product_id,type,text,updated_at) VALUES(?,'text',?,?)").run(pid, text, nowIso());
        return json(res, 200, { ok: true, delivery: adminDeliveries()[pid] });
      }
      if (pm[2] === 'file' && m === 'POST') {
        const declared = int(req.headers['content-length'], 0);
        if (declared > MAX_UPLOAD) { req.resume(); return json(res, 413, { error: 'File terlalu besar (maks ' + Math.floor(MAX_UPLOAD / 1048576) + ' MB)' }); }
        let filename = 'produk'; try { filename = decodeURIComponent(String(req.headers['x-filename'] || 'produk')); } catch {}
        filename = filename.replace(/[\x00-\x1f\\/:*?"<>|]+/g, '_').trim().slice(0, 150) || 'produk';
        const stored = crypto.randomBytes(16).toString('hex');
        const size = await receiveFile(req, path.join(FILES_DIR, stored), MAX_UPLOAD);
        if (!size) { removeFile(stored); return json(res, 400, { error: 'File kosong' }); }
        if (cur) { db.prepare("UPDATE deliveries SET type='file', text='', file=?, filename=?, size=?, updated_at=? WHERE did=?").run(stored, filename, size, nowIso(), cur.did); if (cur.file) removeFile(cur.file); }
        else db.prepare("INSERT INTO deliveries(product_id,type,file,filename,size,updated_at) VALUES(?,'file',?,?,?,?)").run(pid, stored, filename, size, nowIso());
        return json(res, 200, { ok: true, delivery: adminDeliveries()[pid] });
      }
    }
    if (p === '/api/admin/logo' && m === 'POST') {
      const buf = await readRaw(req, 3 * 1024 * 1024);
      const kind = sniffImage(buf);
      if (!kind) return json(res, 400, { error: 'Logo harus berupa gambar JPG, PNG, WEBP, atau GIF' });
      const name = crypto.randomBytes(16).toString('hex') + '.' + kind;
      fs.writeFileSync(path.join(ANN_DIR, name), buf, { mode: 0o644 });
      return json(res, 201, { ok: true, url: '/uploads/' + name });
    }
    if (p === '/api/admin/announcements/image' && m === 'POST') {
      const buf = await readRaw(req, 6 * 1024 * 1024);
      const kind = sniffImage(buf);
      if (!kind) return json(res, 400, { error: 'File harus berupa gambar JPG, PNG, WEBP, atau GIF' });
      const name = crypto.randomBytes(16).toString('hex') + '.' + kind;
      fs.writeFileSync(path.join(ANN_DIR, name), buf, { mode: 0o644 });
      return json(res, 201, { ok: true, url: '/uploads/' + name });
    }
    if (p === '/api/admin/promo-banners/image' && m === 'POST') {
      const buf = await readRaw(req, 6 * 1024 * 1024);
      const kind = sniffImage(buf);
      if (!kind) return json(res, 400, { error: 'File harus berupa gambar JPG, PNG, WEBP, atau GIF' });
      const name = crypto.randomBytes(16).toString('hex') + '.' + kind;
      fs.writeFileSync(path.join(ANN_DIR, name), buf, { mode: 0o644 });
      return json(res, 201, { ok: true, url: '/uploads/' + name });
    }
    if (p === '/api/admin/promo-banners' && m === 'GET') return json(res, 200, { banners: getPromoBanners(false) });
    if (p === '/api/admin/promo-banners' && m === 'PUT') {
      const b = await readBody(req, 100 * 1024);
      const old = getPromoBanners(false), next = cleanPromoBanners(b.banners);
      kvSet('promoBanners', JSON.stringify(next));
      for (const o of old) if (o && o.image && !next.some((n) => n.image === o.image)) dropAvatar(o.image);
      return json(res, 200, { ok: true, banners: next });
    }
    if (p === '/api/admin/announcements' && m === 'GET') return json(res, 200, { announcements: getAnnouncements(false) });
    if (p === '/api/admin/announcements' && m === 'POST') {
      const a = cleanAnn(await readBody(req, 20 * 1024)), now = nowIso();
      const id = Number(db.prepare('INSERT INTO announcements(type,title,message,cta_text,cta_url,image,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(a.type, a.title, a.message, a.ctaText, a.ctaUrl, a.image, a.active, now, now).lastInsertRowid);
      if (a.active) safePush(() => push.toEveryone({ title: '📢 ' + a.title, body: a.message, url: '/', tag: 'ann-' + id }));
      return json(res, 201, { ok: true, announcement: annView(db.prepare('SELECT * FROM announcements WHERE id=?').get(id)) });
    }
    const anm = /^\/api\/admin\/announcements\/(\d+)$/.exec(p);
    if (anm) {
      const aid = int(anm[1]);
      const cur = db.prepare('SELECT * FROM announcements WHERE id=?').get(aid);
      if (!cur) return json(res, 404, { error: 'Pengumuman tidak ditemukan' });
      if (m === 'PUT') {
        const a = cleanAnn(await readBody(req, 20 * 1024));
        db.prepare('UPDATE announcements SET type=?, title=?, message=?, cta_text=?, cta_url=?, image=?, active=?, updated_at=? WHERE id=?')
          .run(a.type, a.title, a.message, a.ctaText, a.ctaUrl, a.image, a.active, nowIso(), aid);
        if (cur.image !== a.image) dropAnnImage(cur.image);
        if (a.active && !cur.active) safePush(() => push.toEveryone({ title: '📢 ' + a.title, body: a.message, url: '/', tag: 'ann-' + aid }));
        return json(res, 200, { ok: true, announcement: annView(db.prepare('SELECT * FROM announcements WHERE id=?').get(aid)) });
      }
      if (m === 'DELETE') { db.prepare('DELETE FROM announcements WHERE id=?').run(aid); dropAnnImage(cur.image); return json(res, 200, { ok: true }); }
    }
    if (p === '/api/admin/custom-requests' && m === 'GET') return json(res, 200, { requests: getCustomRequests() });
    const crm = new RegExp('^/api/admin/custom-requests/(' + CODE_RE + ')$').exec(p);
    if (crm) {
      const rid = reqFromId(crm[1]);
      if (!db.prepare('SELECT 1 FROM custom_requests WHERE id=?').get(rid)) return json(res, 404, { error: 'Request tidak ditemukan' });
      if (m === 'PATCH') {
        const b = await readBody(req, 10 * 1024);
        if (b.status !== undefined && !REQ_STATUS.includes(b.status)) return json(res, 400, { error: 'Status tidak valid' });
        const prevReq = db.prepare('SELECT user_id,status,admin_note,project_name,product_name FROM custom_requests WHERE id=?').get(rid);
        if (b.status !== undefined) db.prepare('UPDATE custom_requests SET status=?, updated_at=? WHERE id=?').run(b.status, nowIso(), rid);
        if (b.adminNote !== undefined) db.prepare('UPDATE custom_requests SET admin_note=?, updated_at=? WHERE id=?').run(str(b.adminNote, 1000), nowIso(), rid);
        try {
          const nm = prevReq.project_name || prevReq.product_name || 'Request custom';
          if (b.status !== undefined && b.status !== prevReq.status) pushUserId(prevReq.user_id, { title: 'Update request custom', body: nm + ' ' + (REQ_LABEL[b.status] || ''), url: '/account#orders', tag: 'req-' + rid });
          else if (b.adminNote !== undefined && str(b.adminNote, 1000) && str(b.adminNote, 1000) !== (prevReq.admin_note || '')) pushUserId(prevReq.user_id, { title: 'Catatan baru dari admin', body: nm + ': ' + str(b.adminNote, 120), url: '/account#orders', tag: 'req-' + rid });
        } catch {}
        return json(res, 200, { ok: true });
      }
      if (m === 'DELETE') { db.prepare('DELETE FROM custom_requests WHERE id=?').run(rid); return json(res, 200, { ok: true }); }
    }
    // ----- Database: info, backup, restore, reset, optimasi -----
    if (p === '/api/admin/database' && m === 'GET') return json(res, 200, dbInfo());
    if (p === '/api/admin/database/backup' && m === 'POST') {
      const name = makeBackup('manual');
      return json(res, 200, { ok: true, name, info: dbInfo() });
    }
    if (p === '/api/admin/database/auto' && m === 'PUT') {
      const b = await readBody(req, 1024); kvSet('autoBackup', b.enabled ? '1' : '0');
      return json(res, 200, { ok: true, auto: !!b.enabled });
    }
    const bkm = /^\/api\/admin\/database\/backups\/([A-Za-z0-9._-]+)$/.exec(p);
    if (bkm) {
      if (!BK_RE.test(bkm[1])) return json(res, 400, { error: 'Nama backup tidak valid' });
      const fp = path.join(BACKUP_DIR, bkm[1]);
      if (!fs.existsSync(fp)) return json(res, 404, { error: 'Backup tidak ditemukan' });
      if (m === 'GET') {
        res.writeHead(200, { ...SEC, 'Content-Type': 'application/octet-stream', 'Content-Length': fs.statSync(fp).size, 'Content-Disposition': 'attachment; filename="' + bkm[1] + '"', 'Cache-Control': 'no-store' });
        return void fs.createReadStream(fp).pipe(res);
      }
      if (m === 'DELETE') { fs.rmSync(fp, { force: true }); return json(res, 200, { ok: true, info: dbInfo() }); }
    }
    if (p === '/api/admin/database/restore' && m === 'POST') {
      const b = await readBody(req, 4 * 1024);
      if (b.confirm !== 'RESTORE') return json(res, 400, { error: 'Konfirmasi tidak cocok' });
      if (!BK_RE.test(String(b.name || ''))) return json(res, 400, { error: 'Nama backup tidak valid' });
      const fp = path.join(BACKUP_DIR, b.name);
      if (!fs.existsSync(fp)) return json(res, 404, { error: 'Backup tidak ditemukan' });
      const safety = restoreFrom(fp, () => makeBackup('prarestore'));
      return json(res, 200, { ok: true, safety, info: dbInfo() });
    }
    if (p === '/api/admin/database/restore-upload' && m === 'POST') {
      if (req.headers['x-confirm'] !== 'RESTORE') { req.resume(); return json(res, 400, { error: 'Konfirmasi tidak cocok' }); }
      if (int(req.headers['content-length'], 0) > DB_UPLOAD_MAX) { req.resume(); return json(res, 413, { error: 'File terlalu besar (maks ' + Math.floor(DB_UPLOAD_MAX / 1048576) + ' MB)' }); }
      const tmp = path.join(BACKUP_DIR, 'upload-' + crypto.randomBytes(8).toString('hex') + '.part');
      try {
        const size = await receiveFile(req, tmp, DB_UPLOAD_MAX);
        if (!size) throw httpErr(400, 'File kosong');
        const safety = restoreFrom(tmp, () => makeBackup('prarestore'));
        return json(res, 200, { ok: true, safety, info: dbInfo() });
      } finally { fs.rmSync(tmp, { force: true }); }
    }
    if (p === '/api/admin/database/optimize' && m === 'POST') {
      const before = fsize(DB_PATH) + fsize(DB_PATH + '-wal');
      try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
      db.exec('ANALYZE'); db.exec('VACUUM');
      try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
      return json(res, 200, { ok: true, before, after: fsize(DB_PATH) + fsize(DB_PATH + '-wal'), info: dbInfo() });
    }
    if (p === '/api/admin/database/check' && m === 'POST') {
      const rows = db.prepare('PRAGMA integrity_check').all().map((r) => Object.values(r)[0]);
      return json(res, 200, { ok: rows.length === 1 && rows[0] === 'ok', result: rows.slice(0, 10) });
    }
    if (p === '/api/admin/database/reset' && m === 'POST') {
      const b = await readBody(req, 4 * 1024);
      if (b.confirm !== 'RESET') return json(res, 400, { error: 'Konfirmasi tidak cocok' });
      if (!Object.prototype.hasOwnProperty.call(RESET_SCOPES, b.scope)) return json(res, 400, { error: 'Pilihan reset tidak valid' });
      const safety = makeBackup('prareset');
      resetData(b.scope, b.keepConfig !== false);
      return json(res, 200, { ok: true, safety, info: dbInfo() });
    }
    if (p === '/api/admin/orders' && m === 'GET') return json(res, 200, getOrders());
    const om = new RegExp('^/api/admin/orders/(' + CODE_RE + ')$').exec(p);
    if (om) {
      const seq = seqFromId(om[1]);
      if (m === 'PATCH') {
        const b = await readBody(req, 5 * 1024);
        if (!['pending', 'completed'].includes(b.status)) return json(res, 400, { error: 'Status tidak valid' });
        const prevOrd = getOrderRow(seq);
        db.prepare('UPDATE orders SET status=? WHERE seq=?').run(b.status, seq);
        if (prevOrd && b.status === 'completed' && prevOrd.status !== 'completed' && prevOrd.pay_status === 'paid') {
          try { pushUserId(prevOrd.user_id, { title: 'Pesanan selesai 🎉', body: pubId(prevOrd.code) + ' · ' + itemsLabel(db.prepare('SELECT name FROM order_items WHERE order_seq=?').all(seq)) + ' sudah selesai diproses.', url: '/account#orders', tag: 'order-' + pubId(prevOrd.code) }); } catch {}
        }
        return json(res, 200, { ok: true });
      }
      if (m === 'DELETE') { db.prepare('DELETE FROM orders WHERE seq=?').run(seq); return json(res, 200, { ok: true }); }
    }
    return json(res, 404, { error: 'Not found' });
  }

  if (m === 'GET' || m === 'HEAD') { if (serveStatic(req, res, p)) return; }
  send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
}

// ---------- Database admin: backup, restore, reset, optimasi ----------
const BACKUP_DIR = path.join(path.dirname(DB_PATH), 'backups');
fs.mkdirSync(BACKUP_DIR, { recursive: true });
const BACKUP_KEEP = Math.max(3, parseInt(process.env.BACKUP_KEEP || '20', 10) || 20);
const DB_UPLOAD_MAX = Math.max(1, parseInt(process.env.DB_UPLOAD_MB || '200', 10) || 200) * 1024 * 1024;
const BK_RE = /^store-\d{8}-\d{6,9}(?:-[a-z]+)?\.db$/;
const KEEP_KV = ['session_secret', 'vapid'];                                   // selalu dipertahankan (agar login admin tidak putus)
const CONFIG_KV = ['settings', 'buatqris', 'promoBanners', 'autoBackup', 'seeded'];
const fsize = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
const dirStat = (d) => { let size = 0, count = 0; try { for (const f of fs.readdirSync(d)) { try { const st = fs.statSync(path.join(d, f)); if (st.isFile()) { size += st.size; count++; } } catch {} } } catch {} return { size, count }; };
const emptyDir = (d, keep) => { try { for (const f of fs.readdirSync(d)) if (!keep || !keep(f)) fs.rmSync(path.join(d, f), { force: true, recursive: true }); } catch {} };
const userTables = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
const sqlQ = (v) => "'" + String(v).replace(/'/g, "''") + "'";

function listBackups() {
  let out = [];
  try {
    out = fs.readdirSync(BACKUP_DIR).filter((n) => BK_RE.test(n)).map((n) => {
      const st = fs.statSync(path.join(BACKUP_DIR, n));
      return { name: n, size: st.size, created: st.mtime.toISOString(), tag: (/^store-\d{8}-\d{6,9}-([a-z]+)\.db$/.exec(n) || [])[1] || 'manual' };
    });
  } catch {}
  return out.sort((a, b) => (a.name < b.name ? 1 : -1));
}
function makeBackup(tag) {
  const stamp = nowIso().replace(/[-:]/g, '').replace('T', '-').replace('.', '').slice(0, 18);
  const name = 'store-' + stamp + (tag ? '-' + tag : '') + '.db', out = path.join(BACKUP_DIR, name);
  if (fs.existsSync(out)) throw httpErr(429, 'Backup baru saja dibuat, tunggu beberapa detik lalu coba lagi');
  try { db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch {}
  db.exec('VACUUM INTO ' + sqlQ(out));
  try { fs.chmodSync(out, 0o600); } catch {}
  const all = listBackups();
  for (const b of all.slice(BACKUP_KEEP)) fs.rmSync(path.join(BACKUP_DIR, b.name), { force: true });
  return name;
}
function dbInfo() {
  const tables = userTables().map((n) => ({ name: n, rows: db.prepare('SELECT COUNT(*) c FROM "' + n + '"').get().c }));
  return {
    engine: 'SQLite ' + db.prepare('SELECT sqlite_version() v').get().v,
    size: fsize(DB_PATH) + fsize(DB_PATH + '-wal'),
    tables,
    files: dirStat(FILES_DIR), uploads: dirStat(ANN_DIR), chat: dirStat(CHAT_DIR),
    backups: listBackups(), backupKeep: BACKUP_KEEP, auto: kvGet('autoBackup') === '1', maxUploadMb: Math.floor(DB_UPLOAD_MAX / 1048576)
  };
}
function restoreFrom(file, beforeApply) {  // beforeApply() jalan setelah file tervalidasi, sebelum data diganti; hasilnya dikembalikan
  let pre = null;
  const fd = fs.openSync(file, 'r'); const head = Buffer.alloc(16);
  try { fs.readSync(fd, head, 0, 16, 0); } finally { fs.closeSync(fd); }
  if (head.toString('latin1', 0, 15) !== 'SQLite format 3') throw httpErr(400, 'Bukan file database SQLite yang valid');
  db.exec('ATTACH DATABASE ' + sqlQ(file) + ' AS bk');
  try {
    let ok = false; try { ok = Object.values(db.prepare('PRAGMA bk.integrity_check').get())[0] === 'ok'; } catch {}
    if (!ok) throw httpErr(400, 'File backup rusak (pemeriksaan integritas gagal)');
    const bkT = new Set(db.prepare("SELECT name FROM bk.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name));
    if (!['products', 'users', 'kv', 'orders'].every((t) => bkT.has(t))) throw httpErr(400, 'File ini bukan backup database toko ini');
    if (beforeApply) pre = beforeApply();
    db.exec('BEGIN');
    try {
      for (const t of userTables()) {
        const isKv = t === 'kv', keepSql = isKv ? ' WHERE key NOT IN (' + KEEP_KV.map(sqlQ).join(',') + ')' : '';
        db.exec('DELETE FROM main."' + t + '"' + keepSql);
        try { db.prepare('DELETE FROM main.sqlite_sequence WHERE name=?').run(t); } catch {}
        if (!bkT.has(t)) continue;
        const bkCols = new Set(db.prepare('SELECT name FROM pragma_table_info(?, ?)').all(t, 'bk').map((r) => r.name));
        const cols = db.prepare('SELECT name FROM pragma_table_info(?, ?)').all(t, 'main').map((r) => r.name).filter((c) => bkCols.has(c));
        if (!cols.length) continue;
        const list = cols.map((c) => '"' + c + '"').join(',');
        db.exec('INSERT OR REPLACE INTO main."' + t + '"(' + list + ') SELECT ' + list + ' FROM bk."' + t + '"' + keepSql);
      }
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  } finally { try { db.exec('DETACH DATABASE bk'); } catch {} }
  try { applyBQ(); } catch {}
  return pre;
}
const RESET_SCOPES = {
  orders: 'Pesanan', users: 'Pengguna, saldo & deposit', chat: 'Live chat', custom: 'Request custom', catalog: 'Katalog (produk, kategori, banner)', all: 'Semua data'
};
function resetData(scope, keepConfig) {
  if (!Object.prototype.hasOwnProperty.call(RESET_SCOPES, scope)) throw httpErr(400, 'Pilihan reset tidak valid');
  const wipe = (...ts) => { for (const t of ts) { db.exec('DELETE FROM "' + t + '"'); try { db.prepare('DELETE FROM sqlite_sequence WHERE name=?').run(t); } catch {} } };
  // Seed dibaca lebih dulu: kalau gagal, belum ada data yang terhapus. replaceCatalog punya transaksi sendiri (tidak boleh dibungkus lagi).
  const sd = scope === 'catalog' || scope === 'all' ? JSON.parse(fs.readFileSync(path.join(__dirname, 'seed.json'), 'utf8')) : null;
  const loadCatalog = () => replaceCatalog({ products: sd.products, categories: sd.categories, banners: sd.banners });
  const pics = scope === 'users' || scope === 'all' ? db.prepare("SELECT picture FROM users WHERE picture<>''").all().map((r) => r.picture) : [];
  if (scope === 'catalog') loadCatalog();
  else {
    db.exec('BEGIN');
    try {
      if (scope === 'orders') wipe('order_items', 'orders');
      else if (scope === 'users') wipe('users', 'deposits', 'wallet_tx');
      else if (scope === 'chat') wipe('chat_msgs', 'chat_threads');
      else if (scope === 'custom') wipe('custom_requests');
      else {
        wipe(...userTables().filter((t) => t !== 'kv'));
        const keep = keepConfig ? KEEP_KV.concat(CONFIG_KV) : KEEP_KV;
        db.exec('DELETE FROM kv WHERE key NOT IN (' + keep.map(sqlQ).join(',') + ')');
      }
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    if (scope === 'all') { loadCatalog(); kvSet('seeded', '1'); if (!keepConfig) kvSet('settings', JSON.stringify(DEFAULT_SETTINGS)); }
  }
  if (scope === 'chat' || scope === 'all') emptyDir(CHAT_DIR);
  if (scope === 'all') emptyDir(FILES_DIR); else if (scope === 'catalog') cleanupDeliveries();
  if (scope === 'all' && !keepConfig) emptyDir(ANN_DIR);
  else for (const u of pics) dropAvatar(u);
  try { applyBQ(); } catch {}
  try { db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch {}
}
setInterval(() => {
  try {
    if (kvGet('autoBackup') !== '1') return;
    const last = listBackups()[0];
    if (!last || Date.now() - Date.parse(last.created) > 24 * 3600e3) { const n = makeBackup('auto'); console.log('[DB] Backup otomatis: ' + n); }
  } catch (e) { console.error('[DB] Backup otomatis gagal:', e.message); }
}, 3600e3).unref();

seedIfEmpty();
const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (e.status) return json(res, e.status, { error: e.message });
    console.error('[ERR]', e); if (!res.headersSent) json(res, 500, { error: 'Server error' }); else res.end();
  });
});
server.listen(PORT, HOST, () => console.log(`[OK] LuthzzStore berjalan di http://${HOST}:${PORT}  (DB: ${DB_PATH})`));
const stop = () => { server.close(() => { try { db.close(); } catch {} process.exit(0); }); setTimeout(() => process.exit(0), 3000).unref(); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);

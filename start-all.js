'use strict';
/**
 * start-all.js — satu perintah untuk:
 *   1. memasang cloudflared (otomatis, ke ./bin/cloudflared) bila belum ada
 *   2. menjalankan web store (server.js)
 *   3. menjalankan Cloudflare Tunnel sesuai isi .env
 *
 * Zero dependency (Node.js >= 22.13). Jalankan: node start-all.js  (atau npm start)
 *
 * .env:
 *   TUNNEL_TOKEN=eyJh...            # token tunnel Cloudflare (domain tetap). Boleh banyak, pisah koma.
 *   QUICK_TUNNEL=true               # tanpa token -> URL acak https://xxxx.trycloudflare.com
 *   START_TUNNEL=false              # matikan tunnel, hanya jalankan web
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn, spawnSync } = require('child_process');

const ROOT = __dirname;
const BIN_DIR = path.join(ROOT, 'bin');
const IS_WIN = process.platform === 'win32';
const BIN_NAME = IS_WIN ? 'cloudflared.exe' : 'cloudflared';
const LOCAL_BIN = path.join(BIN_DIR, BIN_NAME);

// ---------- .env loader ----------
(function loadEnv() {
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
})();

const PORT = parseInt(process.env.SERVER_PORT || process.env.PORT || '3000', 10);
const flag = (name, def) => {
  const v = (process.env[name] || '').trim().toLowerCase();
  if (!v) return def;
  return !['false', '0', 'no', 'off'].includes(v);
};
const START_TUNNEL = flag('START_TUNNEL', true);
const QUICK_TUNNEL = flag('QUICK_TUNNEL', true);
const TOKENS = (process.env.TUNNEL_TOKEN || process.env.TUNNEL_TOKENS || '')
  .split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);

const log = (...a) => console.log('[start-all]', ...a);
const warn = (...a) => console.warn('[start-all]', ...a);

const children = new Set();
let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('Mematikan semua proses...');
  for (const c of children) { try { c.kill('SIGTERM'); } catch {} }
  setTimeout(() => process.exit(code), 1500).unref();
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// ---------- cloudflared installer ----------
function findInPath() {
  const r = spawnSync(IS_WIN ? 'where' : 'which', ['cloudflared'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

function assetName() {
  const arch = { x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' }[process.arch];
  if (!arch) throw new Error('Arsitektur tidak didukung: ' + process.arch);
  if (process.platform === 'linux') return `cloudflared-linux-${arch}`;
  if (process.platform === 'darwin') return `cloudflared-darwin-${arch === 'arm64' ? 'arm64' : 'amd64'}.tgz`;
  if (IS_WIN) return `cloudflared-windows-${arch === '386' ? '386' : 'amd64'}.exe`;
  throw new Error('OS tidak didukung: ' + process.platform);
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('Terlalu banyak redirect'));
    https.get(url, { headers: { 'User-Agent': 'luthzzstore-start-all' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), dest, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' dari ' + url)); }
      const tmp = dest + '.part';
      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on('finish', () => out.close(() => { fs.renameSync(tmp, dest); resolve(); }));
      out.on('error', reject);
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function ensureCloudflared() {
  if (fs.existsSync(LOCAL_BIN)) return LOCAL_BIN;
  const sys = findInPath();
  if (sys) return sys;

  const asset = assetName();
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`;
  log('cloudflared belum terpasang, mengunduh:', asset);
  fs.mkdirSync(BIN_DIR, { recursive: true });
  if (asset.endsWith('.tgz')) {
    const tgz = path.join(BIN_DIR, asset);
    await download(url, tgz);
    spawnSync('tar', ['-xzf', tgz, '-C', BIN_DIR], { stdio: 'inherit' });
    fs.rmSync(tgz, { force: true });
  } else {
    await download(url, LOCAL_BIN);
  }
  if (!IS_WIN) fs.chmodSync(LOCAL_BIN, 0o755);
  const v = spawnSync(LOCAL_BIN, ['--version'], { encoding: 'utf8' });
  if (v.status !== 0) throw new Error('cloudflared terunduh tetapi tidak bisa dijalankan: ' + (v.stderr || v.error));
  log('cloudflared terpasang:', v.stdout.trim());
  return LOCAL_BIN;
}

// ---------- process helpers ----------
function pipeLines(stream, prefix, onLine) {
  let buf = '';
  stream.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (!line) continue;
      console.log(prefix + line);
      if (onLine) onLine(line);
    }
  });
}

function startWeb() {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server.js')], {
    cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  pipeLines(child.stdout, '[web] ');
  pipeLines(child.stderr, '[web] ');
  child.on('exit', (code, sig) => {
    children.delete(child);
    if (shuttingDown) return;
    warn(`Web berhenti (code=${code} signal=${sig}). Menghentikan tunnel.`);
    shutdown(code || 1);
  });
  return child;
}

// Jalankan satu tunnel dan hidupkan ulang otomatis bila mati.
function runTunnel(bin, label, args, onLine) {
  let delay = 3000;
  const launch = () => {
    if (shuttingDown) return;
    const startedAt = Date.now();
    const child = spawn(bin, ['tunnel', '--no-autoupdate', ...args], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    pipeLines(child.stdout, `[${label}] `, onLine);
    pipeLines(child.stderr, `[${label}] `, onLine);
    child.on('error', (e) => warn(`[${label}] gagal start:`, e.message));
    child.on('exit', (code) => {
      children.delete(child);
      if (shuttingDown) return;
      if (Date.now() - startedAt > 60000) delay = 3000; else delay = Math.min(delay * 2, 60000);
      warn(`[${label}] berhenti (code=${code}), mulai ulang dalam ${Math.round(delay / 1000)} dtk`);
      setTimeout(launch, delay);
    });
  };
  launch();
}

// ---------- main ----------
(async () => {
  startWeb();

  if (!START_TUNNEL) { log('START_TUNNEL=false -> hanya web yang dijalankan.'); return; }
  if (!TOKENS.length && !QUICK_TUNNEL) { log('Tidak ada TUNNEL_TOKEN dan QUICK_TUNNEL=false -> hanya web.'); return; }

  let bin;
  try { bin = await ensureCloudflared(); }
  catch (e) {
    warn('Gagal memasang cloudflared:', e.message);
    warn('Web tetap berjalan tanpa tunnel. Unggah binary manual ke ./bin/' + BIN_NAME + ' lalu restart.');
    return;
  }

  // Tunggu web siap sebentar supaya tunnel tidak melapor 502 saat awal.
  await new Promise((r) => setTimeout(r, 1500));

  if (TOKENS.length) {
    log(`Menjalankan ${TOKENS.length} tunnel (token). Atur Public Hostname di dashboard Cloudflare -> Service: http://localhost:${PORT}`);
    TOKENS.forEach((t, i) => runTunnel(bin, TOKENS.length > 1 ? `tunnel${i + 1}` : 'tunnel', ['run', '--token', t]));
  } else {
    log('TUNNEL_TOKEN kosong -> memakai Quick Tunnel (URL acak, berubah tiap restart).');
    let shown = false;
    runTunnel(bin, 'tunnel', ['--url', `http://localhost:${PORT}`], (line) => {
      const m = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (m && !shown) {
        shown = true;
        console.log('\n==============================================');
        console.log(' Toko online:  ' + m[0]);
        console.log(' Admin:        ' + m[0] + '/admin');
        console.log('==============================================\n');
      }
    });
  }
})();

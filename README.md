# LuthzzStore — Panduan Deploy ke VPS + Domain Tetap

Toko produk digital berbasis Node.js 22 + SQLite (tanpa `npm install`): dashboard admin, daftar/login pengguna, login Google, **saldo & deposit QRIS (BuatQris)**, dan **pengiriman produk otomatis** (file script/source code, link, lisensi) setelah pembayaran terkonfirmasi.
Panduan ini ditulis agar bisa diikuti **hanya dari HP** (aplikasi SSH seperti Termius / JuiceSSH / Termux).

| Halaman | URL |
|---|---|
| Toko | `/` |
| Masuk / Daftar pengguna | `/login` |
| Akun, saldo, deposit, pesanan & unduhan | `/account` |
| Admin | `/admin` (password `ADMIN_PASSWORD`) |
| Daftar pengguna (admin) | `/admin/users` |
| Health check | `/healthz` |

## Daftar isi
1. [Yang dibutuhkan](#1-yang-dibutuhkan)
2. [Beli domain & arahkan ke VPS (domain tetap)](#2-arahkan-domain-ke-vps)
3. [Masuk ke VPS dari HP](#3-masuk-ke-vps-dari-hp)
4. [Kirim kode ke VPS](#4-kirim-kode-ke-vps)
5. [Deploy otomatis (1 perintah)](#5-deploy-otomatis-1-perintah)
6. [Cek hasil](#6-cek-hasil)
7. [Login Google (opsional)](#7-login-google-opsional)
8. [Pembayaran BuatQris & produk digital](#8-pembayaran-buatqris--produk-digital)
9. [Update, backup, restore](#9-update-backup-restore)
10. [Deploy manual (tanpa script)](#10-deploy-manual-tanpa-script)
11. [Alternatif: Cloudflare Tunnel](#11-alternatif-cloudflare-tunnel)
12. [Variabel .env](#12-variabel-env)
13. [Troubleshooting](#13-troubleshooting)
14. [Notifikasi HP (Web Push)](#14-notifikasi-hp-web-push)

---

## 1. Yang dibutuhkan
- **VPS** Linux **Ubuntu 22.04/24.04** (atau Debian 12) — minimal 1 vCPU / 512 MB RAM, punya IP publik, akses root.
- **Domain** (mis. `tokoanda.com`) dari registrar mana pun (Niagahoster, Rumahweb, Namecheap, Cloudflare, dll).
- **Aplikasi SSH di HP**: Termius (Android/iOS) atau Termux (Android).
- Akun **GitHub** (gratis) untuk memindahkan kode ke VPS — cara paling mudah dari HP.

Kebutuhan perangkat lunak (Node.js 22.13+, Nginx, HTTPS) **dipasang otomatis oleh script**.

## 2. Arahkan domain ke VPS
Ini yang membuat alamat toko **tetap** (tidak berubah-ubah seperti link sementara).

1. Catat **IP publik VPS** (di dashboard penyedia VPS), misalnya `203.0.113.10`.
2. Buka pengelolaan **DNS** domain Anda, lalu tambahkan:

| Type | Name / Host | Value | TTL |
|---|---|---|---|
| `A` | `@` | IP VPS Anda | Auto / 300 |
| `A` | `www` | IP VPS Anda | Auto / 300 |

   (Jika VPS punya IPv6, tambahkan juga record `AAAA` dengan IPv6-nya.)
3. Hapus record `A` lama yang bentrok (mis. parkir domain bawaan registrar).
4. Tunggu DNS menyebar (biasanya 2–30 menit, maksimal beberapa jam). Cek dari HP: buka `https://dnschecker.org`, masukkan domain Anda, pastikan A record mengarah ke IP VPS.

> **Memakai Cloudflare untuk DNS?** Saat membuat record, set awan **abu-abu (DNS only)** sampai HTTPS terpasang di langkah 5. Setelah itu boleh dijadikan oranye (Proxied) dengan **SSL/TLS mode: Full (strict)**.

## 3. Masuk ke VPS dari HP
**Termius:** *Hosts → + → New Host* → isi Address = IP VPS, Username = `root`, Password (atau Key) dari penyedia VPS → *Connect*.
**Termux:**
```bash
pkg install openssh
ssh root@IP_VPS_ANDA
```

Disarankan setelah selesai deploy: ganti password root dan pakai SSH key (lihat penyedia VPS Anda).

## 4. Kirim kode ke VPS
### Cara A (disarankan): lewat GitHub
Dari HP:
1. Buka github.com → **New repository** → nama `luthzzstore` → pilih **Private** → Create.
2. Pilih **uploading an existing file**, unggah seluruh isi proyek ini (folder `public`, `deploy`, `server.js`, `package.json`, `seed.json`, `start-all.js`, `.env.example`, `.gitignore`, `README.md`). **Jangan unggah file `.env`** (berisi rahasia).
3. Untuk repo private, buat token: GitHub → *Settings → Developer settings → Personal access tokens → Fine-grained tokens* → akses repo `luthzzstore` → permission **Contents: Read-only**. Salin tokennya.

Lalu di VPS (SSH):
```bash
apt-get update && apt-get install -y git
cd /root
git clone https://github.com/USERNAME_ANDA/luthzzstore.git
# jika diminta login: Username = username GitHub, Password = TOKEN tadi
cd luthzzstore
```
(Jika repo Anda **Public**, token tidak diperlukan.)

### Cara B: lewat SFTP (Termius)
Pada Termius buka tab **SFTP** untuk host VPS, unggah folder proyek ke `/root/luthzzstore/`, lalu di terminal: `cd /root/luthzzstore`.

## 5. Deploy otomatis (1 perintah)
Di VPS, dari dalam folder proyek:
```bash
sudo bash deploy/setup-vps.sh tokoanda.com emailanda@gmail.com
```
Ganti `tokoanda.com` dengan domain Anda dan email dengan email asli (dipakai Let's Encrypt untuk notifikasi sertifikat).

Script akan, secara berurutan:
1. Memasang Nginx, Certbot, UFW, dan Node.js 22.
2. Menyalin aplikasi ke `/opt/luthzzstore` dan membuat user sistem `luthzz` (tanpa login shell).
3. Membuat `.env` dengan **password admin acak** + `SESSION_SECRET` acak — **catat password admin yang tampil di layar** (juga ada di `/opt/luthzzstore/.env`).
4. Memasang service **systemd** `luthzzstore` (otomatis hidup saat VPS reboot, restart sendiri jika crash).
5. Mengatur Nginx sebagai reverse proxy + firewall (hanya SSH, 80, 443 terbuka; port 3000 tertutup untuk publik).
6. Memasang **HTTPS gratis** (Let's Encrypt) + redirect HTTP→HTTPS + **perpanjangan otomatis**.

Script aman dijalankan ulang; data dan `.env` tidak ditimpa.

## 6. Cek hasil
- Buka `https://tokoanda.com` → toko tampil dengan produk contoh.
- Buka `https://tokoanda.com/admin` → login dengan password admin dari langkah 5.
- Di admin: tambah produk/kategori, ubah pengaturan toko (nomor WhatsApp, nama toko, banner), lalu tambahkan produk dengan isi otomatis (bagian 8.5). Pesanan yang sudah dibayar muncul di tab **Pesanan**.
- Cek dari terminal VPS:
```bash
systemctl status luthzzstore --no-pager
curl -s https://tokoanda.com/healthz        # {"ok":true}
journalctl -u luthzzstore -n 50 --no-pager  # log aplikasi
```
Lengkapi nama toko & kontak di *Admin → Pengaturan*. Lanjutkan ke bagian 8 untuk mengaktifkan pembayaran.

Ganti password admin kapan saja:
```bash
sudo nano /opt/luthzzstore/.env      # ubah ADMIN_PASSWORD (Ctrl+O simpan, Ctrl+X keluar)
sudo systemctl restart luthzzstore
```

## 7. Login Google (opsional)
Tombol "Masuk dengan Google" aktif jika `GOOGLE_CLIENT_ID` terisi. **Wajib HTTPS + domain** (tidak bisa dengan IP).
1. Buka console.cloud.google.com → buat project → *APIs & Services → OAuth consent screen* (isi nama aplikasi & email) → publish.
2. *Credentials → Create credentials → OAuth client ID → Web application*.
3. **Authorized JavaScript origins:** `https://tokoanda.com`
4. **Authorized redirect URIs:** `https://tokoanda.com/auth/google/callback`
5. Salin **Client ID** (berakhiran `.apps.googleusercontent.com`) lalu:
```bash
sudo nano /opt/luthzzstore/.env      # isi GOOGLE_CLIENT_ID=...
sudo systemctl restart luthzzstore
```
Daftar/login dengan email + password tetap berfungsi tanpa Google.

## 8. Pembayaran BuatQris & produk digital

### 8.1 Cara kerja
| Situasi | Yang terjadi |
|---|---|
| Pembeli **Deposit** | Pilih nominal di `/account` → QRIS dibuat → setelah dibayar, saldo bertambah otomatis |
| Beli produk, **saldo cukup** | Saldo dipotong, pesanan lunas seketika, produk langsung terkirim |
| Beli produk, **saldo tidak cukup** | QRIS untuk total pesanan langsung dibuat → setelah pembayaran terdeteksi, produk terkirim otomatis |
| Produk tanpa isi otomatis | Pesanan lunas tetapi berstatus *Pending*; admin kirim manual |

Pembeli **wajib login** (agar produk tersimpan di akunnya). Produk yang sudah dibeli selalu bisa dilihat/diunduh lagi di `/account → Pesanan Saya`. Status pembayaran dikonfirmasi dua jalur: **webhook** BuatQris (seketika) dan **pengecekan status otomatis** dari halaman pembayaran (cadangan jika webhook belum disetel). Pesanan hanya dianggap lunas jika nominal cocok; webhook diverifikasi tanda tangan HMAC-SHA256 dan diproses idempoten (tidak ada saldo/stok ganda).

### 8.2 Isi `.env` (kredensial BuatQris)
Ambil di dashboard BuatQris → menu **Open API**: `account_id`, `secret_token` (diawali `sk_live_`), dan **Signing Secret**.
```bash
sudo nano /opt/luthzzstore/.env
```
```
BUATQRIS_ACCOUNT_ID=isi_account_id
BUATQRIS_SECRET_TOKEN=sk_live_xxxxxxxxxxxxxxxxxxxx
BUATQRIS_SIGNING_SECRET=isi_signing_secret
BUATQRIS_TEST=true        # sandbox dulu! ganti false saat live
BUATQRIS_FEE_BY=buyer     # buyer = biaya admin ditanggung pembeli
```
```bash
sudo systemctl restart luthzzstore
journalctl -u luthzzstore -n 20 --no-pager   # pastikan tidak ada peringatan [PAY]
```
> **Jangan pernah** menempelkan `secret_token` / Signing Secret di chat, repo GitHub, atau kode frontend. Kalau sempat bocor: dashboard BuatQris → Open API → *Regenerate*, lalu perbarui `.env`.

### 8.3 Pasang Webhook di BuatQris
Dashboard BuatQris → Open API → kartu **Webhook / Callback** → isi URL:
```
https://tokoanda.com/api/buatqris/webhook
```
Pastikan Signing Secret di dashboard sama dengan `BUATQRIS_SIGNING_SECRET`. Panggilan API BuatQris hanya dilakukan dari server ini (aman). Di dashboard BuatQris juga isi **Profil → Website / Link Usaha** dengan `https://tokoanda.com`.

### 8.4 Uji sandbox → live (wajib)
1. Dengan `BUATQRIS_TEST=true`, buka `/account`, buat deposit → bayar (sandbox tanpa uang asli) → saldo harus bertambah.
2. Beli produk dengan saldo kurang → muncul QRIS → setelah "dibayar", produk harus muncul otomatis.
3. Jika semua benar, ubah `BUATQRIS_TEST=false`, `sudo systemctl restart luthzzstore`, lalu uji satu transaksi kecil sungguhan (mis. Rp 1.000).

Batas QRIS mengikuti BuatQris: min Rp 1.000, maks Rp 5.000.000 (bisa diubah lewat `QRIS_MIN`/`QRIS_MAX`). Pesanan di bawah minimum dan saldo kurang → pembeli diminta deposit dulu.

### 8.5 Mengisi produk yang dikirim otomatis (Admin)
1. `/admin` → **Produk** → *Tambah* (atau *Edit*).
2. Di bagian **⚡ Isi Produk yang Dikirim Otomatis** pilih:
   - **Upload file** — script / source code / `.zip` (maks `MAX_UPLOAD_MB`, default 200 MB). Disimpan **privat** di `/opt/luthzzstore/data/files/`; tidak bisa diakses langsung, hanya lewat unduhan pembeli yang sudah lunas.
   - **Teks / link / akun / lisensi** — misalnya link Google Drive, kode lisensi, atau instruksi.
3. Simpan. Produk bertanda ⚡ **FILE/TEKS** dan di toko tampil "Produk digital — dikirim otomatis".
4. Mengganti file/teks di kemudian hari ikut berlaku untuk pembeli lama (berguna untuk update versi). Menghapus produk **tidak** mencabut akses pembeli yang sudah membayar.

> Stok produk berkurang saat pembayaran lunas. Untuk produk digital tak terbatas isi stok dengan angka besar (mis. 9999); stok `0` = habis.
> Memakai Cloudflare Proxy (awan oranye)? Cloudflare membatasi upload 100 MB pada paket gratis — unggah file besar dengan awan abu-abu sementara, atau pecah file.

## 9. Update, backup, restore
**Update kode** (data & `.env` aman):
```bash
cd /root/luthzzstore
sudo bash deploy/update.sh      # menjalankan git pull lalu restart service
```
**Backup database + file produk** (aman saat server berjalan):
```bash
sudo bash deploy/backup.sh      # hasil: /var/backups/luthzzstore/store-TANGGAL.db dan files-TANGGAL.tar.gz
```
Backup otomatis tiap hari jam 03:00:
```bash
echo '0 3 * * * root bash /opt/luthzzstore/deploy/backup.sh >/dev/null 2>&1' | sudo tee /etc/cron.d/luthzzstore-backup
```
Unduh backup ke HP lewat tab SFTP Termius (`/var/backups/luthzzstore/`).

**Restore:**
```bash
sudo systemctl stop luthzzstore
sudo cp /var/backups/luthzzstore/store-XXXX.db /opt/luthzzstore/data/store.db
sudo rm -f /opt/luthzzstore/data/store.db-wal /opt/luthzzstore/data/store.db-shm
sudo chown luthzz:luthzz /opt/luthzzstore/data/store.db
# file produk (jika ada backup files-*.tar.gz):
sudo tar -xzf /var/backups/luthzzstore/files-XXXX.tar.gz -C /opt/luthzzstore/data && sudo chown -R luthzz:luthzz /opt/luthzzstore/data
sudo systemctl start luthzzstore
```
> Semua data (produk, saldo, pesanan, pengguna) ada di `data/store.db`, dan file produk di `data/files/`. Reinstall VPS menghapusnya — selalu backup dulu.

## 10. Deploy manual (tanpa script)
Untuk yang ingin memahami tiap langkah (Ubuntu/Debian, sebagai root):
```bash
# 1. Paket & Node.js 22
apt-get update && apt-get install -y curl rsync nginx certbot python3-certbot-nginx ufw openssl
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
node -v      # harus >= 22.13

# 2. Aplikasi
useradd --system --home /opt/luthzzstore --shell /usr/sbin/nologin luthzz
mkdir -p /opt/luthzzstore && rsync -a --exclude .git ./ /opt/luthzzstore/
cp /opt/luthzzstore/.env.example /opt/luthzzstore/.env
nano /opt/luthzzstore/.env           # isi ADMIN_PASSWORD & SESSION_SECRET (openssl rand -hex 32)
chmod 600 /opt/luthzzstore/.env && chown -R luthzz:luthzz /opt/luthzzstore

# 3. Service
cp /opt/luthzzstore/deploy/luthzzstore.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now luthzzstore

# 4. Nginx (ganti tokoanda.com)
sed "s/__DOMAIN__/tokoanda.com/g" /opt/luthzzstore/deploy/nginx.conf > /etc/nginx/sites-available/luthzzstore
ln -sf /etc/nginx/sites-available/luthzzstore /etc/nginx/sites-enabled/ && rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# 5. Firewall & HTTPS
ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw --force enable
certbot --nginx -d tokoanda.com -d www.tokoanda.com -m emailanda@gmail.com --agree-tos --redirect
```

## 11. Alternatif: Cloudflare Tunnel
Tanpa membuka port 80/443 dan tanpa Nginx. Domain harus memakai DNS Cloudflare.
1. Cloudflare Zero Trust → *Networks → Tunnels → Create tunnel* → salin **token**.
2. *Public Hostname* → domain Anda → Service `http://localhost:3000`.
3. Pasang kode di VPS, isi `.env`: `TUNNEL_TOKEN=...` dan `HOST=127.0.0.1`, lalu jalankan `npm start` (di bawah `systemd`/`pm2` agar permanen).

Cara Nginx pada langkah 5 lebih sederhana dan direkomendasikan.

## 12. Variabel `.env`
| Variabel | Fungsi | Default |
|---|---|---|
| `ADMIN_PASSWORD` | Password `/admin`. **Wajib diisi.** Jika kosong, server membuat password sementara dan menyimpannya di `data/.initial-admin-password` | — |
| `SESSION_SECRET` | Kunci penanda tangan sesi login (`openssl rand -hex 32`) | dibuat otomatis & disimpan di DB |
| `PORT` | Port internal aplikasi | `3000` |
| `HOST` | `127.0.0.1` = hanya lewat Nginx (disarankan) | `0.0.0.0` |
| `DB_PATH` | Lokasi database SQLite | `./data/store.db` |
| `GOOGLE_CLIENT_ID` | Mengaktifkan login Google | kosong (nonaktif) |
| `BUATQRIS_ACCOUNT_ID`, `BUATQRIS_SECRET_TOKEN` | Kredensial API BuatQris (wajib agar deposit/QRIS aktif) | kosong |
| `BUATQRIS_SIGNING_SECRET` | Verifikasi webhook BuatQris | kosong |
| `BUATQRIS_TEST` | `true` = sandbox tanpa uang asli | `false` |
| `BUATQRIS_FEE_BY` | `buyer` / `user` — penanggung biaya admin | `buyer` |
| `BUATQRIS_METHOD`, `QRIS_MIN`, `QRIS_MAX` | Metode QRIS & batas nominal | default BuatQris |
| `MAX_UPLOAD_MB` | Batas ukuran file produk | `200` |
| `COOKIE_SECURE` | Biarkan kosong; otomatis aktif lewat HTTPS | auto |
| `TUNNEL_TOKEN`, `START_TUNNEL`, `QUICK_TUNNEL` | Hanya untuk `npm start` (Cloudflare Tunnel) | — |

## 13. Troubleshooting
| Gejala | Penyebab & solusi |
|---|---|
| Certbot gagal / "Timeout during connect" | DNS belum mengarah ke IP VPS, atau port 80 diblokir firewall penyedia VPS (buka 80 & 443 di panel). Perbaiki lalu ulangi: `sudo certbot --nginx -d tokoanda.com -d www.tokoanda.com -m email --agree-tos --redirect` |
| Certbot gagal hanya untuk `www` | Tambahkan A record `www`, atau pakai perintah tanpa `-d www.tokoanda.com` |
| `502 Bad Gateway` | Aplikasi mati: `journalctl -u luthzzstore -n 80 --no-pager` lalu `sudo systemctl restart luthzzstore` |
| Log: `node:sqlite` tidak didukung | Node terlalu lama. Cek `node -v` harus ≥ 22.13; jalankan ulang `setup-vps.sh` |
| Tidak bisa login admin | Cek `ADMIN_PASSWORD` di `/opt/luthzzstore/.env`; restart service setelah mengubah. Setelah 8x salah, tunggu 15 menit |
| Login pengguna terus kembali ke halaman login | Akses lewat HTTPS (bukan HTTP). Pastikan Nginx meneruskan `X-Forwarded-Proto` (sudah ada di `deploy/nginx.conf`) |
| Google: "Client ID tidak cocok" / error 400 | Origin & redirect URI di Google Console harus persis `https://domain-anda` dan `https://domain-anda/auth/google/callback` |
| Deposit/QRIS: "belum diaktifkan" | `BUATQRIS_ACCOUNT_ID` & `BUATQRIS_SECRET_TOKEN` belum diisi / service belum di-restart |
| "Pembayaran gagal dibuat" | Kredensial salah, akun BuatQris belum lengkap, atau nominal di luar batas. Lihat `journalctl -u luthzzstore -n 50` (baris `[BQ]`) |
| Sudah bayar tapi produk belum terkirim | Cek webhook (8.3) dan Signing Secret. Pembeli bisa tekan "Saya sudah bayar — cek status"; sistem juga cek otomatis tiap ±20 dtk |
| Webhook 401 | Signing Secret di `.env` berbeda dengan di dashboard BuatQris |
| Upload file produk gagal (413) | Naikkan `MAX_UPLOAD_MB` **dan** `client_max_body_size` di `/etc/nginx/sites-available/luthzzstore`, lalu `sudo systemctl reload nginx` |
| Perubahan kode tidak muncul | `sudo bash deploy/update.sh`; lalu hard refresh browser |
| Lupa password admin | Edit `ADMIN_PASSWORD` di `/opt/luthzzstore/.env`, `sudo systemctl restart luthzzstore` |
| Disk penuh | `journalctl --vacuum-time=7d`; hapus backup lama di `/var/backups/luthzzstore` |

Perintah berguna:
```bash
sudo systemctl restart luthzzstore     # restart aplikasi
sudo systemctl reload nginx            # reload Nginx
sudo certbot renew --dry-run           # tes perpanjangan SSL otomatis
sudo ufw status                        # status firewall
```

## Keamanan
Harga & saldo dihitung di server (tidak bisa dimanipulasi dari browser); file produk privat & hanya bisa diunduh pemilik pesanan lunas; webhook diverifikasi HMAC; secret BuatQris hanya di server. Password pengguna di-hash scrypt; sesi cookie `HttpOnly` + `Secure`; token Google diverifikasi tanda tangan RS256, `aud`, `iss`, `exp`; login/daftar/pesanan dibatasi per IP; harga pesanan dihitung ulang di server; input pesanan di-escape. Jangan pernah membagikan atau meng-commit file `.env`.

## Live Chat
- Widget chat ada di toko (tombol kiri-bawah). Balas pesan dari dashboard admin: sidebar **Live Chat → Pesan Masuk**.
- Realtime memakai Server-Sent Events (tanpa dependensi baru). Tabel `chat_threads` dan `chat_msgs` dibuat otomatis.
- Jika memakai Nginx, pakai `deploy/nginx.conf` terbaru (blok `/api/.../stream` dengan `proxy_buffering off`), kalau tidak pesan bisa tertunda.

## Database (admin → Lainnya → Database)

Menu untuk mengelola database SQLite langsung dari dashboard admin:

- **Ringkasan**: ukuran database, jumlah baris per tabel, ukuran file produk/upload/chat, **Cek Integritas**, dan **Optimasi (VACUUM)**.
- **Backup**: *Backup Sekarang* / *Backup & Unduh* (disimpan di `data/backups/`), daftar backup (unduh, pulihkan, hapus), **Pulihkan dari File .db**, dan **backup otomatis tiap 24 jam** (opsional).
- **Reset**: per bagian (pesanan, pengguna & saldo, live chat, request custom, katalog) atau **semua data**. Untuk "Semua data" ada opsi mempertahankan Pengaturan toko, Setting Apikey, dan banner promo.

Pengaman: reset & pulihkan wajib mengetik kata konfirmasi (`RESET` / `RESTORE`), dan **backup pengaman dibuat otomatis** (label *pra-reset* / *pra-pulihkan*) sebelum data diubah. Sesi login admin tidak terputus saat reset/pulihkan. Backup hanya berisi database; file produk digital di `data/files` disalin terpisah bila perlu.

Variabel `.env` opsional: `BACKUP_KEEP` (jumlah backup yang disimpan, default 20) dan `DB_UPLOAD_MB` (batas ukuran upload file .db, default 200).

---

## 14. Notifikasi HP (Web Push)
Web meminta izin notifikasi (banner "Aktifkan notifikasi?"), lalu semua notifikasi muncul di **notifikasi HP** — juga saat web/browser sedang ditutup.

| Penerima | Notifikasi |
|---|---|
| **Pembeli** | pembayaran/pesanan berhasil, pesanan selesai, deposit berhasil, saldo diubah admin, balasan live chat, update request custom, pengumuman/promo baru |
| **Admin** | pesanan baru (ikut pengaturan *Notifikasi Pesanan Baru*), stok menipis/habis (ikut *Notifikasi Stok Menipis*), deposit masuk, pesan live chat baru, request custom baru |

- **Wajib HTTPS** (domain + sertifikat dari langkah 5). Di `http://` biasa browser menolak notifikasi.
- **Android (Chrome/Edge/Firefox/Samsung)**: buka web → ketuk *Aktifkan*. Tidak perlu memasang aplikasi.
- **iPhone/iPad (iOS 16.4+)**: buka di Safari → *Bagikan → Tambah ke Layar Utama*, lalu buka web dari ikon itu dan ketuk *Aktifkan*.
- **Admin**: buka `/admin` → banner izin muncul otomatis, atau **Pengaturan → Notifikasi → Aktifkan** (ada tombol *Kirim tes*). Pembeli: **Akun → Notifikasi**.
- Kunci VAPID dibuat otomatis dan tersimpan di database (tetap ada saat reset database). Jika database dipulihkan dari backup lama, perangkat akan berlangganan ulang sendiri saat web dibuka.
- Opsional di `.env`: `VAPID_SUBJECT=mailto:emailanda@domain.com` (kontak untuk layanan push), `PUSH_ALLOW_HOSTS=host1,host2` (tambah layanan push yang diizinkan; default hanya Google/FCM, Mozilla, Apple, Windows).
- Tidak ada paket tambahan (`npm install` tetap tidak perlu): enkripsi Web Push ditulis dengan modul `crypto` bawaan Node (`webpush.js`).

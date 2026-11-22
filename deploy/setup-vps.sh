#!/usr/bin/env bash
# Setup otomatis LuthzzStore di VPS Ubuntu/Debian (jalankan sebagai root).
# Pemakaian:   sudo bash deploy/setup-vps.sh domainanda.com email@anda.com
# Aman dijalankan ulang (idempoten): data & .env yang sudah ada tidak ditimpa.
set -euo pipefail

DOMAIN="${1:-}"; EMAIL="${2:-}"
APP_USER="luthzz"; APP_DIR="/opt/luthzzstore"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

[ "$(id -u)" = 0 ] || { echo "Jalankan sebagai root: sudo bash deploy/setup-vps.sh domain email"; exit 1; }
[ -n "$DOMAIN" ] && [ -n "$EMAIL" ] || { echo "Pemakaian: sudo bash deploy/setup-vps.sh domainanda.com email@anda.com"; exit 1; }
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || { echo "Domain tidak valid: $DOMAIN"; exit 1; }
command -v apt-get >/dev/null || { echo "Script ini untuk Ubuntu/Debian (apt)."; exit 1; }

export DEBIAN_FRONTEND=noninteractive
echo "==> [1/7] Memasang paket dasar"
apt-get update -y
apt-get install -y curl ca-certificates rsync nginx certbot python3-certbot-nginx ufw openssl

echo "==> [2/7] Memasang Node.js 22 (butuh >= 22.13)"
need_node=1
if command -v node >/dev/null; then
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' && need_node=0
fi
if [ "$need_node" = 1 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "==> [3/7] Menyiapkan user & folder aplikasi"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR/data"
rsync -a --delete \
  --exclude '.env' --exclude 'data/' --exclude '.git/' --exclude 'node_modules/' --exclude 'bin/' \
  "$SRC_DIR/" "$APP_DIR/"
mkdir -p "$APP_DIR/data"

echo "==> [4/7] Membuat .env (bila belum ada)"
if [ ! -f "$APP_DIR/.env" ]; then
  ADMIN_PW="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"
  cat > "$APP_DIR/.env" <<ENV
ADMIN_PASSWORD=$ADMIN_PW
SESSION_SECRET=$(openssl rand -hex 32)
PORT=3000
HOST=127.0.0.1
GOOGLE_CLIENT_ID=
BUATQRIS_ACCOUNT_ID=
BUATQRIS_SECRET_TOKEN=
BUATQRIS_SIGNING_SECRET=
BUATQRIS_TEST=true
BUATQRIS_FEE_BY=buyer
MAX_UPLOAD_MB=200
ENV
  echo "    PASSWORD ADMIN BARU: $ADMIN_PW   (catat! juga tersimpan di $APP_DIR/.env)"
else
  echo "    .env sudah ada, tidak diubah."
fi
chmod 600 "$APP_DIR/.env"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

echo "==> [5/7] Memasang service systemd"
install -m 644 "$APP_DIR/deploy/luthzzstore.service" /etc/systemd/system/luthzzstore.service
systemctl daemon-reload
systemctl enable luthzzstore >/dev/null
systemctl restart luthzzstore
sleep 2
curl -fsS http://127.0.0.1:3000/healthz >/dev/null && echo "    Aplikasi hidup (healthz OK)" \
  || { echo "    GAGAL start. Cek: journalctl -u luthzzstore -n 50 --no-pager"; exit 1; }

echo "==> [6/7] Mengatur Nginx + firewall"
sed "s/__DOMAIN__/$DOMAIN/g" "$APP_DIR/deploy/nginx.conf" > /etc/nginx/sites-available/luthzzstore
ln -sf /etc/nginx/sites-available/luthzzstore /etc/nginx/sites-enabled/luthzzstore
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx >/dev/null; systemctl reload nginx || systemctl restart nginx
ufw allow OpenSSH >/dev/null; ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null

echo "==> [7/7] Memasang HTTPS (Let's Encrypt) untuk $DOMAIN"
# Pastikan DNS A record $DOMAIN (dan www) sudah mengarah ke IP VPS ini.
if certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" -m "$EMAIL" --agree-tos --no-eff-email --redirect --non-interactive; then
  :
elif certbot --nginx -d "$DOMAIN" -m "$EMAIL" --agree-tos --no-eff-email --redirect --non-interactive; then
  echo "    (HTTPS dipasang untuk $DOMAIN saja; www belum punya DNS)"
else
  echo "    HTTPS GAGAL. Biasanya DNS belum menunjuk ke VPS. Perbaiki DNS lalu jalankan:"
  echo "    sudo certbot --nginx -d $DOMAIN -d www.$DOMAIN -m $EMAIL --agree-tos --redirect"
  exit 1
fi

echo
echo "SELESAI. Buka: https://$DOMAIN   | Admin: https://$DOMAIN/admin"
echo "Langkah berikut: isi BUATQRIS_* di $APP_DIR/.env lalu: systemctl restart luthzzstore (lihat README bagian 8)"
echo "Webhook BuatQris: https://$DOMAIN/api/buatqris/webhook"

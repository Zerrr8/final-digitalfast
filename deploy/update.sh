#!/usr/bin/env bash
# Update aplikasi dari folder repo ini ke /opt/luthzzstore (data & .env tetap aman).
# Pemakaian (dari folder repo):  sudo bash deploy/update.sh
set -euo pipefail
APP_DIR="/opt/luthzzstore"; SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ "$(id -u)" = 0 ] || { echo "Jalankan dengan sudo."; exit 1; }
[ -d "$SRC_DIR/.git" ] && git -C "$SRC_DIR" pull --ff-only || true
rsync -a --delete --exclude '.env' --exclude 'data/' --exclude '.git/' --exclude 'node_modules/' --exclude 'bin/' "$SRC_DIR/" "$APP_DIR/"
chown -R luthzz:luthzz "$APP_DIR"
install -m 644 "$APP_DIR/deploy/luthzzstore.service" /etc/systemd/system/luthzzstore.service
systemctl daemon-reload && systemctl restart luthzzstore
sleep 2; curl -fsS http://127.0.0.1:3000/healthz && echo " <- update OK"

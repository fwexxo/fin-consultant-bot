#!/usr/bin/env bash
set -euo pipefail

HOST=${1:-root@203.0.113.10}
APP=/opt/fin-bot

echo "==> Сборка"
npm ci
npm run build

echo "==> Подготовка машины"
ssh "$HOST" bash -s <<'REMOTE'
set -euo pipefail
id -u finbot >/dev/null 2>&1 || useradd --system --home /opt/fin-bot --shell /usr/sbin/nologin finbot
mkdir -p /opt/fin-bot/{data,backups}
command -v sqlite3 >/dev/null || { apt-get update -qq && apt-get install -y -qq sqlite3; }
command -v rsync   >/dev/null || { apt-get update -qq && apt-get install -y -qq rsync; }
REMOTE

echo "==> Загрузка кода"
# .env не передаётся намеренно: секреты заводятся на сервере руками
# и не проходят ни через git, ни через историю команд.
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude data \
  --exclude backups --exclude .env \
  dist package.json package-lock.json "$HOST:$APP/"

echo "==> Зависимости на сервере"
ssh "$HOST" "cd $APP && npm ci --omit=dev"

echo "==> Сервис"
scp -q deploy/fin-bot.service "$HOST:/etc/systemd/system/fin-bot.service"
scp -q deploy/backup.sh "$HOST:$APP/backup.sh"

ssh "$HOST" bash -s <<REMOTE
set -euo pipefail
chmod +x $APP/backup.sh
chown -R finbot:finbot $APP
chmod 600 $APP/.env 2>/dev/null || true
systemctl daemon-reload
systemctl enable --quiet fin-bot
systemctl restart fin-bot
sleep 4
systemctl is-active fin-bot
REMOTE

echo "==> Готово. Логи: ssh $HOST journalctl -u fin-bot -f"

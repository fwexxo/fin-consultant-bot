#!/usr/bin/env bash
#
# Ставит наблюдатель за СМС в launchd на маке.
#
# Настройки берутся из окружения или из mac/watcher.env (этот файл
# в .gitignore, потому что содержит номер карты и адрес сервера).
#
set -euo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGDIR="$HOME/Library/Logs/fin-bot"
LABEL="local.finbot.sms"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$HOME/.local/bin/finbot-node"

# Локальные настройки, если есть
[ -f "$APP/mac/watcher.env" ] && . "$APP/mac/watcher.env"

: "${SSH_TARGET:?Задай SSH_TARGET (например root@203.0.113.10) в mac/watcher.env}"
: "${SMS_CARD_PREFIX:?Задай SMS_CARD_PREFIX (например 'Счёт карты MIR-1234')}"
: "${SMS_SINCE:?Задай SMS_SINCE — дату, с которой писать операции (ГГГГ-ММ-ДД)}"
SMS_SENDER="${SMS_SENDER:-900}"
REMOTE_APP="${REMOTE_APP:-/opt/fin-bot}"

SYSTEM_NODE="$(command -v node || true)"
[ -n "$SYSTEM_NODE" ] || { echo "node не найден в PATH"; exit 1; }
[ -f "$APP/dist/mac/watch-sms.js" ] || { echo "Сначала собери проект: npm run build"; exit 1; }

# Отдельная копия node только для наблюдателя.
#
# Полный доступ к диску выдаётся конкретному исполняемому файлу. Если
# выдать его системному node, доступ получит любой node-скрипт на маке.
# Своя копия ограничивает разрешение одним наблюдателем и заодно
# переживает переустановку основного node.
REAL_NODE="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$SYSTEM_NODE")"
mkdir -p "$(dirname "$NODE")"
if [ ! -x "$NODE" ] || ! cmp -s "$REAL_NODE" "$NODE"; then
  cp "$REAL_NODE" "$NODE"
  chmod +x "$NODE"
  echo "Создан выделенный бинарь: $NODE"
  echo "ВНИМАНИЕ: доступ к диску нужно выдать заново — это новый файл."
fi

mkdir -p "$LOGDIR" "$(dirname "$PLIST")"

sed -e "s|__NODE__|$NODE|g" \
    -e "s|__APP__|$APP|g" \
    -e "s|__LOGDIR__|$LOGDIR|g" \
    -e "s|__SSH_TARGET__|$SSH_TARGET|g" \
    -e "s|__SMS_CARD_PREFIX__|$SMS_CARD_PREFIX|g" \
    -e "s|__SMS_SINCE__|$SMS_SINCE|g" \
    -e "s|__SMS_SENDER__|$SMS_SENDER|g" \
    -e "s|__REMOTE_APP__|$REMOTE_APP|g" \
    -e "s|__HOME__|$HOME|g" \
    "$APP/mac/watcher.plist.template" > "$PLIST"

# bootout может не найти задание при первой установке — это не ошибка.
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"
launchctl enable "gui/$UID/$LABEL"

echo "Наблюдатель установлен."
echo "  задание: $LABEL (каждые 5 минут)"
echo "  сервер:  $SSH_TARGET"
echo "  карта:   $SMS_CARD_PREFIX"
echo "  с даты:  $SMS_SINCE"
echo "  логи:    $LOGDIR/sms-watch.log"
echo
echo "Проверить сейчас:  launchctl kickstart -p gui/$UID/$LABEL"
echo "Холостой прогон:   SMS_DRY_RUN=1 $NODE $APP/dist/mac/watch-sms.js"
echo "Остановить:        launchctl bootout gui/$UID/$LABEL"
echo
echo "ОСТАЛСЯ ОДИН ШАГ ВРУЧНУЮ — полный доступ к диску:"
echo "  Системные настройки → Конфиденциальность и безопасность →"
echo "  Полный доступ к диску → + → Cmd+Shift+G → вставить путь:"
echo ""
echo "    $NODE"
echo ""
echo "Без этого база Messages не читается и наблюдатель падает"
echo "с ошибкой unable to open database file."

#!/usr/bin/env bash
#
# Ставит наблюдатель за СМС в launchd на маке.
#
# ВАЖНО: после установки нужно вручную выдать полный доступ к диску.
# Без него база Messages не читается, и наблюдатель будет падать.
# Системные настройки → Конфиденциальность и безопасность →
# Полный доступ к диску → добавить /bin/bash и исполняемый файл node.
#
set -euo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGDIR="$HOME/Library/Logs/fin-bot"
PLIST="$HOME/Library/LaunchAgents/by.fwexxo.finbot.sms.plist"
LABEL="by.fwexxo.finbot.sms"
NODE="$HOME/.local/bin/finbot-node"

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
    "$APP/mac/by.fwexxo.finbot.sms.plist" > "$PLIST"

# bootout может не найти задание при первой установке — это не ошибка.
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"
launchctl enable "gui/$UID/$LABEL"

echo "Наблюдатель установлен."
echo "  задание: $LABEL (каждые 5 минут)"
echo "  логи:    $LOGDIR/sms-watch.log"
echo
echo "Проверить сейчас:  launchctl kickstart -p gui/$UID/$LABEL"
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

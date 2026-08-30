#!/usr/bin/env bash
#
# Собственно приём оплаты. Запускается ТОЛЬКО через sudo от finbot,
# отдельной строкой в sudoers. Лежит вне /opt/fin-bot и принадлежит root,
# чтобы сам бот не мог себе ничего переписать.
#
set -euo pipefail
export HOME=/opt/fin-bot
cd /opt/fin-bot
exec /usr/bin/node dist/cli/ingest-applepay.js

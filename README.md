# Финансовый консультант

Персональный телеграм-бот для мини-бухгалтерии в трёх валютах (RUB, BYN, USD):
учёт трат и доходов, постоянные месячные платежи с напоминанием о сроках,
аналитика и прогноз.

Бот рассчитан на **одного пользователя** и отвечает только владельцу.

## Как устроен

Три слоя с разной природой:

- **Учёт** — TypeScript + SQL. Балансы и суммы считаются детерминированно.
- **Разбор ввода** — Claude превращает «кофе 5 руб» в структурированную запись.
- **Консультант** — Claude отвечает на открытые вопросы, читая базу через SQL.

Полный дизайн: [`docs/superpowers/specs/2026-08-19-telegram-finance-bot-design.md`](docs/superpowers/specs/2026-08-19-telegram-finance-bot-design.md)

## Запуск

```bash
npm install
cp .env.example .env   # заполнить токен и OWNER_ID
npm run migrate
npm start
```

## Ограничение

Бот не даёт персональных инвестиционных рекомендаций. Он считает и объясняет
твои собственные деньги; решения о вложениях остаются за тобой.

## Деплой

```bash
./deploy/deploy.sh root@203.0.113.10
```

Скрипт собирает проект, заливает `dist/`, ставит systemd-юнит и перезапускает
сервис. `.env` намеренно не передаётся — секреты заводятся на сервере руками,
чтобы не проходить через git и историю команд.

Первое наполнение базы на сервере:

```bash
ssh root@203.0.113.10 'cd /opt/fin-bot && sudo -u finbot env HOME=/opt/fin-bot node dist/db/seed-cli.js'
```

Логи: `ssh root@203.0.113.10 journalctl -u fin-bot -f`

Бэкапы базы снимаются по cron ежедневно в 3:30, хранятся 30 последних копий.

### Ограничение памяти

Юнит выставляет `MemoryMax=700M`. Claude Agent SDK запускает `claude` CLI
подпроцессом, и без потолка связка способна исчерпать RAM машины.

## Фото и голосовые

**Фото** уходят агенту напрямую картинкой — Claude мультимодален, сторонний
сервис не нужен. Чек, экран заказа, выписка: агент достаёт суммы сам.

**Голосовые** расшифровывает `whisper.cpp` на сервере. Установка:

```bash
apt-get install -y build-essential cmake git ffmpeg
git clone --depth 1 https://github.com/ggml-org/whisper.cpp /opt/whisper.cpp
cd /opt/whisper.cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j1
bash ./models/download-ggml-model.sh base
ln -sf /opt/whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli
```

Затем в `.env`:

```
WHISPER_BIN=/usr/local/bin/whisper-cli
WHISPER_MODEL=/opt/whisper.cpp/models/ggml-base.bin
```

Без этих переменных распознавание просто выключено — бот попросит написать
текстом и продолжит работать.

### Выбор модели

Замерено на 1 ядре AMD EPYC с AVX2, русская речь:

| Модель | Время на сообщение | Пик памяти | Качество |
|---|---|---|---|
| `base` | 5–6 сек | 285 МБ | суммы верно, редкие слова путает |
| `small` | 21–24 сек | 747 МБ | верно всё |

По умолчанию `base`. Переезд на `small` — правка `WHISPER_MODEL`, пересборка
не нужна; заодно подними `MemoryMax` в юните.

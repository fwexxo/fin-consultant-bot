import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readSms } from '../ingest/imessage.ts';

/** Запускает команду, передаёт payload в stdin и возвращает stdout. */
function runWithInput(
  file: string,
  args: string[],
  input: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => { stdout += d; });
    child.stderr.on('data', (d: string) => { stderr += d; });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${file}: истекло время ожидания`));
    }, timeoutMs);

    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${file} завершился с кодом ${code}: ${stderr.trim() || stdout.trim()}`));
    });

    child.stdin.end(input);
  });
}

/**
 * Наблюдатель за СМС на маке.
 *
 * Читает базу Messages, отбирает новые сообщения от банка и передаёт их
 * боту на сервер по SSH. Именно SSH, а не HTTP: канал уже настроен и
 * доверен, на сервере не нужно открывать ни одного порта наружу.
 *
 * Требует полного доступа к диску для процесса, который его запускает.
 */

const STATE_PATH = process.env.SMS_STATE
  ?? join(homedir(), '.local/state/fin-bot/sms-watch.json');

const DB_PATH = process.env.MESSAGES_DB
  ?? join(homedir(), 'Library/Messages/chat.db');

/** Обязательная настройка: без неё продолжать нельзя. */
function required(name: string, value: string | undefined): string {
  if (!value) {
    console.error(`Не задана обязательная переменная ${name}`);
    process.exit(2);
  }
  return value;
}

const SENDER = process.env.SMS_SENDER ?? '900';
const REMOTE_APP = process.env.REMOTE_APP ?? '/opt/fin-bot';
const BATCH_LIMIT = Number(process.env.SMS_BATCH_LIMIT ?? '50');

// Ни адреса сервера, ни номера карты в коде нет: это личные данные
// конкретной установки, а не часть программы.
const SSH_TARGET = required('SSH_TARGET', process.env.SSH_TARGET);
const CARD_PREFIX = required('SMS_CARD_PREFIX', process.env.SMS_CARD_PREFIX);
const SINCE_DATE = required('SMS_SINCE', process.env.SMS_SINCE);

interface State { lastRowid: number }

function loadState(): State {
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as State;
    if (typeof parsed.lastRowid === 'number') return parsed;
  } catch {
    // Первого запуска ещё не было — это не ошибка.
  }
  return { lastRowid: 0 };
}

function saveState(state: State): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

async function main(): Promise<void> {
  const state = loadState();

  const fresh = readSms({
    dbPath: DB_PATH,
    sender: SENDER,
    afterRowid: state.lastRowid,
    sinceDate: SINCE_DATE,
    limit: BATCH_LIMIT,
  });

  // Сдвигаем отметку по всем прочитанным сообщениям, а не только по
  // отправленным: чужие счета и реклама не должны перечитываться вечно.
  const maxRowid = fresh.reduce((m, s) => Math.max(m, s.rowid), state.lastRowid);

  const mine = fresh.filter((s) => s.text.startsWith(CARD_PREFIX));

  if (mine.length === 0) {
    if (maxRowid > state.lastRowid) saveState({ lastRowid: maxRowid });
    console.log(`новых по карте нет (просмотрено ${fresh.length})`);
    return;
  }

  // Холостой прогон: показать, что нашлось, ничего не отправляя и не
  // сдвигая отметку. Нужен, чтобы проверять доступ к базе и разбор
  // без записи в настоящую бухгалтерию.
  if (process.env.SMS_DRY_RUN === '1') {
    console.log(`холостой прогон: нашлось ${mine.length} (просмотрено ${fresh.length})`);
    for (const s of mine.slice(0, 10)) {
      console.log(`  ${s.date} ${s.text.slice(0, 90)}`);
    }
    console.log('отметка не сдвинута, на сервер ничего не ушло');
    return;
  }

  const payload = JSON.stringify(mine.map((s) => ({
    rowid: s.rowid, date: s.date, text: s.text,
  })));

  // Секреты не передаём в аргументах: команда видна в списке процессов.
  // CLI сам прочитает .env из рабочего каталога — sudo его сохраняет.
  const stdout = await runWithInput('ssh', [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=15',
    SSH_TARGET,
    `cd ${REMOTE_APP} && sudo -u finbot env HOME=${REMOTE_APP} node dist/cli/ingest-sms.js`,
  ], payload, 120_000);

  // Отметку сдвигаем ТОЛЬКО после успешной передачи. Если сервер
  // недоступен, сообщения останутся неотправленными и уйдут в следующий раз.
  saveState({ lastRowid: maxRowid });

  console.log(`отправлено ${mine.length}: ${stdout.trim()}`);
}

main().catch((err) => {
  console.error('Наблюдатель упал:', (err as Error).message);
  process.exit(1);
});

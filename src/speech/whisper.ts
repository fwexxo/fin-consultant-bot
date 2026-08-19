import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const run = promisify(execFile);

export type Transcriber = (audio: Buffer) => Promise<string>;

export interface WhisperConfig {
  binPath: string;
  modelPath: string;
  ffmpegPath: string;
  language: string;
  threads: number;
  timeoutMs: number;
}

/**
 * Чистит вывод whisper.
 *
 * Модель на тишине и шуме склонна выдавать служебные пометки вроде
 * [BLANK_AUDIO] или (тихая музыка) — их нельзя отдавать агенту как текст,
 * иначе он попытается записать это операцией.
 */
export function cleanTranscript(raw: string): string {
  return raw
    .split('\n')
    .map((line) => line.trim())
    // Строки целиком в скобках — это пометки whisper, а не речь.
    .filter((line) => line && !/^[[(<].*[\])>]$/.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function loadWhisperConfig(env: NodeJS.ProcessEnv): WhisperConfig | null {
  const binPath = env.WHISPER_BIN?.trim();
  const modelPath = env.WHISPER_MODEL?.trim();

  // Оба пути обязательны: без них распознавание просто выключено,
  // и бот честно скажет об этом, а не упадёт при первом голосовом.
  if (!binPath || !modelPath) return null;

  if (!existsSync(binPath)) {
    throw new Error(`WHISPER_BIN указывает на несуществующий файл: ${binPath}`);
  }
  if (!existsSync(modelPath)) {
    throw new Error(`WHISPER_MODEL указывает на несуществующий файл: ${modelPath}`);
  }

  return {
    binPath,
    modelPath,
    ffmpegPath: env.FFMPEG_BIN?.trim() || 'ffmpeg',
    language: env.WHISPER_LANG?.trim() || 'ru',
    threads: Number(env.WHISPER_THREADS?.trim() || '1'),
    timeoutMs: Number(env.WHISPER_TIMEOUT_MS?.trim() || '180000'),
  };
}

/**
 * Расшифровывает голосовое сообщение Телеграма.
 *
 * Телеграм присылает OGG/Opus, а whisper.cpp принимает только WAV
 * 16 кГц моно — отсюда обязательный проход через ffmpeg.
 */
export function createWhisperTranscriber(cfg: WhisperConfig): Transcriber {
  return async (audio: Buffer): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'voice-'));
    const oggPath = join(dir, 'in.ogg');
    const wavPath = join(dir, 'out.wav');

    try {
      await writeFile(oggPath, audio);

      await run(cfg.ffmpegPath, [
        '-hide_banner', '-loglevel', 'error',
        '-i', oggPath,
        '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
        '-y', wavPath,
      ], { timeout: 60_000 });

      const { stdout } = await run(cfg.binPath, [
        '-m', cfg.modelPath,
        '-f', wavPath,
        '-l', cfg.language,
        '-t', String(cfg.threads),
        '-nt',            // без таймкодов
        '-np',            // без служебного вывода
        '--output-txt',
        '--output-file', join(dir, 'result'),
      ], { timeout: cfg.timeoutMs, maxBuffer: 8 * 1024 * 1024 });

      // Предпочитаем файл: stdout у whisper.cpp меняется от версии к версии.
      let text = '';
      try {
        text = await readFile(join(dir, 'result.txt'), 'utf8');
      } catch {
        text = stdout;
      }

      return cleanTranscript(text);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTranscript, loadWhisperConfig } from '../../src/speech/whisper.ts';

test('cleanTranscript склеивает строки в одну', () => {
  assert.equal(cleanTranscript('кофе пять\nрублей\n'), 'кофе пять рублей');
});

test('cleanTranscript выкидывает служебные пометки whisper', () => {
  assert.equal(cleanTranscript('[BLANK_AUDIO]'), '');
  assert.equal(cleanTranscript('(тихая музыка)'), '');
  assert.equal(cleanTranscript('<no speech>'), '');
  assert.equal(
    cleanTranscript('[BLANK_AUDIO]\nкофе пять рублей\n(музыка)'),
    'кофе пять рублей',
  );
});

test('cleanTranscript не трогает скобки внутри речи', () => {
  assert.equal(
    cleanTranscript('купил кофе (большой) за пять'),
    'купил кофе (большой) за пять',
  );
});

test('cleanTranscript схлопывает лишние пробелы', () => {
  assert.equal(cleanTranscript('  кофе    пять   '), 'кофе пять');
});

test('cleanTranscript на пустом вводе даёт пустую строку', () => {
  assert.equal(cleanTranscript(''), '');
  assert.equal(cleanTranscript('\n\n  \n'), '');
});

test('loadWhisperConfig без переменных возвращает null', () => {
  assert.equal(loadWhisperConfig({} as NodeJS.ProcessEnv), null);
});

test('loadWhisperConfig требует обе переменные', () => {
  assert.equal(
    loadWhisperConfig({ WHISPER_BIN: '/bin/ls' } as NodeJS.ProcessEnv),
    null,
    'без модели распознавание должно быть выключено',
  );
  assert.equal(
    loadWhisperConfig({ WHISPER_MODEL: '/bin/ls' } as NodeJS.ProcessEnv),
    null,
    'без бинаря распознавание должно быть выключено',
  );
});

test('loadWhisperConfig падает на несуществующем пути', () => {
  assert.throws(
    () => loadWhisperConfig({
      WHISPER_BIN: '/нет/такого/файла',
      WHISPER_MODEL: '/bin/ls',
    } as NodeJS.ProcessEnv),
    /WHISPER_BIN/,
  );
  assert.throws(
    () => loadWhisperConfig({
      WHISPER_BIN: '/bin/ls',
      WHISPER_MODEL: '/нет/такой/модели',
    } as NodeJS.ProcessEnv),
    /WHISPER_MODEL/,
  );
});

test('loadWhisperConfig подставляет значения по умолчанию', () => {
  const cfg = loadWhisperConfig({
    WHISPER_BIN: '/bin/ls',
    WHISPER_MODEL: '/bin/ls',
  } as NodeJS.ProcessEnv);

  assert.ok(cfg);
  assert.equal(cfg.language, 'ru');
  assert.equal(cfg.threads, 1);
  assert.equal(cfg.ffmpegPath, 'ffmpeg');
});

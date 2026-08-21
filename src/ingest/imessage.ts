import Database from 'better-sqlite3';

/**
 * Чтение СМС из базы Messages на macOS.
 *
 * Работает только на маке и только если у процесса есть полный доступ
 * к диску — это разрешение выдаётся вручную в системных настройках.
 */

export interface RawSms {
  /** ROWID сообщения — устойчивый ключ для защиты от повторной записи. */
  rowid: number;
  /** Локальное время в формате YYYY-MM-DD HH:MM:SS. */
  localTime: string;
  /** Дата в формате YYYY-MM-DD. */
  date: string;
  text: string;
}

/**
 * Достаёт текст из attributedBody.
 *
 * На свежих macOS колонка text пустая, а текст лежит в бинарном архиве
 * NSAttributedString. Внутри него после маркера \x84\x01+ идёт длина
 * (один байт, либо 0x81 с двухбайтовой, либо 0x82 с четырёхбайтовой),
 * а за ней — UTF-8.
 */
export function extractAttributedText(blob: Buffer | null): string | null {
  if (!blob || blob.length === 0) return null;

  const marker = Buffer.from([0x84, 0x01, 0x2b]);
  const at = blob.indexOf(marker);
  if (at === -1) return null;

  let p = at + marker.length;
  if (p >= blob.length) return null;

  let len = blob[p]!;
  p += 1;
  if (len === 0x81) {
    len = blob.readUInt16LE(p);
    p += 2;
  } else if (len === 0x82) {
    len = blob.readUInt32LE(p);
    p += 4;
  }

  if (len <= 0 || p + len > blob.length) return null;
  return blob.subarray(p, p + len).toString('utf8');
}

export interface ReadOptions {
  dbPath: string;
  sender: string;
  /** Только сообщения строго новее этого ROWID. */
  afterRowid?: number;
  /** Только сообщения с этой даты включительно (YYYY-MM-DD). */
  sinceDate?: string;
  limit?: number;
}

export function readSms(opts: ReadOptions): RawSms[] {
  // Строго только чтение: чужую базу нельзя менять даже случайно.
  const db = new Database(opts.dbPath, { readonly: true, fileMustExist: true });

  try {
    // Отбор по дате обязан идти в SQL, а не после выборки: иначе LIMIT
    // отрежет самые старые сообщения, они все отсеются по дате, и до
    // свежих очередь не дойдёт никогда.
    const rows = db.prepare(`
      SELECT m.ROWID AS rowid,
             m.text  AS text,
             m.attributedBody AS blob,
             datetime(m.date/1000000000 + 978307200, 'unixepoch', 'localtime') AS local_time
      FROM message m
      JOIN handle h ON h.ROWID = m.handle_id
      WHERE h.id = ?
        AND m.ROWID > ?
        AND (? IS NULL
             OR date(datetime(m.date/1000000000 + 978307200, 'unixepoch', 'localtime')) >= ?)
      ORDER BY m.ROWID
      LIMIT ?
    `).all(
      opts.sender,
      opts.afterRowid ?? 0,
      // Дата передаётся дважды: better-sqlite3 не разрешает смешивать
      // нумерованные и позиционные параметры в одном запросе.
      opts.sinceDate ?? null,
      opts.sinceDate ?? null,
      opts.limit ?? 500,
    ) as { rowid: number; text: string | null; blob: Buffer | null; local_time: string }[];

    const out: RawSms[] = [];
    for (const r of rows) {
      const text = r.text ?? extractAttributedText(r.blob);
      if (!text) continue;
      out.push({
        rowid: r.rowid,
        localTime: r.local_time,
        date: r.local_time.slice(0, 10),
        text,
      });
    }
    return out;
  } finally {
    db.close();
  }
}

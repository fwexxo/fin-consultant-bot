import type { Api } from 'grammy';

/** Ограничение Anthropic на изображение в запросе. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface ImageAttachment {
  base64: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
}

/**
 * Скачивает файл из Телеграма по file_id.
 *
 * Токен подставляется в URL, потому что этого требует протокол Telegram,
 * но сам URL никуда не логируется и не показывается пользователю.
 */
export async function downloadTelegramFile(
  api: Api,
  token: string,
  fileId: string,
): Promise<Buffer> {
  const file = await api.getFile(fileId);
  if (!file.file_path) {
    throw new Error('Телеграм не отдал путь к файлу');
  }

  const res = await fetch(
    `https://api.telegram.org/file/bot${token}/${file.file_path}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!res.ok) {
    throw new Error(`Не удалось скачать файл: HTTP ${res.status}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

export function toImageAttachment(buf: Buffer): ImageAttachment {
  if (buf.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(
      `Картинка ${(buf.byteLength / 1048576).toFixed(1)} МБ — больше допустимых 5 МБ`,
    );
  }
  // Телеграм всегда пережимает фото в JPEG, независимо от исходного формата.
  return { base64: buf.toString('base64'), mediaType: 'image/jpeg' };
}

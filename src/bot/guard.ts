/**
 * Единственная проверка доступа к боту.
 *
 * Сравнение строго числовое: username в Telegram можно сменить или
 * передать другому человеку, а числовой id закреплён за аккаунтом
 * навсегда. Нестрогое сравнение пропустило бы строку '123' за id 123.
 */
export function isOwner(ownerId: number | null, fromId: number | undefined): boolean {
  return typeof ownerId === 'number'
    && ownerId > 0
    && typeof fromId === 'number'
    && fromId === ownerId;
}

import { createHash, randomInt, randomUUID } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER_DIGITS = 'abcdefghijklmnopqrstuvwxyz0123456789';

const pick = (chars: string, n: number) =>
  Array.from({ length: n }, () => chars[randomInt(chars.length)]).join('');

/** 长连接 URL 的 access_key：md5 十六进制。 */
export const accessKey = (s: string): string => createHash('md5').update(s).digest('hex');
export const requestId = (): string => pick(LOWER_DIGITS, 10);
export const longRequestId = (): string => randomUUID();
export const requestCid = (): string => pick(ALPHABET, 10);

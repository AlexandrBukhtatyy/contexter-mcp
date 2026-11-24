/**
 * Приближённый счётчик токенов. Точного токенизатора модели у сервера нет, а бюджету
 * хватает точности около 10% (план, раздел «Стек»). Коэффициенты подобраны с запасом
 * в сторону завышения, особенно для кириллицы: оценка «4 символа на токен», привычная
 * для английского, занижает русский текст примерно в полтора раза.
 */
const CHARS_PER_TOKEN_CYRILLIC = 2.6;
const CHARS_PER_TOKEN_LATIN = 4;
const CHARS_PER_TOKEN_DIGITS = 3;

const TOKEN_RE = /(\p{Script=Cyrillic}+)|([A-Za-z]+)|(\d+)|(\s+)|(([^\s\p{L}\d])\6*)|(\p{L}+)/gu;

/** Обрезает текст до maxTokens по оценке countTokens (по границе строки или слова), добавляя «…». */
export function truncateToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  if (countTokens(text) <= maxTokens) return { text, truncated: false };
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (countTokens(text.slice(0, mid)) + 1 <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  let cut = text.slice(0, lo);
  const nl = cut.lastIndexOf("\n");
  const sp = cut.lastIndexOf(" ");
  const boundary = nl > lo * 0.6 ? nl : sp > lo * 0.6 ? sp : lo;
  cut = cut.slice(0, boundary).trimEnd();
  return { text: `${cut}…`, truncated: true };
}

export function countTokens(text: string): number {
  let total = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    if (m[1]) total += Math.ceil(m[1].length / CHARS_PER_TOKEN_CYRILLIC);
    else if (m[2]) total += Math.ceil(m[2].length / CHARS_PER_TOKEN_LATIN);
    else if (m[3]) total += Math.ceil(m[3].length / CHARS_PER_TOKEN_DIGITS);
    else if (m[4]) total += m[4].includes("\n") ? 1 : m[4].length > 8 ? Math.ceil(m[4].length / 16) : 0;
    else if (m[5]) total += m[5].length === 1 ? 1 : Math.ceil(m[5].length / 4);
    else if (m[7]) total += Math.ceil(m[7].length / 2);
  }
  return total;
}

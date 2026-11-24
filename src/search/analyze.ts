import snowball from "snowball-stemmers";

/**
 * Подготовка текста к поиску по словам. Встроенные токенизаторы FTS5 не знают морфологии,
 * поэтому сервер сам приводит слова к основам (Snowball для русского и английского)
 * и кладёт в полнотекстовый индекс уже основы. Запрос проходит ту же обработку.
 *
 * Идентификаторы дают и целое слово, и части: `openForm` → `openform open form`,
 * `parseGSMFrame` → `parsegsmframe pars gsm frame`, `device-command` → `devicecommand devic command`.
 */
const ru = snowball.newStemmer("russian");
const en = snowball.newStemmer("english");

const STOP_RU = new Set(
  (
    "и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему " +
    "теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где " +
    "есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем " +
    "ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше " +
    "тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более " +
    "всегда конечно всю между это эта также либо"
  ).split(" "),
);
const STOP_EN = new Set(
  (
    "a an the and or but if then else of to in on at by for with from as is are was were be been being it its this that these those " +
    "there here which who whom what when where why how not no nor so than too very can will just do does did has have had i you he she " +
    "we they them his her our your their into over under about after before up down out off again further once all any both each few more " +
    "most other some such only own same should would could may might must shall"
  ).split(" "),
);

const RAW_TOKEN_RE = /[\p{L}\p{N}]+(?:[_\-.][\p{L}\p{N}]+)*/gu;
const CAMEL_RE = /\p{Lu}+(?!\p{Ll})|\p{Lu}?\p{Ll}+|\p{N}+|\p{L}+/gu;
const CYRILLIC_RE = /\p{Script=Cyrillic}/u;
const LATIN_RE = /^[a-z]+$/;

function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/ё/g, "е");
}

export function stemWord(word: string): string {
  const w = normalizeWord(word);
  if (CYRILLIC_RE.test(w)) return ru.stem(w);
  if (LATIN_RE.test(w)) return en.stem(w);
  return w;
}

function isStopWord(word: string): boolean {
  return STOP_RU.has(word) || STOP_EN.has(word);
}

/** Части идентификатора в нижнем регистре: `parseGSMFrame` → parse, gsm, frame. */
export function splitIdentifier(token: string): string[] {
  const parts: string[] = [];
  for (const piece of token.split(/[_\-./]+/)) {
    for (const m of piece.matchAll(CAMEL_RE)) parts.push(normalizeWord(m[0]));
  }
  return parts.filter(Boolean);
}

/** Термы для одного «сырого» токена текста. */
function termsOf(raw: string): string[] {
  const parts = splitIdentifier(raw);
  if (parts.length === 0) return [];
  if (parts.length === 1) {
    const w = parts[0] as string;
    if (isStopWord(w)) return [];
    return [stemWord(w)];
  }
  const out = [parts.join("")];
  for (const p of parts) out.push(stemWord(p));
  return out;
}

/** Текст для колонки полнотекстового индекса: термы через пробел. */
export function analyzeForIndex(text: string): string {
  const out: string[] = [];
  for (const m of text.matchAll(RAW_TOKEN_RE)) out.push(...termsOf(m[0]));
  return out.join(" ");
}

/** Список уникальных термов запроса в порядке появления. */
export function analyzeQuery(query: string): string[] {
  const seen = new Set<string>();
  for (const m of query.matchAll(RAW_TOKEN_RE)) {
    for (const t of termsOf(m[0])) if (t.length > 0) seen.add(t);
  }
  return [...seen];
}

/** Запрос FTS5: термы через OR, каждый в кавычках. Ранжирование делает bm25. */
export function toFtsQuery(query: string): string | null {
  const terms = analyzeQuery(query);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

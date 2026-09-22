const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'yo',
  ж: 'j',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'x',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ы: 'i',
  э: 'e',
  ю: 'yu',
  я: 'ya',
  ғ: "g'",
  қ: 'q',
  ҳ: 'h',
  ў: "o'",
  ъ: '',
  ь: '',
};

const LATIN_TO_CYRILLIC: Record<string, string> = {
  a: 'а',
  b: 'б',
  v: 'в',
  g: 'г',
  d: 'д',
  e: 'е',
  j: 'ж',
  z: 'з',
  i: 'и',
  y: 'й',
  k: 'к',
  l: 'л',
  m: 'м',
  n: 'н',
  o: 'о',
  p: 'п',
  r: 'р',
  s: 'с',
  t: 'т',
  u: 'у',
  f: 'ф',
  x: 'х',
  q: 'қ',
  h: 'ҳ',
  c: 'ц',
};

const CYRILLIC_RE = /[а-яёғқҳў]/i;
const APOSTROPHE_RE = /[‘’ʼʻ`´]/g;

export function normalizeUzbekSearchText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(APOSTROPHE_RE, "'")
    .replace(/\s+/g, ' ');
}

export function cyrillicToLatin(value: string): string {
  return Array.from(normalizeUzbekSearchText(value))
    .map((char) => CYRILLIC_TO_LATIN[char] ?? char)
    .join('');
}

export function latinToCyrillic(value: string): string {
  let normalized = normalizeUzbekSearchText(value)
    .replace(/g'/g, 'ғ')
    .replace(/o'/g, 'ў')
    .replace(/shch/g, 'щ')
    .replace(/yo/g, 'ё')
    .replace(/yu/g, 'ю')
    .replace(/ya/g, 'я')
    .replace(/ch/g, 'ч')
    .replace(/sh/g, 'ш')
    .replace(/ts/g, 'ц');

  normalized = Array.from(normalized)
    .map((char) => LATIN_TO_CYRILLIC[char] ?? char)
    .join('');

  return normalized;
}

/**
 * Bir qidiruv matnidan bazada uchrashi mumkin bo'lgan lotin/kirill
 * variantlarini hosil qiladi. Apostrofsiz variant eski importlarda `O'rinov`
 * `Orinov` bo'lib qolgan holatni ham qoplaydi.
 */
export function buildUzbekSearchVariants(value: string): string[] {
  const normalized = normalizeUzbekSearchText(value);
  if (!normalized) return [];

  const transliterated = CYRILLIC_RE.test(normalized)
    ? cyrillicToLatin(normalized)
    : latinToCyrillic(normalized);

  return Array.from(
    new Set(
      [
        normalized,
        transliterated,
        normalized.replace(/'/g, ''),
        transliterated.replace(/'/g, ''),
      ].filter(Boolean),
    ),
  );
}

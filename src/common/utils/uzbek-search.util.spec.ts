import {
  buildUzbekSearchVariants,
  cyrillicToLatin,
  latinToCyrillic,
} from './uzbek-search.util';

describe('Uzbek search transliteration', () => {
  it('converts Uzbek Cyrillic names to Latin', () => {
    expect(cyrillicToLatin('Қодирова Ғўзал')).toBe("qodirova g'o'zal");
  });

  it('converts Latin names with different apostrophes to Cyrillic', () => {
    expect(latinToCyrillic('O‘rinova G‘ulbahor')).toBe('ўринова ғулбаҳор');
  });

  it('returns both scripts for a Latin query', () => {
    expect(buildUzbekSearchVariants('Qodirova')).toEqual(
      expect.arrayContaining(['qodirova', 'қодирова']),
    );
  });

  it('returns stored-name variants with and without apostrophes', () => {
    expect(buildUzbekSearchVariants('Ўринова')).toEqual(
      expect.arrayContaining(["o'rinova", 'orinova']),
    );
  });
});

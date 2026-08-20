const {
  validateLocales, filterLocales, needsLocaleWalk, languageNames,
} = require('../extension/lib/locales');

const TABLE = [
  { internal: 'en', cws: 'en', amo: 'en-US', name: 'English', altNames: ['English (United States)'] },
  { internal: 'fr', cws: 'fr', amo: 'fr', name: 'French' },
  { internal: 'he', cws: 'iw', amo: 'he', name: 'Hebrew' },
  { internal: 'zh_CN', cws: 'zh-CN', amo: 'zh-CN', name: 'Chinese (China)' },
];

describe('validateLocales', () => {
  test('accepts a well-formed table', () => {
    expect(validateLocales(TABLE)).toBe(TABLE);
  });

  test('rejects an empty or absent table', () => {
    expect(() => validateLocales([])).toThrow(/non-empty array/);
    expect(() => validateLocales(undefined)).toThrow(/non-empty array/);
  });

  test('rejects a row missing a required field', () => {
    expect(() => validateLocales([{ internal: 'fr', cws: 'fr' }])).toThrow(/missing "name"/);
    expect(() => validateLocales([{ cws: 'fr', name: 'French' }])).toThrow(/missing "internal"/);
  });

  // Duplicates are the quiet failure: the run walks the same language twice and
  // the second pass overwrites the first with another locale's text.
  test('rejects duplicate internal or store codes', () => {
    expect(() => validateLocales([TABLE[1], TABLE[1]])).toThrow(/Duplicate internal locale: fr/);
    expect(() => validateLocales([
      { internal: 'nb', cws: 'no', amo: null, name: 'Norwegian' },
      { internal: 'no', cws: 'no', amo: null, name: 'Norwegian again' },
    ])).toThrow(/Duplicate CWS locale: no/);
  });
});

describe('filterLocales', () => {
  test('empty filter returns every locale', () => {
    expect(filterLocales(TABLE, '')).toHaveLength(TABLE.length);
    expect(filterLocales(TABLE, undefined)).toHaveLength(TABLE.length);
  });

  test('comma list returns the named locales in the order given', () => {
    expect(filterLocales(TABLE, 'fr, EN').map(l => l.internal)).toEqual(['fr', 'en']);
  });

  test('from:xx resumes an aborted run at xx', () => {
    expect(filterLocales(TABLE, 'from:he').map(l => l.internal)).toEqual(['he', 'zh_CN']);
  });

  test('unknown locales throw rather than being silently dropped', () => {
    expect(() => filterLocales(TABLE, 'xx')).toThrow(/Unknown locale/);
    expect(() => filterLocales(TABLE, 'from:xx')).toThrow(/Unknown locale/);
  });
});

// The international screenshots live in the language-independent "Global assets"
// card. A run that only replaces them must not walk the languages: besides the
// wasted minutes, one unconfirmed language switch aborts the run before the
// global step it was asked to perform.
describe('needsLocaleWalk', () => {
  test('true when a per-language step is selected', () => {
    expect(needsLocaleWalk({ updateTexts: true })).toBe(true);
    expect(needsLocaleWalk({ updateImages: true })).toBe(true);
    expect(needsLocaleWalk({ updateTexts: true, updateGlobalImages: true })).toBe(true);
  });

  test('false for international screenshots alone', () => {
    expect(needsLocaleWalk({ updateGlobalImages: true })).toBe(false);
  });

  test('false when nothing is selected', () => {
    expect(needsLocaleWalk({})).toBe(false);
    expect(needsLocaleWalk(undefined)).toBe(false);
  });
});

describe('languageNames', () => {
  test('the console label first, then any alternates', () => {
    expect(languageNames(TABLE[0])).toEqual(['English', 'English (United States)']);
    expect(languageNames(TABLE[1])).toEqual(['French']);
  });
});

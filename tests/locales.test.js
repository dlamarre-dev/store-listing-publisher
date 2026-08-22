const {
  validateLocales, filterLocales, needsLocaleWalk, languageNames, missingLocales,
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

// Some stores require a locale to exist before it can be written: Partner Center
// lists only the languages you have added, even though the uploaded package makes
// all of them available. This decides what is missing — and getting it wrong in
// either direction is quiet. Too many, and it tries to add languages that are
// already there; too few, and it writes into a page that does not exist.
describe('missingLocales', () => {
  const ALIASED = [
    { internal: 'bn', cws: 'bn', amo: null, name: 'Bengali', altNames: ['Bangla'] },
    { internal: 'sw', cws: 'sw', amo: null, name: 'Swahili', altNames: ['Kiswahili'] },
    { internal: 'nb', cws: 'no', amo: 'nb-NO', name: 'Norwegian',
      altNames: ['Norwegian Bokmål', 'Norwegian (Bokmål)'] },
  ];

  test('an empty listing means every locale is missing', () => {
    expect(missingLocales(TABLE, []).map(l => l.internal))
      .toEqual(TABLE.map(l => l.internal));
    expect(missingLocales(TABLE, null)).toHaveLength(TABLE.length);
  });

  test('a locale present under our own name is not missing', () => {
    expect(missingLocales(TABLE, ['English', 'French']).map(l => l.internal))
      .toEqual(['he', 'zh_CN']);
  });

  // The case the whole aliasing exists for. Partner Center writes Bangla and
  // Kiswahili; matching on `name` alone would report both as missing and add
  // them a second time.
  test('a locale present under the store\'s own spelling is not missing', () => {
    expect(missingLocales(ALIASED, ['Bangla', 'Kiswahili', 'Norwegian (Bokmål)']))
      .toEqual([]);
  });

  test('one alias is enough, the others need not match', () => {
    expect(missingLocales(ALIASED, ['Norwegian Bokmål']).map(l => l.internal))
      .toEqual(['bn', 'sw']);
  });

  // Labels come out of a table cell, so they arrive with whatever spacing and
  // casing the page had.
  test('spacing and casing in the reported labels do not matter', () => {
    expect(missingLocales(TABLE, ['  english  ', 'FRENCH']).map(l => l.internal))
      .toEqual(['he', 'zh_CN']);
  });

  test('empty and null labels are ignored rather than matching something', () => {
    expect(missingLocales(TABLE, ['', null, undefined, 'English']).map(l => l.internal))
      .toEqual(['fr', 'he', 'zh_CN']);
  });

  // A store offering languages we do not ship is normal and must not confuse it.
  test('extra languages on the listing are not our problem', () => {
    expect(missingLocales(TABLE, ['English', 'French', 'Hebrew', 'Chinese (China)',
                                  'Klingon', 'Welsh'])).toEqual([]);
  });

  test('it returns the locale objects, not just their codes', () => {
    const [first] = missingLocales(TABLE, ['English', 'French', 'Hebrew']);
    expect(first).toMatchObject({ internal: 'zh_CN', name: 'Chinese (China)' });
  });
});

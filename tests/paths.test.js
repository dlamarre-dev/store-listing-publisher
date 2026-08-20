const fs = require('fs');
const path = require('path');
const {
  localeVars, resolveTemplate, joinPath,
  descriptionPath, screenshotPath, baseName,
} = require('../extension/lib/paths');

const EN = { internal: 'en', cws: 'en', amo: 'en-US', name: 'English' };
const ZH = { internal: 'zh_CN', cws: 'zh-CN', amo: 'zh-CN', name: 'Chinese (China)', fileCode: 'CN' };
const HE = { internal: 'he', cws: 'iw', amo: 'he', name: 'Hebrew' };
const AR = { internal: 'ar', cws: 'ar', amo: null, name: 'Arabic' };

describe('localeVars', () => {
  test('exposes the internal, store and file codes', () => {
    expect(localeVars(HE)).toEqual({ lang: 'he', LANG: 'HE', cwsLang: 'iw', amoLang: 'he' });
  });

  test('{LANG} follows fileCode when a project names files their own way', () => {
    expect(localeVars(ZH).LANG).toBe('CN');
    expect(localeVars(ZH).lang).toBe('zh_CN');
  });

  test('a locale absent from AMO gets an empty amoLang, not null', () => {
    expect(localeVars(AR).amoLang).toBe('');
  });
});

describe('resolveTemplate', () => {
  test('substitutes every placeholder', () => {
    expect(resolveTemplate('{slug}/{lang}/{n}.png', { slug: 'app', lang: 'fr', n: 3 }))
      .toBe('app/fr/3.png');
  });

  // A template that forgot {lang} would read one file for all 43 locales and
  // publish the same text everywhere — worth failing loudly over.
  test('an unknown placeholder throws instead of being left in place', () => {
    expect(() => resolveTemplate('{slug}/{locale}.txt', { slug: 'app' }))
      .toThrow(/Unknown placeholder \{locale\}/);
  });

  test('a missing template throws', () => {
    expect(() => resolveTemplate(undefined, {})).toThrow(/missing or not a string/);
    expect(() => resolveTemplate('', {})).toThrow(/missing or not a string/);
  });
});

describe('joinPath', () => {
  test('keeps the separator the root already uses', () => {
    expect(joinPath('E:\\proj', 'dist/app/x.png')).toBe('E:\\proj\\dist\\app\\x.png');
    expect(joinPath('/srv/assets', 'app/en/1.png')).toBe('/srv/assets/app/en/1.png');
  });

  test('tolerates a trailing separator on the root', () => {
    expect(joinPath('/srv/assets/', 'a/b')).toBe('/srv/assets/a/b');
    expect(joinPath('E:\\proj\\', 'a/b')).toBe('E:\\proj\\a\\b');
  });
});

describe('the two shipped layouts resolve as documented', () => {
  const load = name => JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'examples', name), 'utf8'));

  test('per-language directories (the default): locale in the path, not the name', () => {
    const cfg = load('per-language-dirs.config.json');
    const item = cfg.items[0];
    const p = cfg.assets.chrome;
    expect(descriptionPath('/srv/marketing', p, item, EN))
      .toBe('/srv/marketing/my-extension/en/description.txt');
    expect(screenshotPath('/srv/marketing', p, item, ZH, 4))
      .toBe('/srv/marketing/my-extension/zh_CN/4.png');
  });

  test('flat layout: locale in the filename, fileCode honoured', () => {
    const cfg = load('flat-layout.config.json');
    const item = cfg.items.find(i => i.slug === 'ai-folders');
    const p = cfg.assets.chrome;
    const root = 'E:\\AI-GeminiFolders';
    expect(descriptionPath(root, p, item, EN))
      .toBe('E:\\AI-GeminiFolders\\dist\\ai-folders\\marketing_chrome\\PromoEN.txt');
    // The historical quirk this exists for: zh_CN's text file is PromoCN.txt,
    // while its screenshots still carry the full internal code.
    expect(descriptionPath(root, p, item, ZH))
      .toBe('E:\\AI-GeminiFolders\\dist\\ai-folders\\marketing_chrome\\PromoCN.txt');
    expect(screenshotPath(root, p, item, ZH, 5))
      .toBe('E:\\AI-GeminiFolders\\dist\\ai-folders\\marketing_chrome\\screenshots\\Promo_5_zh_CN.png');
  });
});

describe('baseName', () => {
  test('handles both separators', () => {
    expect(baseName('E:\\a\\b\\Promo_1_en.png')).toBe('Promo_1_en.png');
    expect(baseName('/srv/a/b/1.png')).toBe('1.png');
  });
});

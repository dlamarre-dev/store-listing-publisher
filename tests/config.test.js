const fs = require('fs');
const path = require('path');
const {
  mergeConfig, validateConfig, resolveExtendsPath, isAbsolutePath,
  screenshotsPerListing,
} = require('../extension/lib/config');
const { validateLocales } = require('../extension/lib/locales');

const EXAMPLES = path.join(__dirname, '..', 'examples');
const loadExample = name => JSON.parse(fs.readFileSync(path.join(EXAMPLES, name), 'utf8'));

describe('mergeConfig', () => {
  test('the local layer wins on every key it declares', () => {
    expect(mergeConfig({ a: 1, b: 2 }, { b: 3 })).toEqual({ a: 1, b: 3 });
  });

  // The whole point of the two layers: the project commits amo.previewSet, the
  // operator's gitignored file adds amo.jwt_secret. A flat merge would wipe one.
  test('objects merge a level at a time', () => {
    const merged = mergeConfig(
      { amo: { previewSet: 'en-only', summarySource: { key: 'extDesc' } } },
      { amo: { jwt_secret: 's3cret' } },
    );
    expect(merged.amo).toEqual({
      previewSet: 'en-only',
      summarySource: { key: 'extDesc' },
      jwt_secret: 's3cret',
    });
  });

  // A half-overridden locale table would be worse than either version.
  test('arrays replace wholesale', () => {
    expect(mergeConfig({ locales: [1, 2, 3] }, { locales: [9] })).toEqual({ locales: [9] });
  });
});

describe('isAbsolutePath', () => {
  test('accepts POSIX roots and Windows drive letters', () => {
    expect(isAbsolutePath('/srv/assets')).toBe(true);
    expect(isAbsolutePath('E:\\proj')).toBe(true);
    expect(isAbsolutePath('E:/proj')).toBe(true);
  });

  test('rejects relative paths', () => {
    expect(isAbsolutePath('./config.json')).toBe(false);
    expect(isAbsolutePath('proj/config.json')).toBe(false);
  });
});

describe('resolveExtendsPath', () => {
  test('an absolute extends is taken as it stands', () => {
    expect(resolveExtendsPath('/etc/app.json', '/home/me/config.json')).toBe('/etc/app.json');
  });

  test('a relative extends resolves against the file that declared it', () => {
    expect(resolveExtendsPath('./project.json', '/home/me/config.json'))
      .toBe('/home/me/project.json');
    expect(resolveExtendsPath('project.json', 'E:\\tool\\config.json'))
      .toBe('E:\\tool\\project.json');
  });
});

describe('validateConfig', () => {
  const valid = () => ({
    items: [{ slug: 'app', name: 'App' }],
    assets: { root: '/srv/assets', chrome: { description: 'a.txt', screenshot: 'b.png' } },
  });

  test('accepts a minimal valid config', () => {
    expect(() => validateConfig(valid())).not.toThrow();
  });

  // This used to be inferred from where the tool sat on disk. It no longer lives
  // inside the project it publishes, so there is nothing to infer.
  test('assets.root is required and must be absolute', () => {
    const noRoot = valid();
    delete noRoot.assets.root;
    expect(() => validateConfig(noRoot)).toThrow(/assets\.root: required/);

    const relative = valid();
    relative.assets.root = './dist';
    expect(() => validateConfig(relative)).toThrow(/must be absolute/);
  });

  test('at least one store profile must carry templates', () => {
    const bare = valid();
    delete bare.assets.chrome;
    expect(() => validateConfig(bare)).toThrow(/declare at least one of chrome, firefox/);

    const empty = valid();
    empty.assets.chrome = {};
    expect(() => validateConfig(empty)).toThrow(/needs a description and\/or screenshot template/);
  });

  test('items must be a non-empty array of named slugs', () => {
    const none = valid();
    none.items = [];
    expect(() => validateConfig(none)).toThrow(/items: must be a non-empty array/);

    const unnamed = valid();
    unnamed.items = [{ slug: 'app' }];
    expect(() => validateConfig(unnamed)).toThrow(/items\[0\]\.name: required/);
  });

  test('screenshotsPerListing must be a positive integer when given', () => {
    const bad = valid();
    bad.assets.chrome.screenshotsPerListing = 0;
    expect(() => validateConfig(bad)).toThrow(/positive integer/);
  });

  test('every problem is reported at once, not one per run', () => {
    let message = '';
    try {
      validateConfig({ items: [], assets: {} });
    } catch (e) {
      message = e.message;
    }
    expect(message).toMatch(/items: must be a non-empty array/);
    expect(message).toMatch(/assets\.root: required/);
  });
});

describe('screenshotsPerListing', () => {
  test('defaults to five, the store maximum both CWS and AMO accept', () => {
    expect(screenshotsPerListing({})).toBe(5);
    expect(screenshotsPerListing({ screenshotsPerListing: 3 })).toBe(3);
  });
});

// The examples are documentation people copy. If one of them no longer validates,
// the README is lying.
describe('the shipped examples are valid configurations', () => {
  for (const name of fs.readdirSync(EXAMPLES)) {
    test(name, () => {
      const cfg = loadExample(name);
      expect(() => validateConfig(cfg)).not.toThrow();
      expect(() => validateLocales(cfg.locales)).not.toThrow();
    });
  }
});

// Which locales a run is allowed to walk.
//
// enrolLocales does two things: it adds the languages a store requires before they
// can be written, and it decides which locales actually have a page afterwards.
// The second is the part that broke — it used to return nothing, so the caller
// walked its original list and aborted on the first locale that did not exist.
// That happened in two situations, and both were reachable:
//
//   - a dry run adds nothing, so nothing new has a page, so the dry run died on
//     its first locale — on exactly the fresh listing it was meant to preview.
//   - a language the store does not offer is skipped while adding, and then walked
//     anyway, failing after every other language had already been written.
//
// So this runs the real function rather than reading its source. background.js is
// a background script with no exports, so it is evaluated in a vm with stubs; a
// setTimeout that fires immediately keeps the page-settle sleeps from making the
// suite take a minute.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = ['lib/config.js', 'lib/locales.js', 'lib/paths.js',
                 'stores/cws.js', 'stores/edge.js', 'background.js'];

const LOCALES = [
  { internal: 'en', cws: 'en', amo: 'en-US', name: 'English' },
  { internal: 'fr', cws: 'fr', amo: 'fr', name: 'French' },
  { internal: 'tl', cws: 'fil', amo: null, name: 'Filipino' },
];

function load() {
  const progress = [];
  const calls = { addLanguage: [], tabUpdates: [] };

  const sandbox = {
    console,
    // Fires immediately: the real function sleeps 6s per page settle, and a
    // faithful clock would make this suite slower than the thing it tests.
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout: () => {},
    chrome: {
      runtime: { onMessage: { addListener: () => {} }, lastError: null },
      // get serves both callers: background.js reconciles run_state with a
      // callback, and the Edge driver awaits its learned latency.
      storage: { local: {
        set: () => {},
        get: (_keys, cb) => { if (cb) { cb({}); return undefined; } return Promise.resolve({}); },
      } },
      tabs: {
        onUpdated: { addListener: () => {}, removeListener: () => {} },
        get: (id, cb) => cb({ id, status: 'complete', url: 'https://x/' }),
        update: async (id, info) => { calls.tabUpdates.push(info.url); },
        create: async () => ({ id: 1 }),
        query: async () => [],
      },
      scripting: { executeScript: async () => [{ result: null }] },
    },
    getComputedStyle: () => ({}),
    document: { querySelectorAll: () => [] },
    location: { href: '' },
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
  };

  const sources = SCRIPTS.map(
    (f) => fs.readFileSync(path.join(ROOT, 'extension', f), 'utf8'));
  sources.push('globalThis.__api = { enrolLocales };');
  vm.runInContext(sources.join('\n;\n'), vm.createContext(sandbox),
                  { filename: 'extension/*.js' });

  return { enrolLocales: sandbox.__api.enrolLocales, progress, calls };
}

// A driver that reports `present` as already on the listing and refuses anything
// in `notOffered`, the way Partner Center refuses Filipino.
function fakeDriver({ present = ['English'], notOffered = [], calls }) {
  return {
    addLanguage: async (tabId, locale) => {
      calls.addLanguage.push(locale.internal);
      if (notOffered.includes(locale.internal)) {
        return { ok: false, step: 'language-not-offered', wanted: [locale.name] };
      }
      return { ok: true, added: locale.name };
    },
    listLanguages: async () => ({
      ok: true, languages: present.map((language) => ({ language, status: 'Complete' })),
    }),
  };
}

const run = (opts, driverOpts = {}) => {
  const { enrolLocales, progress, calls } = load();
  const driver = fakeDriver({ ...driverOpts, calls });
  return enrolLocales(driver, 1, LOCALES, 'https://listings', opts,
                      (line) => progress.push(line))
    .then((walkable) => ({ walkable, progress, calls }));
};

describe('a store with no enrolment concept', () => {
  test('gets its list back untouched and nothing is called', async () => {
    const { enrolLocales, progress } = load();
    const walkable = await enrolLocales(
      { /* no addLanguage */ }, 1, LOCALES, 'https://listings', {},
      (l) => progress.push(l));
    expect(walkable).toBe(LOCALES);
    expect(progress).toEqual([]);
  });
});

describe('a dry run', () => {
  test('adds nothing', async () => {
    const { calls } = await run({ dryRun: true });
    expect(calls.addLanguage).toEqual([]);
  });

  // The bug. It returned nothing, the caller walked all three, and the run died
  // on French — the first locale without a page.
  test('returns only the locales that already have a page', async () => {
    const { walkable } = await run({ dryRun: true });
    expect(walkable.map((l) => l.internal)).toEqual(['en']);
  });

  test('and says why the others are not inspected', async () => {
    const { progress } = await run({ dryRun: true });
    expect(progress.join('\n')).toMatch(/Would add 2: fr, tl/);
    expect(progress.join('\n')).toMatch(/Dry run adds nothing/);
  });
});

describe('a real run', () => {
  test('adds only what is missing', async () => {
    const { calls } = await run({});
    expect(calls.addLanguage).toEqual(['fr', 'tl']);
  });

  test('returns everything when the store accepted them all', async () => {
    const { walkable } = await run({});
    expect(walkable.map((l) => l.internal)).toEqual(['en', 'fr', 'tl']);
  });

  // The second half of the bug, and the more expensive one: this failure landed
  // after every other language had already been written.
  test('drops a language the store refused, instead of walking it', async () => {
    const { walkable, progress } = await run({}, { notOffered: ['tl'] });
    expect(walkable.map((l) => l.internal)).toEqual(['en', 'fr']);
    expect(progress.join('\n')).toMatch(/NOT OFFERED/);
    expect(progress.join('\n')).toMatch(/1 not offered: tl/);
  });

  test('a refusal does not stop the languages after it', async () => {
    const { calls } = await run({}, { notOffered: ['fr'] });
    expect(calls.addLanguage).toEqual(['fr', 'tl']);
  });

  // Adding navigates to the new language's page, so the listings page has to be
  // reopened between each one — and once more at the end, so the walk starts
  // where it expects to.
  test('returns to the listings page between adds and at the end', async () => {
    const { calls } = await run({});
    expect(calls.tabUpdates).toEqual([
      'https://listings', 'https://listings', 'https://listings',
    ]);
  });

  test('nothing to add means nothing is touched', async () => {
    const { walkable, calls, progress } = await run(
      {}, { present: ['English', 'French', 'Filipino'] });
    expect(calls.addLanguage).toEqual([]);
    expect(calls.tabUpdates).toEqual([]);
    expect(walkable).toBe(LOCALES);
    expect(progress.join('\n')).toMatch(/Nothing to add/);
  });

  test('a locale already present under an alias is not added again', async () => {
    const { enrolLocales, progress, calls } = load();
    const aliased = [{ internal: 'nb', cws: 'no', amo: 'nb-NO', name: 'Norwegian',
                       altNames: ['Norwegian (Bokmål)'] }];
    const driver = fakeDriver({ present: ['Norwegian (Bokmål)'], calls });
    const walkable = await enrolLocales(driver, 1, aliased, 'https://listings', {},
                                        (l) => progress.push(l));
    expect(calls.addLanguage).toEqual([]);
    expect(walkable).toBe(aliased);
  });
});

describe('failures that are not "not offered"', () => {
  test('stop the run', async () => {
    const { enrolLocales, progress, calls } = load();
    const driver = {
      listLanguages: async () => ({ ok: true, languages: [{ language: 'English' }] }),
      addLanguage: async () => ({ ok: false, step: 'no-add-language-control' }),
    };
    await expect(enrolLocales(driver, 1, LOCALES, 'https://listings', {},
                              (l) => progress.push(l)))
      .rejects.toThrow(/Could not add/);
    expect(calls.addLanguage).toEqual([]);
  });

  test('so does a listing whose languages cannot be read', async () => {
    const { enrolLocales, progress } = load();
    const driver = {
      addLanguage: async () => ({ ok: true }),
      listLanguages: async () => ({ ok: false, step: 'boom' }),
    };
    await expect(enrolLocales(driver, 1, LOCALES, 'https://listings', {},
                              (l) => progress.push(l)))
      .rejects.toThrow(/Could not read which languages/);
  });
});

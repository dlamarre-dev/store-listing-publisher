// Checking that the slot holds what was sent, and repairing it when it does not.
//
// An upload can fail on the store's side after the thumbnail has already
// appeared, leaving an error tile in the list. The count is then right and the
// listing is wrong — so counting, which is all the upload loop does, cannot see
// it. And the page is saved immediately afterwards, which makes this the last
// moment the mistake is cheap.
//
// Identity comes from the filename. Partner Center labels each thumbnail with it
// ("Screenshot Promo_1_fr.png"), so what was sent and what is there are compared
// by name rather than by number. A driver that cannot report names is skipped
// rather than guessed at, and says so.
//
// background.js is a background script with no exports, so it runs in a vm with
// stubs; setTimeout fires immediately, since the waits are the driver's business
// and are covered by its own suite.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = ['lib/config.js', 'lib/locales.js', 'lib/paths.js',
                 'stores/cws.js', 'stores/edge.js', 'background.js'];

const LOCALE = { internal: 'fr', cws: 'fr', amo: 'fr', name: 'French' };
const CTX = {
  assetsRoot: '/assets',
  profile: { screenshot: '{slug}/shots/Promo_{n}_{lang}.png', screenshotsPerListing: 3 },
  item: { slug: 'gf' },
};
const NAMES = ['Promo_1_fr.png', 'Promo_2_fr.png', 'Promo_3_fr.png'];

// A store whose slot starts empty and reports its contents by filename.
//
// `lands` decides what an upload actually puts in the slot: it is given the name
// being uploaded and the attempt number, and returns the name that ends up there.
// Something always lands — an upload that puts nothing in the slot is caught by
// the upload loop's own count check, long before this pass, and is not what this
// one is for.
function fakeStore({ lands = (name) => name } = {}) {
  const slot = [];
  const calls = { uploaded: [], deleted: [] };
  return {
    slot,
    calls,
    driver: {
      id: 'edge',
      countScreenshots: async () => ({ ok: true, count: slot.length,
                                       files: slot.map((n) => `Screenshot ${n}`) }),
      uploadScreenshot: async (tabId, b64, name) => {
        calls.uploaded.push(name);
        slot.push(lands(name, calls.uploaded.length));
        return { ok: true, via: 1 };
      },
      deleteOneScreenshot: async (tabId, scope, only) => {
        const i = only ? slot.findIndex((n) => String(only).includes(n)) : 0;
        if (i === -1) return { ok: false, step: 'not-found', before: slot.length };
        calls.deleted.push(slot[i]);
        slot.splice(i, 1);
        return { ok: true, before: slot.length + 1, after: slot.length };
      },
    },
  };
}

function load() {
  const progress = [];
  const sandbox = {
    console,
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout: () => {},
    chrome: {
      runtime: { onMessage: { addListener: () => {} }, lastError: null },
      storage: { local: { set: () => {}, get: async () => ({}) } },
      tabs: { onUpdated: { addListener: () => {}, removeListener: () => {} },
              get: (id, cb) => cb({ id, status: 'complete', url: 'https://x/' }),
              update: async () => {}, create: async () => ({ id: 1 }), query: async () => [] },
      scripting: { executeScript: async () => [{ result: null }] },
    },
    getComputedStyle: () => ({}),
    document: { querySelectorAll: () => [] },
    location: { href: '' },
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
  };
  const sources = SCRIPTS.map((f) => fs.readFileSync(path.join(ROOT, 'extension', f), 'utf8'));
  sources.push('globalThis.__api = { replaceScreenshots };');
  vm.runInContext(sources.join('\n;\n'), vm.createContext(sandbox), { filename: 'extension/*.js' });

  // The native host is not what these tests are about; the bytes never reach the
  // fake store.
  sandbox.readFileNative = async () => 'AAAA';
  return { replaceScreenshots: sandbox.__api.replaceScreenshots, progress };
}

const run = (store) => {
  const { replaceScreenshots, progress } = load();
  return replaceScreenshots(store.driver, 1, CTX, LOCALE, 'localized',
                            (line) => progress.push(line))
    .then(() => progress, (e) => { e.progress = progress; throw e; });
};

describe('a clean run', () => {
  test('uploads each file once and says the slot was verified', async () => {
    const store = fakeStore();
    const progress = await run(store);
    expect(store.calls.uploaded).toEqual(NAMES);
    expect(store.slot).toEqual(NAMES);
    expect(progress.join('\n')).toMatch(/screenshots verified: 3\/3/);
  });

  test('and repairs nothing', async () => {
    const store = fakeStore();
    await run(store);
    expect(store.calls.deleted).toEqual([]);
  });
});

describe('an error tile', () => {
  // The failure that prompted this: as far as the count is concerned the upload
  // succeeded, and what landed is not the file that was sent. `n <= 3` corrupts
  // only the first pass, so the repair is allowed to work — a store that fails the
  // same file twice is the next describe.
  const store = () => fakeStore({
    lands: (name, n) => (name === NAMES[1] && n <= 3 ? 'upload-failed' : name),
  });

  test('is noticed, even though the count is right', async () => {
    const s = store();
    const progress = await run(s);
    expect(progress.join('\n')).toMatch(/1 missing, 1 unexpected/);
  });

  test('is removed by name, not by position', async () => {
    const s = store();
    await run(s);
    expect(s.calls.deleted).toEqual(['upload-failed']);
  });

  test('and only the file it displaced is sent again', async () => {
    const s = store();
    await run(s);
    // Four uploads for three screenshots: a repair costs one, not a whole slot —
    // which matters when every upload also costs the gap between uploads.
    expect(s.calls.uploaded).toEqual([...NAMES, NAMES[1]]);
    expect([...s.slot].sort()).toEqual([...NAMES].sort());
  });

  test('and the run ends verified rather than merely finished', async () => {
    const s = store();
    const progress = await run(s);
    expect(progress.join('\n')).toMatch(/screenshots verified: 3\/3/);
  });
});

describe('a slot that stays wrong', () => {
  test('fails rather than looping', async () => {
    const store = fakeStore({ lands: () => 'upload-failed' });
    await expect(run(store)).rejects.toThrow(/did not come out right/);
  });

  test('and the failure names what is there and what is missing', async () => {
    const store = fakeStore({
      lands: (name) => (name === NAMES[0] ? 'upload-failed' : name),
    });
    const err = await run(store).catch((e) => e);
    expect(err.detail.missing).toEqual([NAMES[0]]);
    expect(err.detail.extra).toEqual(['Screenshot upload-failed']);
  });

  test('and it happens before the page is saved, not after', async () => {
    // replaceScreenshots throwing is what keeps a wrong listing from being
    // committed: publishLocale saves only once it returns.
    const store = fakeStore({ lands: () => 'upload-failed' });
    const err = await run(store).catch((e) => e);
    expect(err.progress.join('\n')).not.toMatch(/verified/);
  });
});

describe('a store that cannot report filenames', () => {
  // The CWS driver counts thumbnails without naming them. Claiming a verification
  // that did not happen would be worse than not verifying at all.
  test('is not verified, and the log says so', async () => {
    const store = fakeStore();
    store.driver.countScreenshots = async () => ({
      ok: true, count: store.slot.length, files: store.slot.map(() => null),
    });
    const progress = await run(store);
    expect(progress.join('\n')).toMatch(/names unavailable/);
    expect(progress.join('\n')).not.toMatch(/screenshots verified/);
  });
});

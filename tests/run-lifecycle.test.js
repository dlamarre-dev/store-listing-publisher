// Starting, stopping and starting again — without reloading the add-on.
//
// The popup is destroyed every time it loses focus, and a run outlives it, so the
// two communicate through storage.local. That worked for the log and failed for
// the run state: `run_state: "running"` is written when a run starts and rewritten
// when it ends, and a run that never ends — the background page was torn down
// under it — leaves the word "running" behind forever. The popup believed it,
// greyed Run out, and the only way back was reloading the add-on. Which did not
// work either: storage.local survives that too.
//
// So liveness is answered from the background page's own memory (`currentRun`),
// storage is reconciled when the page is reborn, and a stop is a flag the run
// reads between locales rather than a kill. This suite drives the real message
// handler against a real runPublish, with only the browser stubbed out.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = ['lib/config.js', 'lib/locales.js', 'lib/paths.js',
                 'stores/cws.js', 'stores/edge.js', 'background.js'];

const LOCALES = [
  { internal: 'ar', cws: 'ar', amo: 'ar', name: 'Arabic' },
  { internal: 'de', cws: 'de', amo: 'de', name: 'German' },
  { internal: 'fr', cws: 'fr', amo: 'fr', name: 'French' },
];

const CONFIG = {
  publisher_id: 'PUB',
  locales: LOCALES,
  items: [{ slug: 'thing', name: 'Thing', id: 'ITEMID' }],
  assets: {
    root: '/assets',
    chrome: { description: '{slug}/{lang}.txt', screenshot: '{slug}/{lang}-{n}.png' },
    edge: { description: '{slug}/{lang}.txt', screenshot: '{slug}/{lang}-{n}.png' },
  },
  edge: { productIds: { thing: 'GUID' } },
};

const OPTS = {
  store: 'cws', itemSlug: 'thing', updateTexts: true,
  updateImages: false, updateGlobalImages: false, dryRun: false,
  localeFilter: '', probeOnly: false,
};

// A background page with the browser stubbed out.
//
// `onPage` is called with the name of every page function the run injects, which
// is both the trace the assertions read and the hook a test stops the run from:
// it is the only place that runs *inside* a locale.
// `seed` is what storage.local already held when this page came up — the whole
// point of the reconciliation is that storage outlives the page.
function load({ onPage = () => {}, failOn = null, seed = {} } = {}) {
  const store = { ...seed };
  const listeners = [];
  const injected = [];

  const sandbox = {
    console,
    // Immediate: the real run sleeps 6s per page settle and 1.2s per field.
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout: () => {},
    Date,
    JSON,
    Promise,
    Error,
    chrome: {
      runtime: {
        lastError: null,
        onMessage: { addListener: (fn) => listeners.push(fn) },
        // Every description read succeeds; the run never reaches a real file.
        connectNative: () => {
          const msgListeners = [];
          return {
            onMessage: { addListener: (fn) => msgListeners.push(fn) },
            onDisconnect: { addListener: () => {} },
            postMessage: () => msgListeners.forEach(
              (fn) => fn({ ok: true, content: 'description text' })),
            disconnect: () => {},
          };
        },
      },
      storage: {
        local: {
          set: (obj) => Object.assign(store, obj),
          get: (keys, cb) => {
            const out = {};
            for (const k of [].concat(keys)) if (k in store) out[k] = store[k];
            if (cb) { cb(out); return undefined; }
            return Promise.resolve(out);
          },
        },
      },
      tabs: {
        onUpdated: { addListener: () => {}, removeListener: () => {} },
        get: (id, cb) => (cb ? cb({ id, status: 'complete', url: 'https://x/' })
          : Promise.resolve({ id, status: 'complete', url: 'https://x/' })),
        update: async () => {},
        create: async () => ({ id: 7 }),
        query: async () => [],
      },
      scripting: {
        executeScript: async ({ func, args }) => {
          const name = func.name;
          injected.push(name);
          onPage(name, args);
          if (failOn && failOn === name) return [{ result: { ok: false, step: 'boom' } }];
          if (name === 'cwsPageSelectLanguage') {
            return [{ result: { ok: true, selected: args[0].names[0], confirmed: true } }];
          }
          if (name === 'cwsPageSetDescription') {
            return [{ result: { ok: true, step: 'done', label: 'Description', length: 5 } }];
          }
          return [{ result: { ok: true } }];
        },
      },
    },
    getComputedStyle: () => ({}),
    document: { querySelectorAll: () => [] },
    location: { href: '' },
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
  };

  const sources = SCRIPTS.map(
    (f) => fs.readFileSync(path.join(ROOT, 'extension', f), 'utf8'));
  vm.runInContext(sources.join('\n;\n'), vm.createContext(sandbox),
                  { filename: 'extension/*.js' });

  // The handler answers through sendResponse and keeps running afterwards, so the
  // reply and the run it started are two different waits.
  const send = (msg) => new Promise((resolve) => {
    let replied = false;
    for (const fn of listeners) {
      fn(msg, {}, (res) => { replied = true; resolve(res); });
    }
    if (!replied) resolve(undefined);
  });

  // The run is not awaitable from out here — it is a detached promise inside the
  // handler. It is finished when it has said so in storage.
  const settled = async () => {
    for (let i = 0; i < 2000; i += 1) {
      if (['done', 'error', 'stopped'].includes(store.run_state)) return store.run_state;
      await new Promise((r) => setImmediate(r));
    }
    throw new Error(`run never settled (state: ${store.run_state})`);
  };

  const log = () => (store.run_log || []).map((l) => l.text);

  return { store, send, settled, log, injected, sandbox };
}

const localesWritten = (injected) => injected.filter((n) => n === 'cwsPageSetDescription').length;

describe('a run that is allowed to finish', () => {
  test('walks every locale and reports done', async () => {
    const bg = load();
    await bg.send({ type: 'START_PUBLISH', config: CONFIG, opts: OPTS });
    expect(await bg.settled()).toBe('done');
    expect(localesWritten(bg.injected)).toBe(3);
    // Nothing to pick up from, so nothing is offered.
    expect(bg.store.run_resume).toBeNull();
  });

  test('leaves the page willing to start another', async () => {
    const bg = load();
    await bg.send({ type: 'START_PUBLISH', config: CONFIG, opts: OPTS });
    await bg.settled();
    expect(await bg.send({ type: 'RUN_STATE' })).toMatchObject({ running: false });

    const second = await bg.send({ type: 'START_PUBLISH', config: CONFIG, opts: OPTS });
    expect(second).toBeUndefined(); // accepted: the reply comes when the run ends
    expect(await bg.settled()).toBe('done');
    expect(localesWritten(bg.injected)).toBe(6);
  });
});

describe('Stop', () => {
  // The whole point of "cleanly": a locale is one unit of work — pick the
  // language, write the description, save — and a stop taken inside one is how a
  // page ends up with its description written and its screenshots half replaced.
  test('finishes the locale in progress and stops before the next', async () => {
    let bg;
    bg = load({
      onPage: (name) => {
        // Asked for while the FIRST locale is mid-write.
        if (name === 'cwsPageSetDescription' && localesWritten(bg.injected) === 1) {
          bg.send({ type: 'STOP_RUN' });
        }
      },
    });
    await bg.send({ type: 'START_PUBLISH', config: CONFIG, opts: OPTS });

    expect(await bg.settled()).toBe('stopped');
    expect(localesWritten(bg.injected)).toBe(1);
    expect(bg.log()).toContain(
      'Stop requested — finishing the locale in progress, then stopping…');
  });

  // Resuming on the locale the stop finished would delete and re-upload
  // screenshots that are already right — two minutes a locale on Partner Center.
  test('offers the NEXT locale as the resume point', async () => {
    let bg;
    bg = load({
      onPage: (name) => {
        if (name === 'cwsPageSetDescription' && localesWritten(bg.injected) === 1) {
          bg.send({ type: 'STOP_RUN' });
        }
      },
    });
    await bg.send({ type: 'START_PUBLISH', config: CONFIG, opts: OPTS });
    await bg.settled();

    expect(bg.store.run_resume).toEqual({ filter: 'from:de', locale: 'de', reason: 'stopped' });
    expect(bg.log().join('\n')).toContain('resume with filter "from:de"');
  });

  test('is an outcome, not a failure — the log says stopped, not error', async () => {
    let bg;
    bg = load({
      onPage: (name) => {
        if (name === 'cwsPageSetDescription' && localesWritten(bg.injected) === 1) {
          bg.send({ type: 'STOP_RUN' });
        }
      },
    });
    await bg.send({ type: 'START_PUBLISH', config: CONFIG, opts: OPTS });
    await bg.settled();
    expect(bg.log().some((l) => l.startsWith('Error:'))).toBe(false);
  });

  test('taken during the pre-flight costs nothing and offers no resume point', async () => {
    const bg = load();
    // The pre-flight reads every description before the browser is touched, so a
    // stop requested before the run starts lands there.
    const started = bg.send({ type: 'START_PUBLISH', config: CONFIG, opts: OPTS });
    await bg.send({ type: 'STOP_RUN' });
    await started;
    expect(await bg.settled()).toBe('stopped');
    expect(localesWritten(bg.injected)).toBe(0);
    expect(bg.store.run_resume).toBeNull();
  });

  test('is refused when nothing is running', async () => {
    const bg = load();
    expect(await bg.send({ type: 'STOP_RUN' }))
      .toMatchObject({ ok: false, error: 'Nothing is running.' });
  });

  test('lets the next run start straight away', async () => {
    let bg;
    bg = load({
      onPage: (name) => {
        if (name === 'cwsPageSetDescription' && localesWritten(bg.injected) === 1) {
          bg.send({ type: 'STOP_RUN' });
        }
      },
    });
    await bg.send({ type: 'START_PUBLISH', config: CONFIG, opts: OPTS });
    await bg.settled();

    expect(await bg.send({ type: 'RUN_STATE' })).toMatchObject({ running: false });
    bg.send({ type: 'START_PUBLISH', config: CONFIG, opts: { ...OPTS, localeFilter: 'from:de' } });
    expect(await bg.settled()).toBe('done');
    expect(localesWritten(bg.injected)).toBe(3); // 1 before the stop, then de and fr
  });
});

describe('an abort', () => {
  test('names the locale it died on, because that one was not written', async () => {
    const bg = load({ failOn: 'cwsPageSetDescription' });
    await bg.send({ type: 'START_PUBLISH', config: CONFIG, opts: OPTS });

    expect(await bg.settled()).toBe('error');
    expect(bg.store.run_resume)
      .toEqual({ filter: 'from:ar', locale: 'ar', reason: 'error' });
  });

  test('leaves the page willing to start another', async () => {
    const bg = load({ failOn: 'cwsPageSetDescription' });
    await bg.send({ type: 'START_PUBLISH', config: CONFIG, opts: OPTS });
    await bg.settled();
    expect(await bg.send({ type: 'RUN_STATE' })).toMatchObject({ running: false });
  });
});

describe('two runs at once', () => {
  // The popup disables Run while one is in flight, but the popup is destroyed
  // whenever it loses focus and its buttons are only a reflection. Two runs would
  // share one tab and fight over it.
  test('the second is refused while the first is still going', async () => {
    let bg;
    const seen = [];
    bg = load({
      onPage: (name) => {
        if (name === 'cwsPageSetDescription' && !seen.length) {
          seen.push(bg.send({ type: 'START_PUBLISH', config: CONFIG, opts: OPTS }));
        }
      },
    });
    await bg.send({ type: 'START_PUBLISH', config: CONFIG, opts: OPTS });
    await bg.settled();

    expect(await seen[0]).toMatchObject({ ok: false });
    expect((await seen[0]).error).toMatch(/already in progress/);
    // Refused, not queued: the first run walked its three locales and no more.
    expect(localesWritten(bg.injected)).toBe(3);
  });
});

describe('RUN_STATE', () => {
  test('answers from memory, not from what storage remembers', async () => {
    const bg = load();
    bg.store.run_state = 'running'; // the leftover of a run that died with its page
    expect(await bg.send({ type: 'RUN_STATE' })).toMatchObject({ running: false });
  });

  test('says so while a run is in flight, and while it is stopping', async () => {
    let bg;
    const states = [];
    bg = load({
      onPage: (name) => {
        if (name !== 'cwsPageSetDescription') return;
        const n = localesWritten(bg.injected);
        if (n === 1) states.push(bg.send({ type: 'RUN_STATE' }));
        if (n === 2) {
          bg.send({ type: 'STOP_RUN' });
          states.push(bg.send({ type: 'RUN_STATE' }));
        }
      },
    });
    await bg.send({ type: 'START_PUBLISH', config: CONFIG, opts: OPTS });
    await bg.settled();

    expect(await states[0]).toMatchObject({ running: true, stopping: false });
    expect(await states[1]).toMatchObject({ running: true, stopping: true });
  });
});

describe('a background page reborn after a run died with it', () => {
  // This is the bug the operator hit: every button greyed out, and reloading the
  // add-on did not help because storage.local survives it.
  // A fresh page over storage that still says "running" IS the reborn page: the
  // scripts are evaluated again, in a new scope, against storage that outlived
  // them — and outlived the add-on being reloaded, which is why reloading was
  // never the way out.
  test('reconciles the leftover "running" into "interrupted"', async () => {
    const bg = load({ seed: { run_state: 'running' } });
    await new Promise((r) => setImmediate(r));
    expect(bg.store.run_state).toBe('interrupted');
  });

  test('reconciles a leftover "stopping" too', async () => {
    const bg = load({ seed: { run_state: 'stopping' } });
    await new Promise((r) => setImmediate(r));
    expect(bg.store.run_state).toBe('interrupted');
  });

  test('leaves a finished run\'s state alone', async () => {
    const bg = load({ seed: { run_state: 'error' } });
    await new Promise((r) => setImmediate(r));
    expect(bg.store.run_state).toBe('error');
  });

  // The log of the run that died is what says how far it got, so it survives.
  test('keeps the dead run\'s log', async () => {
    const bg = load({ seed: { run_state: 'running', run_log: [{ text: 'ar (Arabic)' }] } });
    await new Promise((r) => setImmediate(r));
    expect(bg.log()).toEqual(['ar (Arabic)']);
  });

  // The reconciliation is asynchronous, and the message that woke the page may be
  // the START_PUBLISH of a perfectly real new run. Clobbering that one back to
  // "interrupted" would grey the buttons out over a run that is very much alive.
  test('does not clobber a run that started while it was checking', async () => {
    const bg = load();
    await bg.send({ type: 'START_PUBLISH', config: CONFIG, opts: OPTS });
    expect(await bg.settled()).toBe('done');
    expect(bg.store.run_state).toBe('done');
  });
});

describe('starting a run', () => {
  test('clears the resume offer left by the run before it', async () => {
    const bg = load({ failOn: 'cwsPageSetDescription' });
    await bg.send({ type: 'START_PUBLISH', config: CONFIG, opts: OPTS });
    await bg.settled();
    expect(bg.store.run_resume).not.toBeNull();

    const clean = load({
      seed: { run_resume: { filter: 'from:de', locale: 'de', reason: 'error' } },
    });
    await clean.send({ type: 'START_PUBLISH', config: CONFIG, opts: OPTS });
    await clean.settled();
    expect(clean.store.run_resume).toBeNull();
  });
});

// Partner Center has no global assets card: each language owns every screenshot
// on its own details page. The popup greys the option out, but the popup is a
// reflection and is destroyed whenever it loses focus — this is the decision.
describe('an option the store has no card for', () => {
  // Dry: whether the option is accepted is the question, and the upload itself has
  // suites of its own.
  const globalOnly = {
    ...OPTS, updateTexts: false, updateGlobalImages: true, dryRun: true,
  };

  test('is refused, naming what the store does instead', async () => {
    const bg = load();
    await bg.send({
      type: 'START_PUBLISH', config: CONFIG, opts: { ...globalOnly, store: 'edge' },
    });
    expect(await bg.settled()).toBe('error');
    expect(bg.log().join(' ')).toMatch(/no international screenshots/i);
  });

  // Refused, not quietly dropped: a run that skips what it was asked for reads
  // like a run that did it.
  test('never opens a tab', async () => {
    const bg = load();
    await bg.send({
      type: 'START_PUBLISH', config: CONFIG, opts: { ...globalOnly, store: 'edge' },
    });
    await bg.settled();
    expect(bg.injected).toEqual([]);
  });

  test('is fine on a store that does have the card', async () => {
    const bg = load();
    await bg.send({ type: 'START_PUBLISH', config: CONFIG, opts: globalOnly });
    expect(await bg.settled()).toBe('done');
  });

  test('leaves the page willing to start another', async () => {
    const bg = load();
    await bg.send({
      type: 'START_PUBLISH', config: CONFIG, opts: { ...globalOnly, store: 'edge' },
    });
    await bg.settled();
    expect(await bg.send({ type: 'RUN_STATE' })).toMatchObject({ running: false });
  });
});

// The popup has to know which options mean anything where, and that is the
// driver's fact rather than a second list in another file.
describe('STORE_INFO', () => {
  test('reports the screenshot scopes of each store', async () => {
    const bg = load();
    const res = await bg.send({ type: 'STORE_INFO' });
    expect(res.stores.cws.screenshotScopes).toContain('global');
    expect(res.stores.edge.screenshotScopes).not.toContain('global');
    expect(res.stores.edge.screenshotScopes).toContain('localized');
  });

  test('covers every registered store', async () => {
    const bg = load();
    const res = await bg.send({ type: 'STORE_INFO' });
    expect(Object.keys(res.stores).sort()).toEqual(['cws', 'edge']);
  });
});

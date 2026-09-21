/**
 * @jest-environment jsdom
 */
// The three buttons, against the real popup.html.
//
// This is the half the operator sees, and the half that broke: Run and Probe were
// disabled from `run_state` in storage, which says "running" for as long as
// nobody writes over it — and the run that would have is the one that died. Every
// button greyed out, and reloading the add-on did not help, because storage.local
// survives it.
//
// So the popup asks the background instead, and the assertions below are about
// that: whatever storage remembers, the buttons follow what is actually running.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'extension', 'popup.html'), 'utf8');
const POPUP_JS = fs.readFileSync(path.join(ROOT, 'extension', 'popup.js'), 'utf8');

const CONFIG = {
  items: [{ slug: 'thing', name: 'Thing' }],
  locales: [{ internal: 'en', cws: 'en', name: 'English' }],
  assets: { root: '/assets', chrome: { description: '{lang}.txt' } },
};

// Loads popup.js over popup.html with a stubbed browser.
//
// `runState` is what the background answers RUN_STATE with; `stored` is what
// storage.local already holds. The two disagreeing is the whole point.
const STORES = {
  cws: { screenshotScopes: ['localized', 'global'] },
  edge: { screenshotScopes: ['localized'] },
};

async function openPopup({ runState = { running: false }, stored = {}, stores = STORES } = {}) {
  document.documentElement.innerHTML = HTML.replace(/<script[\s\S]*?<\/script>/g, '');

  const store = { ...stored };
  const sent = [];
  let storageListener = null;

  const chrome = {
    runtime: {
      lastError: null,
      getURL: (f) => `moz-extension://x/${f}`,
      sendMessage: (msg, cb) => {
        sent.push(msg);
        const reply = {
          RESOLVE_CONFIG: () => ({ ok: true, config: CONFIG }),
          STORE_INFO: () => ({ ok: true, stores }),
          RUN_STATE: () => ({ ok: true, ...runState }),
          // The real handler flips the flag and keeps running, so every later
          // RUN_STATE says "stopping". A frozen fixture here would let the popup
          // re-enable Stop on its own follow-up question.
          STOP_RUN: () => {
            runState = { ...runState, stopping: true };
            return { ok: true, stopping: true };
          },
          START_PUBLISH: () => undefined,
        }[msg.type];
        // Asynchronous, like the real one: the popup must not depend on a reply
        // it gets before its own next line runs.
        Promise.resolve().then(() => cb && cb(reply ? reply() : undefined));
      },
    },
    storage: {
      local: {
        set: (obj) => {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) changes[k] = { newValue: v };
          Object.assign(store, obj);
          if (storageListener) storageListener(changes, 'local');
        },
        get: (keys, cb) => {
          const out = {};
          for (const k of [].concat(keys)) if (k in store) out[k] = store[k];
          cb(out);
        },
      },
      onChanged: { addListener: (fn) => { storageListener = fn; } },
    },
  };

  const sandbox = {
    document, window, console, Promise, Object, Error,
    chrome,
    fetch: async () => ({ ok: true, json: async () => ({ extends: undefined, ...CONFIG }) }),
  };
  sandbox.globalThis = sandbox;
  vm.runInContext(POPUP_JS, vm.createContext(sandbox), { filename: 'popup.js' });

  // Config load → resolve → restore → askState, all microtasks here.
  for (let i = 0; i < 20; i += 1) await Promise.resolve();

  const el = (id) => document.getElementById(id);
  return {
    store,
    sent,
    run: el('run'),
    probe: el('probe'),
    stop: el('stop'),
    filter: el('filter'),
    note: el('note'),
    store: el('store'),
    global: el('optGlobalImages'),
    globalRow: el('optGlobalImagesRow'),
    selectStore: async (id) => {
      el('store').value = id;
      el('store').dispatchEvent(new window.Event('change'));
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    },
    setState: (state) => chrome.storage.local.set({ run_state: state }),
    setResume: (v) => chrome.storage.local.set({ run_resume: v }),
    settle: async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); },
  };
}

test('with nothing running, Run and Probe are live and Stop is not', async () => {
  const ui = await openPopup();
  expect(ui.run.disabled).toBe(false);
  expect(ui.probe.disabled).toBe(false);
  expect(ui.stop.disabled).toBe(true);
});

// The bug, as the operator met it.
test('a leftover "running" in storage does not grey the buttons out', async () => {
  const ui = await openPopup({
    runState: { running: false },
    stored: { run_state: 'running' },
  });
  expect(ui.run.disabled).toBe(false);
  expect(ui.probe.disabled).toBe(false);
  expect(ui.note.textContent).toMatch(/interrupted|unloaded/i);
});

test('the popup asks the background rather than reading the state off storage', async () => {
  const ui = await openPopup({ stored: { run_state: 'running' } });
  expect(ui.sent.some((m) => m.type === 'RUN_STATE')).toBe(true);
});

test('a run that really is in flight does grey them out, and offers Stop', async () => {
  const ui = await openPopup({ runState: { running: true, stopping: false } });
  expect(ui.run.disabled).toBe(true);
  expect(ui.probe.disabled).toBe(true);
  expect(ui.stop.disabled).toBe(false);
});

test('while stopping, Stop says so and cannot be pressed again', async () => {
  const ui = await openPopup({ runState: { running: true, stopping: true } });
  expect(ui.stop.disabled).toBe(true);
  expect(ui.stop.textContent).toBe('Stopping…');
  expect(ui.run.disabled).toBe(true);
});

test('when the run ends, Run comes back and Stop goes away', async () => {
  const ui = await openPopup({ runState: { running: true, stopping: false } });
  expect(ui.run.disabled).toBe(true);

  ui.setState('error'); // the background's own final write
  expect(ui.run.disabled).toBe(false);
  expect(ui.stop.disabled).toBe(true);
});

describe('the resume offer', () => {
  test('is put in the filter field while the popup is open', async () => {
    const ui = await openPopup({ runState: { running: true, stopping: false } });
    ui.setResume({ filter: 'from:de', locale: 'de', reason: 'stopped' });
    expect(ui.filter.value).toBe('from:de');
    expect(ui.note.textContent).toContain('from:de');
  });

  test('is still there when the popup is reopened', async () => {
    const ui = await openPopup({
      stored: {
        run_state: 'stopped',
        run_resume: { filter: 'from:fr', locale: 'fr', reason: 'stopped' },
        publisher_opts: { itemSlug: 'thing', localeFilter: 'from:ar' },
      },
    });
    // It wins over the filter the stopped run was started with — that one is
    // where the run began, not where the next one should.
    expect(ui.filter.value).toBe('from:fr');
  });

  test('does not overwrite the field when there is nothing to resume', async () => {
    const ui = await openPopup({
      stored: { publisher_opts: { itemSlug: 'thing', localeFilter: 'fr,de' } },
    });
    expect(ui.filter.value).toBe('fr,de');
  });
});

test('Stop asks the background to stop, once', async () => {
  const ui = await openPopup({ runState: { running: true, stopping: false } });
  ui.stop.click();
  await ui.settle();
  expect(ui.sent.filter((m) => m.type === 'STOP_RUN')).toHaveLength(1);
  // And stays pressed-out afterwards, because the state it re-reads says stopping.
  expect(ui.stop.disabled).toBe(true);
  expect(ui.stop.textContent).toBe('Stopping…');
  expect(ui.run.disabled).toBe(true);
});

// Partner Center gives each language its own details page and has no global
// assets card, so "Replace international screenshots" means nothing there — and
// what it would have done is worse than nothing: the upload lands on whichever
// language's page is open. Which store that is comes from the drivers
// (STORE_INFO), not from a second list in here.
describe('an option the selected store has no card for', () => {
  test('is offered on the Chrome Web Store', async () => {
    const ui = await openPopup();
    await ui.selectStore('cws');
    expect(ui.global.disabled).toBe(false);
    expect(ui.globalRow.classList.contains('unavailable')).toBe(false);
  });

  test('is greyed out on Partner Center', async () => {
    const ui = await openPopup();
    await ui.selectStore('edge');
    expect(ui.global.disabled).toBe(true);
    expect(ui.globalRow.classList.contains('unavailable')).toBe(true);
    // Named by its label, not its id — the tooltip is a sentence.
    expect(ui.globalRow.title).toMatch(/^Microsoft Edge \(Partner Center\) gives/);
  });

  // A disabled checkbox still reports `checked`, so greying it out is not enough:
  // the run would be asked for it anyway and refused.
  test('is unticked, not just disabled', async () => {
    const ui = await openPopup();
    await ui.selectStore('cws');
    ui.global.checked = true;
    await ui.selectStore('edge');
    expect(ui.global.checked).toBe(false);
  });

  test('comes back when a store that has the card is selected again', async () => {
    const ui = await openPopup();
    await ui.selectStore('edge');
    await ui.selectStore('cws');
    expect(ui.global.disabled).toBe(false);
    expect(ui.globalRow.classList.contains('unavailable')).toBe(false);
  });

  // The last run is restored from storage, and it may have been on another store.
  test('is not restored from a remembered run on another store', async () => {
    const ui = await openPopup({
      stored: {
        publisher_opts: { itemSlug: 'thing', store: 'edge', updateGlobalImages: true },
      },
    });
    expect(ui.store.value).toBe('edge');
    expect(ui.global.checked).toBe(false);
    expect(ui.global.disabled).toBe(true);
  });

  // An answer that never arrives must not hide an option that does exist: the
  // orchestration refuses what the store cannot do anyway.
  test('stays offered when the background does not answer', async () => {
    const ui = await openPopup({ stores: {} });
    await ui.selectStore('edge');
    expect(ui.global.disabled).toBe(false);
  });
});

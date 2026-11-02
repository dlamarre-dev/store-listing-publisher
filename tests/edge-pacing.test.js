// How often the Edge driver touches Partner Center.
//
// Partner Center's firewall blocked two runs while screenshots were being
// cleared: the deletes followed one another with no pause at all. These tests
// pin the spacing the driver now keeps, against a fake clock, so they take no
// real time and a refactor that drops a wait shows up here.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPTS = ['lib/locales.js', 'stores/cws.js', 'stores/edge.js'];

// A page with `slot` screenshots. Every sleep advances the fake clock and is
// recorded; every injected call is logged with the clock at that moment.
function loadEdge(slot = 5) {
  const page = { slot, clock: 1_000_000, sleeps: [], calls: [] };
  const answer = (name) => {
    switch (name) {
      case 'edgePageDeleteOneScreenshot':
        if (!page.slot) return { ok: true, before: 0, after: 0, nothingToDelete: true };
        page.slot -= 1;
        return { ok: true, before: page.slot + 1, after: page.slot };
      case 'edgePageCountScreenshots':
        return { ok: true, count: page.slot, files: [] };
      case 'edgePageApplyUpload':
        page.slot += 1;
        return { ok: true, chose: 'test' };
      case 'edgePageSlotState':
        return { ok: true, ready: true };
      default:
        return null;
    }
  };

  const sandbox = {
    chrome: {
      scripting: {
        executeScript: async ({ func }) => {
          page.calls.push({ name: func.name, at: page.clock });
          return [{ result: answer(func.name) }];
        },
      },
      storage: { local: { get: async () => ({}), set: async () => {} } },
    },
    getComputedStyle: () => ({}),
    document: { querySelectorAll: () => [] },
    location: { href: '' },
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    setTimeout: (fn, ms) => { page.sleeps.push(ms); page.clock += ms || 0; fn(); return 0; },
    __clock: () => page.clock,
    console,
  };
  const ctx = vm.createContext(sandbox);
  const sources = SCRIPTS.map(
    (f) => fs.readFileSync(path.join(__dirname, '..', 'extension', f), 'utf8'));
  sources.unshift('Date.now = () => __clock();');
  sources.push('globalThis.__edge = EdgeDriver;');
  vm.runInContext(sources.join('\n;\n'), ctx, { filename: 'stores/*.js' });
  return { edge: sandbox.__edge, page };
}

const deletesAt = (page) => page.calls
  .filter(c => c.name === 'edgePageDeleteOneScreenshot').map(c => c.at);
const gaps = (times) => times.slice(1).map((t, i) => t - times[i]);

describe('deleting screenshots', () => {
  test('waits 10 s between two deletes by default', async () => {
    const { edge, page } = loadEdge(5);
    edge.configure({});
    for (let i = 0; i < 5; i += 1) await edge.deleteOneScreenshot(1, 'localized');
    expect(gaps(deletesAt(page))).toEqual([10000, 10000, 10000, 10000]);
  });

  test('takes the gap from config.edge.pacing', async () => {
    const { edge, page } = loadEdge(3);
    edge.configure({ edge: { pacing: { deleteGapMs: 25000 } } });
    for (let i = 0; i < 3; i += 1) await edge.deleteOneScreenshot(1, 'localized');
    expect(gaps(deletesAt(page))).toEqual([25000, 25000]);
  });

  test('an empty slot sent no delete, so it owes no gap', async () => {
    const { edge, page } = loadEdge(0);
    edge.configure({});
    await edge.deleteOneScreenshot(1, 'localized');
    await edge.deleteOneScreenshot(1, 'localized');
    expect(page.sleeps.filter(ms => ms >= 1000)).toEqual([]);
  });
});

describe('the first upload after clearing the slot', () => {
  test('waits out the delete gap instead of following the last delete at once', async () => {
    const { edge, page } = loadEdge(1);
    edge.configure({});
    await edge.deleteOneScreenshot(1, 'localized');
    const deletedAt = page.clock;
    const res = await edge.uploadScreenshot(1, 'AAAA', 'Promo_1_fr.png');
    expect(res.ok).toBe(true);
    const appliedAt = page.calls.find(c => c.name === 'edgePageApplyUpload').at;
    expect(appliedAt - deletedAt).toBeGreaterThanOrEqual(10000);
  });
});

describe('between languages', () => {
  test('pauses 20 s by default, and what the config says otherwise', async () => {
    const { edge, page } = loadEdge();
    edge.configure({});
    expect(await edge.paceLocale()).toBe(20000);
    edge.configure({ edge: { pacing: { localeGapMs: 0 } } });
    expect(await edge.paceLocale()).toBe(0);
    expect(page.sleeps).toEqual([20000]);
  });
});

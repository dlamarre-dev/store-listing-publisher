// The driver's verify-and-escalate loop for a screenshot upload.
//
// This lives in the driver rather than in the injected page function, and that
// placement is the point of these tests. A run once stopped after two screenshots
// with no error at all: the page function held the loop, so a single injected
// script ran for up to 45 seconds, and an injected script that outlives a
// re-render of the page dies with it — taking its promise with it. Nothing had
// failed; nothing was going to answer either.
//
// From the driver, every injection is short, the waiting is ours, and a page that
// stops answering becomes a timeout rather than a silence.
//
// The page is faked at the executeScript boundary, dispatching on the function's
// name, so these tests exercise the real loop against a page that reacts to
// exactly one gesture — which is the situation the escalation exists for.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPTS = ['lib/locales.js', 'stores/cws.js', 'stores/edge.js'];

// `answers` is the mechanism the fake page reacts to; null means it takes
// nothing. `delay` makes it react only after that many count polls, which is how
// a slow-but-working gesture is told from one that is ignored.
function load({ answers = 1, delay = 0, count = 0, applyResult = null,
                stored = null, latency = 0 } = {}) {
  const state = { count, applied: [], polls: 0, pending: null, stored, latency };

  const sandbox = {
    console,
    setTimeout: (fn) => { fn(); return 0; },
    getComputedStyle: () => ({}),
    document: { querySelectorAll: () => [] },
    location: { href: '' },
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    chrome: {
      // The learned gesture lives here between runs. Absent storage is handled
      // too — a session-only preference is still worth having — so this fake is
      // about the remembering, not about whether it is required.
      storage: {
        local: {
          // Takes a key or a list of them, like the real one: the driver reads the
          // gesture and the measured latency together.
          get: async (keys) => {
            const want = Array.isArray(keys) ? keys : [keys];
            const out = {};
            if (state.stored !== null && want.includes('edgeUploadGesture')) {
              out.edgeUploadGesture = state.stored;
            }
            if (state.latency && want.includes('edgeUploadLatencyMs')) {
              out.edgeUploadLatencyMs = state.latency;
            }
            return out;
          },
          set: async (obj) => {
            if ('edgeUploadGesture' in obj) state.stored = obj.edgeUploadGesture;
            if ('edgeUploadLatencyMs' in obj) state.latency = obj.edgeUploadLatencyMs;
          },
        },
      },
      scripting: {
        executeScript: async ({ func, args }) => {
          if (func.name === 'pageCountScreenshots') {
            state.polls += 1;
            // A gesture that works, but not instantly.
            if (state.pending !== null && state.polls > state.pending.at) {
              state.count += 1;
              state.pending = null;
            }
            return [{ result: { ok: true, count: state.count, scope: 'localized' } }];
          }
          if (func.name === 'pageApplyUpload') {
            const mechanism = args[2];
            state.applied.push(mechanism);
            if (applyResult) return [{ result: applyResult }];
            if (mechanism === answers) {
              state.pending = { at: state.polls + delay };
            }
            return [{ result: { ok: true, mechanism, chose: 'add-image', inputs: 1 } }];
          }
          return [{ result: null }];
        },
      },
    },
  };

  const sources = SCRIPTS.map(
    (f) => fs.readFileSync(path.join(__dirname, '..', 'extension', f), 'utf8'));
  sources.push('globalThis.__edge = EdgeDriver;');
  vm.runInContext(sources.join('\n;\n'), vm.createContext(sandbox),
                  { filename: 'stores/*.js' });
  return { driver: sandbox.__edge, state };
}

const B64 = Buffer.from('PNG').toString('base64');
const upload = (opts) => {
  const { driver, state } = load(opts);
  return driver.uploadScreenshot(1, B64, 'p.png').then((res) => ({ res, state }));
};

describe('escalation', () => {
  test('stops at the gesture the page answers', async () => {
    const { res, state } = await upload({ answers: 1 });
    expect(res).toMatchObject({ ok: true, via: 1, before: 0, after: 1 });
    expect(state.applied).toEqual([1]);
  });

  // The drop is tried LAST, because it has never been accepted on the real
  // console and while it sat second it cost a whole window on every upload.
  test('reaches the drop last, when only a drop is answered', async () => {
    const { res, state } = await upload({ answers: 2 });
    expect(res).toMatchObject({ ok: true, via: 2 });
    expect(state.applied).toEqual([1, 3, 2]);
  });

  test('and the blur sequence when only that is', async () => {
    const { res, state } = await upload({ answers: 3 });
    expect(res).toMatchObject({ ok: true, via: 3 });
    // Second, not third: gestures 1 and 3 are the two that assign input.files,
    // and it is the second assignment the console honours.
    expect(state.applied).toEqual([1, 3]);
  });

  // The reason to verify before escalating rather than firing all three: the same
  // file uploaded twice puts a five-screenshot listing over the cap of six.
  test('a gesture that works slowly is not overtaken by the next', async () => {
    const { res, state } = await upload({ answers: 1, delay: 12 });
    expect(res).toMatchObject({ ok: true, via: 1 });
    expect(state.applied).toEqual([1]);
  });

  test('a page that takes nothing fails, saying what was tried', async () => {
    const { res, state } = await upload({ answers: null });
    expect(res).toMatchObject({ ok: false, step: 'upload-not-accepted',
                                before: 0, after: 0 });
    expect(state.applied).toEqual([1, 3, 2]);
    expect(res.tried.map((t) => t.mechanism)).toEqual([1, 3, 2]);
    expect(res.detail).toMatch(/thumbnail count/);
  });

  test('the count it compares against is the count before this upload', async () => {
    const { res } = await upload({ answers: 1, count: 3 });
    expect(res).toMatchObject({ ok: true, before: 3, after: 4 });
  });
});

describe('a refusal about the page rather than the gesture', () => {
  // No slot and no file input are not things a different gesture fixes. Trying
  // all three would take three times as long to report the same thing, and would
  // read in the log as though the page had been given every chance.
  test('is returned at once, not escalated', async () => {
    const { res, state } = await upload({
      applyResult: { ok: false, step: 'no-screenshot-slot', detail: 'nope' },
    });
    expect(res).toMatchObject({ ok: false, step: 'no-screenshot-slot', before: 0 });
    expect(state.applied).toEqual([1]);
  });

  test('and keeps its own detail rather than the escalation summary', async () => {
    const { res } = await upload({
      applyResult: { ok: false, step: 'no-screenshot-file-input', detail: 'six already' },
    });
    expect(res.detail).toBe('six already');
  });
});

// ── learning which gesture this console answers ──────────────────────────────
//
// The escalation is safe but it is not free: a gesture that will not be taken
// costs a whole verification window before the next is tried. A real run showed
// the shape of it — the first screenshot went in on gesture 1, every one after it
// on gesture 3 — so uploads 2 through 5 each paid for two gestures they were never
// going to accept. Across 43 locales that is not a rough edge, it is the run.
//
// Remembering cannot break anything, which is why it is worth doing: a wrong
// preference only changes which gesture is tried first, and the rest still follow.
describe('the remembered gesture', () => {
  test('is learned from the first upload that works', async () => {
    const { driver, state } = load({ answers: 3 });
    await driver.uploadScreenshot(1, B64, 'p1.png');
    expect(state.stored).toBe(3);
  });

  // The point of all this: the second upload does not repeat the search.
  test('and the next upload starts there', async () => {
    const { driver, state } = load({ answers: 3 });
    await driver.uploadScreenshot(1, B64, 'p1.png');
    expect(state.applied).toEqual([1, 3]);

    state.applied.length = 0;
    const res = await driver.uploadScreenshot(1, B64, 'p2.png');
    expect(res).toMatchObject({ ok: true, via: 3 });
    expect(state.applied).toEqual([3]);
  });

  test('a preference from an earlier session is honoured immediately', async () => {
    const { driver, state } = load({ answers: 3, stored: 3 });
    const res = await driver.uploadScreenshot(1, B64, 'p1.png');
    expect(res).toMatchObject({ ok: true, via: 3 });
    expect(state.applied).toEqual([3]);
  });

  // If the console changes its mind, a stale preference must not become a wall.
  test('a stale preference is tried first and then abandoned', async () => {
    const { driver, state } = load({ answers: 1, stored: 3 });
    const res = await driver.uploadScreenshot(1, B64, 'p1.png');
    expect(res).toMatchObject({ ok: true, via: 1 });
    expect(state.applied).toEqual([3, 1]);
    expect(state.stored).toBe(1);
  });

  test('every gesture is still tried, whichever one is preferred', async () => {
    const { driver, state } = load({ answers: null, stored: 2 });
    await driver.uploadScreenshot(1, B64, 'p1.png');
    // The preferred one first, then the others — in order, and all of them.
    expect(state.applied).toEqual([2, 1, 3]);
  });
});

// ── the measured window ──────────────────────────────────────────────────────
//
// A gesture that will not be taken costs the whole wait before the next is
// tried, so what that wait should be is the number that decides whether 43
// locales take twenty minutes or two hours. It is measured rather than chosen:
// every success reports how long it took, the slowest is remembered, and the
// window is four times that — floored so a fast console cannot make the check
// flaky, capped so a slow one cannot make a run unbounded.
describe('the wait before escalating', () => {
  // Polls counted at the boundary: one before, one after, and the rest inside
  // the three windows.
  const pollsFor = async (opts) => (await upload({ answers: null, ...opts })).state.polls;

  test('is the conservative maximum until something has been measured', async () => {
    // 30s / 750ms = 40 polls per gesture, three gestures, plus before and after.
    expect(await pollsFor({})).toBe(122);
  });

  test('and four times the measured latency once there is one', async () => {
    // 2s measured → 8s window → 11 polls per gesture.
    expect(await pollsFor({ latency: 2000 })).toBe(35);
  });

  test('with a floor, so a fast console does not make it flaky', async () => {
    // 200ms measured would give 800ms; the floor holds it at 6s → 8 polls.
    expect(await pollsFor({ latency: 200 })).toBe(26);
  });

  test('and a cap, so a slow one cannot make a run unbounded', async () => {
    expect(await pollsFor({ latency: 60000 })).toBe(122);
  });

  test('a success reports how long it took, which is what feeds all this', async () => {
    const { res, state } = await upload({ answers: 1, delay: 3 });
    expect(res.tookMs).toBe(4 * 750);
    expect(state.latency).toBe(4 * 750);
  });

  // The slowest, not the latest: one quick upload must not shrink the window
  // below what a slow one needed.
  test('and the remembered latency is the slowest seen', async () => {
    const { driver, state } = load({ answers: 1, delay: 5 });
    await driver.uploadScreenshot(1, B64, 'p1.png');
    const slow = state.latency;
    state.pending = null;
    await driver.uploadScreenshot(1, B64, 'p2.png');
    expect(state.latency).toBe(slow);
  });
});

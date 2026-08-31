// Prime, then commit: how the driver gets a screenshot into Partner Center.
//
// This console swallows the first assignment made to a slot that already holds an
// image, and honours the second. That is not a theory — a five-screenshot run
// reported its winning gestures as 1, 3, 1, 3, 1, alternating, because an earlier
// design remembered whichever gesture had just worked and tried it first, where it
// then failed. Gestures 1 and 3 are the two that assign input.files; the drop
// does not, and has never been accepted on the real page.
//
// So both fills are made every time and only the second is waited on properly.
// The short probe after the first is what keeps this from uploading twice: this
// slot appends rather than replaces, and its cap is six against the five we send,
// so a duplicate is a broken listing rather than a wasted second.
//
// The loop lives in the driver rather than in the injected page function, and that
// placement is load-bearing. A run once stopped after two screenshots with no
// error at all: the page function held the loop, so a single injected script ran
// for up to 45 seconds, and an injected script that outlives a re-render of the
// page dies with it, taking its promise. From here every injection is short and a
// page that stops answering becomes a timeout instead of a silence.
//
// The page is faked at the executeScript boundary, dispatching on the function's
// name, so these tests drive the real loop.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPTS = ['lib/locales.js', 'stores/cws.js', 'stores/edge.js'];

// `honours` says which attempt the fake page accepts — 1 for the first fill (an
// empty slot), 2 for the second (a slot with an image in it), 'drop' for the drop
// alone, or null for a page that takes nothing. `delay` is how many count polls
// pass before the accepted attempt shows up.
function load({ honours = 1, delay = 0, count = 0, applyResult = null,
                latency = 0, duplicate = false, readyAfter = 0,
                slotState = true } = {}) {
  const state = { count, applied: [], polls: 0, pending: null, latency, fills: 0,
                  slotChecks: 0 };

  const sandbox = {
    console,
    setTimeout: (fn) => { fn(); return 0; },
    getComputedStyle: () => ({}),
    document: { querySelectorAll: () => [] },
    location: { href: '' },
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    chrome: {
      storage: {
        local: {
          get: async (keys) => {
            const want = Array.isArray(keys) ? keys : [keys];
            return state.latency && want.includes('edgeUploadLatencyMs')
              ? { edgeUploadLatencyMs: state.latency } : {};
          },
          set: async (obj) => {
            if ('edgeUploadLatencyMs' in obj) state.latency = obj.edgeUploadLatencyMs;
          },
        },
      },
      scripting: {
        executeScript: async ({ func, args }) => {
          if (func.name === 'pageCountScreenshots') {
            state.polls += 1;
            if (state.pending !== null && state.polls > state.pending.at) {
              state.count += duplicate ? 2 : 1;
              state.pending = null;
            }
            return [{ result: { ok: true, count: state.count, scope: 'localized' } }];
          }
          if (func.name === 'pageSlotState') {
            state.slotChecks += 1;
            if (!slotState) return [{ result: null }];
            return [{ result: { ok: true, count: state.count,
                                committed: state.count,
                                ready: state.slotChecks > readyAfter } }];
          }
          if (func.name === 'pageApplyUpload') {
            const mechanism = args[2];
            state.applied.push(mechanism);
            if (applyResult) return [{ result: applyResult }];
            const isFill = mechanism !== 2;
            if (isFill) state.fills += 1;
            const accepted = honours === 'drop'
              ? mechanism === 2
              : isFill && state.fills === honours;
            if (accepted) state.pending = { at: state.polls + delay };
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

// Read from the driver rather than repeated here: the gap is a knob, and a test
// that hardcodes its value fails on the next tuning run for a reason that has
// nothing to do with what it is checking.
const GAP_MS = Number(fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'stores', 'edge.js'), 'utf8')
  .match(/const MIN_UPLOAD_GAP_MS = (\d+);/)[1]);

const B64 = Buffer.from('PNG').toString('base64');
const upload = (opts) => {
  const { driver, state } = load(opts);
  return driver.uploadScreenshot(1, B64, 'p.png').then((res) => ({ res, state }));
};

describe('an empty slot', () => {
  test('takes the first fill and nothing else is attempted', async () => {
    const { res, state } = await upload({ honours: 1 });
    expect(res).toMatchObject({ ok: true, via: 1, before: 0, after: 1 });
    expect(state.applied).toEqual([1]);
  });

  // The whole point of probing before the second fill: a first fill that worked
  // must not be followed by another, or the slot appends the same file twice.
  test('is never filled a second time', async () => {
    const { state } = await upload({ honours: 1 });
    expect(state.fills).toBe(1);
  });
});

describe('a slot that already holds an image', () => {
  test('swallows the first fill and takes the second', async () => {
    const { res, state } = await upload({ honours: 2, count: 1 });
    expect(res).toMatchObject({ ok: true, via: 3, before: 1, after: 2 });
    expect(state.applied).toEqual([1, 3]);
  });

  // The second fill is given the full window, not the probe: by then there is
  // nothing left to escalate to in a hurry, and cutting it short is what made a
  // real run fail after one screenshot.
  test('and the second fill is waited on properly, not probed', async () => {
    // 20 polls is far past the 3s probe and well inside the 30s window.
    const { res } = await upload({ honours: 2, count: 1, delay: 20 });
    expect(res).toMatchObject({ ok: true, via: 3 });
  });

  test('the drop is only reached if neither fill lands', async () => {
    const { res, state } = await upload({ honours: 'drop', count: 1 });
    expect(res).toMatchObject({ ok: true, via: 2 });
    expect(state.applied).toEqual([1, 3, 2]);
  });
});

describe('a page that takes nothing', () => {
  test('fails, saying what was attempted', async () => {
    const { res, state } = await upload({ honours: null, count: 1 });
    expect(res).toMatchObject({ ok: false, step: 'upload-not-accepted',
                                before: 1, after: 1 });
    expect(state.applied).toEqual([1, 3, 2]);
    expect(res.detail).toMatch(/twice and dropped on it once/);
  });
});

describe('a refusal about the page rather than the gesture', () => {
  // No slot and no file input are not things a different gesture fixes. Trying
  // them all would take three times as long to report the same thing, and would
  // read in the log as though the page had been given every chance.
  test('is returned at once, not escalated', async () => {
    const { res, state } = await upload({
      applyResult: { ok: false, step: 'no-screenshot-slot', detail: 'nope' },
    });
    expect(res).toMatchObject({ ok: false, step: 'no-screenshot-slot', before: 0 });
    expect(state.applied).toEqual([1]);
  });

  test('and keeps its own detail rather than the summary', async () => {
    const { res } = await upload({
      applyResult: { ok: false, step: 'no-screenshot-file-input', detail: 'six already' },
    });
    expect(res.detail).toBe('six already');
  });
});

// The failure the probe exists to prevent, reported rather than absorbed. A
// duplicate is not self-correcting here: five screenshots plus one is the cap of
// six, and the next upload would then fail for a reason unconnected to itself.
describe('a file that goes in twice', () => {
  test('is a failure, at the upload that caused it', async () => {
    const { res } = await upload({ honours: 1, duplicate: true });
    expect(res).toMatchObject({ ok: false, step: 'upload-duplicated',
                                before: 0, after: 2, via: 1 });
    expect(res.detail).toMatch(/removed by hand/);
  });
});

// ── the probe window ─────────────────────────────────────────────────────────
//
// It decides how long a swallowed first fill costs, on every upload of every
// locale. Measured rather than chosen — but only from first-fill successes: the
// latency of a success that needed two fills includes the swallowed one, and
// feeding that back would inflate the probe with a number answering a different
// question. The mirror of that mistake is what made the previous version fail
// after one screenshot — it sized its window from a 0.8s best case.
describe('the probe before the second fill', () => {
  const pollsFor = async (opts) => (await upload({ honours: null, ...opts })).state.polls;
  const base = 128; // 6 probe polls + two 60-poll windows + before + after

  test('is 3s until an honoured fill has been timed', async () => {
    expect(await pollsFor({})).toBe(base);
  });

  test('and four times that timing once there is one', async () => {
    // 2s measured → 8s probe → 16 polls, ten more than the floor.
    expect(await pollsFor({ latency: 2000 })).toBe(base + 10);
  });

  test('with a floor, so a fast console does not make it flaky', async () => {
    expect(await pollsFor({ latency: 200 })).toBe(base);
  });

  // Past the cap the probe costs more than the escalation it is avoiding.
  test('and a cap, so it cannot grow without limit', async () => {
    expect(await pollsFor({ latency: 60000 })).toBe(base + 14);
  });

  test('a first-fill success reports and remembers its timing', async () => {
    const { res, state } = await upload({ honours: 1, delay: 2 });
    expect(res.tookMs).toBe(3 * 500);
    expect(state.latency).toBe(3 * 500);
  });

  // The number that must not be learned: a two-fill success is slower by
  // construction, and letting it size the probe would make every later upload
  // wait out the very fill it is trying to rule out quickly.
  test('a second-fill success does not', async () => {
    const { state } = await upload({ honours: 2, count: 1, delay: 10 });
    expect(state.latency).toBe(0);
  });

  test('and the remembered timing is the slowest first fill seen', async () => {
    const { driver, state } = load({ honours: 1, delay: 4 });
    await driver.uploadScreenshot(1, B64, 'p1.png');
    expect(state.latency).toBe(5 * 500);

    state.pending = null;
    state.fills = 0;
    await driver.uploadScreenshot(1, B64, 'p2.png');
    expect(state.latency).toBe(5 * 500);
  });
});

// ── the gap between two uploads ──────────────────────────────────────────────
//
// Read together, three runs said the same thing: an upload into a slot that
// already holds an image lands about half a minute after the previous one and not
// before, whichever gesture is used. Every earlier design was paying that gap by
// accident, inside verification windows it thought it was spending on gestures —
// which is why shortening the probe to three seconds broke a run that had worked.
//
// So it is waited out deliberately. Two parts, and they are different in kind: the
// readiness check is a hypothesis about WHAT the wait is for, and the gap is the
// only thing that was actually measured.
describe('the wait before adding to a slot', () => {
  test('is skipped entirely when the slot is empty', async () => {
    const { res, state } = await upload({ honours: 1, count: 0 });
    expect(res.settleMs).toBe(0);
    expect(state.slotChecks).toBe(0);
  });

  test('waits for every thumbnail to carry its own controls', async () => {
    const { res } = await upload({ honours: 2, count: 1, readyAfter: 3 });
    // Three polls of half a second before the slot reported itself committed.
    expect(res.settleMs).toBeGreaterThanOrEqual(3 * 500);
  });

  // The part with evidence behind it. The gap is owed only against an upload THIS
  // run made: an image that was already in the slot could be minutes old, and
  // waiting half a minute for it would be waiting for nothing.
  const second = async (opts) => {
    const { driver, state } = load({ honours: 1, ...opts });
    await driver.uploadScreenshot(1, B64, 'p1.png');
    state.pending = null;
    state.fills = 0;
    const res = await driver.uploadScreenshot(1, B64, 'p2.png');
    return { res, state };
  };

  test('is not owed to an image that was already there', async () => {
    const { res } = await upload({ honours: 2, count: 1 });
    expect(res.settleMs).toBeLessThan(1000);
  });

  test('but is owed after an upload of our own', async () => {
    const { res } = await second({});
    expect(res.settleMs).toBeGreaterThanOrEqual(GAP_MS);
    expect(res.settleMs).toBeLessThan(GAP_MS + 2000);
  });

  // A page that cannot answer the readiness question must not skip the gap: the
  // gap is the part the runs measured, and the observable is the guess.
  test('a slot that cannot be read still waits out the gap', async () => {
    const { res, state } = await second({ slotState: false });
    expect(state.slotChecks).toBe(1);
    expect(res.settleMs).toBeGreaterThanOrEqual(GAP_MS);
  });

  test('the gap is reported, so it can be lowered against evidence', async () => {
    const { res } = await upload({ honours: 2, count: 1 });
    expect(typeof res.settleMs).toBe('number');
  });

  // A failure carries both — the two things needed to tell "the gap was too
  // short" from "the page never takes this file".
  test('and a failure reports it alongside the slot state', async () => {
    const { res } = await upload({ honours: null, count: 1 });
    expect(typeof res.settleMs).toBe('number');
    expect(res.slot).toMatchObject({ ok: true });
  });
});

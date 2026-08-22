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
function load({ answers = 1, delay = 0, count = 0, applyResult = null } = {}) {
  const state = { count, applied: [], polls: 0, pending: null };

  const sandbox = {
    console,
    setTimeout: (fn) => { fn(); return 0; },
    getComputedStyle: () => ({}),
    document: { querySelectorAll: () => [] },
    location: { href: '' },
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    chrome: {
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

  test('reaches the drop when only a drop is answered', async () => {
    const { res, state } = await upload({ answers: 2 });
    expect(res).toMatchObject({ ok: true, via: 2 });
    expect(state.applied).toEqual([1, 2]);
  });

  test('and the blur sequence when only that is', async () => {
    const { res, state } = await upload({ answers: 3 });
    expect(res).toMatchObject({ ok: true, via: 3 });
    expect(state.applied).toEqual([1, 2, 3]);
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
    expect(state.applied).toEqual([1, 2, 3]);
    expect(res.tried.map((t) => t.mechanism)).toEqual([1, 2, 3]);
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

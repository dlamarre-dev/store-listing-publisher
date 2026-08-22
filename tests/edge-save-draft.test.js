/**
 * @jest-environment jsdom
 */
// Finding Partner Center's "Save draft" control.
//
// This is the step that blocks every real run: each language has its own page and
// leaving one discards what was typed into it, so a description that is written
// and not saved is lost silently. Two attempts failed to find the control, and the
// second returned `candidates: []` on a page Microsoft's own documentation says
// carries a "Save draft" in its upper right.
//
// Both failures were in the search, not the page, and both are pinned here:
//
//   - the name was read as `aria-label || textContent`, so an icon-only command
//     bar button — labelled by `title` or `aria-labelledby`, as command bars
//     usually are — came back with an empty name and was dropped;
//   - the diagnostic meant to explain the failure filtered itself on the same
//     words that had just failed to match, so it could not tell "nothing here"
//     from "here, but unnamed" and reported the emptier of the two.
//
// A real DOM rather than a stub, because the whole class of bug is a wrong belief
// about DOM semantics, which a stub written from the same belief would reproduce.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPTS = ['lib/locales.js', 'stores/cws.js', 'stores/edge.js'];

// jsdom has no layout, so getClientRects() is always empty and the driver's
// visibility test would reject the whole page. Anything not explicitly marked
// counts as on screen here; visibility itself is not what these tests are about.
function loadPageFns(html) {
  document.body.innerHTML = html;
  Element.prototype.getClientRects = function getClientRects() {
    return this.hasAttribute('data-offscreen') ? [] : [{ width: 10, height: 10 }];
  };

  const sandbox = {
    chrome: { scripting: { executeScript: async () => [{ result: null }] } },
    document,
    getComputedStyle: (el) => window.getComputedStyle(el),
    location: { href: 'https://partner.microsoft.com/dashboard' },
    Node,
    setTimeout: (fn) => { fn(); return 0; },
    console,
  };
  const sources = SCRIPTS.map(
    (f) => fs.readFileSync(path.join(__dirname, '..', 'extension', f), 'utf8'));
  sources.push('globalThis.__pages = { pageSaveDraft, pageProbe };');
  vm.runInContext(sources.join('\n;\n'), vm.createContext(sandbox),
                  { filename: 'stores/*.js' });
  return sandbox.__pages;
}

// One capture listener on the document, not one per element: clicks bubble, so
// per-element marking credits <html> as well as the button, and jsdom keeps the
// same document across the tests in a file, so those listeners accumulate.
let clickTarget = null;
document.addEventListener('click', (e) => { clickTarget = e.target; }, true);
beforeEach(() => { clickTarget = null; });
const clicked = () => clickTarget;

describe('the name a control is found by', () => {
  test('is its aria-label', async () => {
    const { pageSaveDraft } = loadPageFns('<button aria-label="Save draft"></button>');
    expect(await pageSaveDraft()).toMatchObject({ ok: true, step: 'saved' });
    expect(clicked().tagName).toBe('BUTTON');
  });

  // The failure. A command bar button whose only label is a tooltip.
  test('or its title, which is where an icon-only button keeps it', async () => {
    const { pageSaveDraft } = loadPageFns(
      '<button title="Save draft"><svg></svg></button>');
    expect(await pageSaveDraft()).toMatchObject({ ok: true, label: 'Save draft' });
    expect(clicked()).not.toBeNull();
  });

  test('or the element aria-labelledby points at', async () => {
    const { pageSaveDraft } = loadPageFns(
      '<span id="lbl">Save draft</span><button aria-labelledby="lbl"></button>');
    expect(await pageSaveDraft()).toMatchObject({ ok: true, label: 'Save draft' });
    expect(clicked().tagName).toBe('BUTTON');
  });

  test('or the alt text of the icon inside it', async () => {
    const { pageSaveDraft } = loadPageFns(
      '<div role="button"><img alt="Save draft" src="x.png"></div>');
    expect(await pageSaveDraft()).toMatchObject({ ok: true, label: 'Save draft' });
  });
});

describe('what counts as a control', () => {
  // Partner Center's form ids say Angular Formly; its shell need not be the same
  // technology, and querySelectorAll stops at a shadow boundary.
  test('includes a button inside a shadow root', async () => {
    const { pageSaveDraft } = loadPageFns('<div id="host"></div>');
    const shadow = document.getElementById('host').attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button title="Save draft"></button>';
    shadow.querySelector('button').addEventListener(
      'click', (e) => e.target.setAttribute('data-clicked', '1'));

    expect(await pageSaveDraft()).toMatchObject({ ok: true, step: 'saved' });
    expect(shadow.querySelector('[data-clicked]')).not.toBeNull();
  });

  test('includes a div with a click affordance, not just real buttons', async () => {
    const { pageSaveDraft } = loadPageFns('<div tabindex="0">Save draft</div>');
    expect(await pageSaveDraft()).toMatchObject({ ok: true, step: 'saved' });
    expect(clicked().tagName).toBe('DIV');
  });

  test('but not a hidden one', async () => {
    const { pageSaveDraft } = loadPageFns(
      '<button data-offscreen title="Save draft"></button>');
    expect(await pageSaveDraft()).toMatchObject({ ok: false, step: 'no-save-control' });
  });
});

describe('when there is no save control', () => {
  const PAGE = `
    <button title="Add a language"></button>
    <a href="/x">Availability</a>
    <div role="button" aria-label="Delete screenshot"></div>
    <button aria-label="Publish"></button>`;

  // The bug that cost a round trip: the diagnostic filtered on save|close|submit|
  // draft|apply|done, the same words the search had just failed on, so it came
  // back empty exactly when it was needed.
  test('every named control is listed, unfiltered', async () => {
    const { pageSaveDraft } = loadPageFns(PAGE);
    const out = await pageSaveDraft();
    expect(out.candidates.map((c) => c.name).sort())
      .toEqual(['Add a language', 'Availability', 'Delete screenshot', 'Publish']);
  });

  // So that an empty list can be read: nothing here, or here but unreadable?
  test('and the counts say whether the page or the reader came up empty', async () => {
    const { pageSaveDraft } = loadPageFns('<button></button><button></button>');
    const out = await pageSaveDraft();
    expect(out.candidates).toEqual([]);
    expect(out.clickable).toBe(2);
    expect(out.unnamed).toBe(2);
  });

  // executeScript runs in the top frame only, so a control in an iframe is a
  // different fix — reachable, but not by widening a selector.
  test('and frames are reported rather than searched', async () => {
    const { pageSaveDraft } = loadPageFns('<iframe src="/inner" name="app"></iframe>');
    const out = await pageSaveDraft();
    expect(out.frames).toEqual([{ src: '/inner', name: 'app' }]);
  });
});

describe('a Save that is greyed out', () => {
  // Partner Center disables it when nothing changed, which means the field already
  // held what we were about to write. Aborting there would stop a 43-language run
  // over a page that is already in the state we wanted.
  test('reads as nothing to save, not as a failure', async () => {
    const { pageSaveDraft } = loadPageFns('<button title="Save draft" disabled></button>');
    expect(await pageSaveDraft()).toMatchObject({ ok: true, step: 'nothing-to-save' });
    expect(clicked()).toBeNull();
  });
});

describe('the probe', () => {
  // The probe is how the next unknown control gets found, so it has to read names
  // the same way — a probe blind to icon-only buttons sends the operator back for
  // a second dump that is just as empty as the first.
  test('reads the same names the save step does', async () => {
    const { pageProbe } = loadPageFns(
      '<button title="Save draft"></button><button aria-label="Publish"></button>');
    expect(pageProbe().buttons.sort()).toEqual(['Publish', 'Save draft']);
  });

  test('and reports what it walked', async () => {
    const { pageProbe } = loadPageFns('<div id="h"></div><button></button>');
    document.getElementById('h').attachShadow({ mode: 'open' });
    const { shell } = pageProbe();
    expect(shell.shadowRoots).toBe(1);
    expect(shell.clickable).toBe(1);
    expect(shell.unnamed).toBe(1);
  });
});

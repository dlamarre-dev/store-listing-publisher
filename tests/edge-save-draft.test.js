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

describe('the wording it will accept', () => {
  const finds = async (html) => {
    const { pageSaveDraft } = loadPageFns(html);
    return pageSaveDraft();
  };

  test.each(['Save draft', 'Save', 'Save as draft', 'Save and continue'])(
    'accepts "%s"', async (label) => {
      expect(await finds(`<button title="${label}"></button>`))
        .toMatchObject({ ok: true, step: 'saved', label });
    });

  // A save that also submits is not a save for our purposes: sending a listing
  // for certification is edge_publish.py's job, and the human review before it is
  // the whole point of keeping the two apart.
  test.each(['Save and publish', 'Save and submit'])(
    'refuses "%s"', async (label) => {
      expect(await finds(`<button title="${label}"></button>`))
        .toMatchObject({ ok: false, step: 'no-save-control' });
    });

  test('prefers the exact wording when the page offers both', async () => {
    const out = await finds(
      '<button title="Save and continue"></button><button title="Save draft"></button>');
    expect(out.label).toBe('Save draft');
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

  // The bug that cost the first round trip: the diagnostic filtered on save|close|
  // submit|draft|apply|done, the same words the search had just failed on, so it
  // came back empty exactly when it was needed.
  test('every control is listed, unfiltered', async () => {
    const { pageSaveDraft } = loadPageFns(PAGE);
    const names = (await pageSaveDraft()).candidates
      .map((line) => line.split(' :: ')[1]).sort();
    expect(names)
      .toEqual(['Add a language', 'Availability', 'Delete screenshot', 'Publish']);
  });

  // The bug that cost the second: only the *named* controls were listed, and the
  // real page had 19 nameless ones — the one place a save button could still be.
  test('including the ones with no name at all', async () => {
    const { pageSaveDraft } = loadPageFns('<button></button><button title="Publish"></button>');
    const out = await pageSaveDraft();
    expect(out.candidates).toHaveLength(2);
    expect(out.candidates.some((l) => l.endsWith('(no name)'))).toBe(true);
    expect(out.clickable).toBe(2);
    expect(out.unnamed).toBe(1);
  });

  // The question that decides the next move. If the words are in the DOM, the
  // chain up to the nearest clickable ancestor — marked * — is the selector to
  // write; if they are nowhere, this page has no save of its own and a better
  // selector cannot help.
  //
  // The case that matters is a control whose own name is something else, so the
  // name match cannot reach it while the label sits in plain sight inside it.
  test('a save label inside a differently-named control marks that control', async () => {
    const { pageSaveDraft } = loadPageFns(
      '<div role="button" aria-label="Commands"><span class="lbl">Save draft</span></div>');
    const out = await pageSaveDraft();
    expect(out.step).toBe('no-save-control');
    expect(out.saveWords[0].chain).toMatch(/^SPAN\.lbl < DIV\* </);
  });

  test('a save label with no clickable ancestor is still reported', async () => {
    const { pageSaveDraft } = loadPageFns(
      '<div class="bar"><span class="lbl">Save draft</span></div>');
    const out = await pageSaveDraft();
    expect(out.saveWords).toHaveLength(1);
    expect(out.saveWords[0].text).toBe('Save draft');
    expect(out.saveWords[0].chain).toMatch(/^SPAN\.lbl < DIV\.bar </);
    expect(out.saveWords[0].chain).not.toMatch(/\*/);
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

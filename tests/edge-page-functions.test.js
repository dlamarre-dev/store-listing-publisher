/**
 * @jest-environment jsdom
 */
// The Partner Center page functions, against a real DOM.
//
// A real DOM rather than a stub, because every bug this file pins is a wrong
// belief about DOM semantics — and a stub written from the same belief would
// reproduce it faithfully. Three controls have now been missed by a selector
// narrower than the page.
//
// ── Finding "Save draft" ─────────────────────────────────────────────────────
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
    // Host objects the vm realm does not carry. jsdom has no working
    // DataTransfer, so it gets the smallest one that behaves: a list a File goes
    // into and comes out of, which is all the upload path uses it for.
    Event: window.Event,
    File: window.File,
    Blob: window.Blob,
    atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
    DataTransfer: class {
      constructor() {
        const files = [];
        this.files = files;
        this.items = { add: (f) => files.push(f) };
      }
    },
  };
  const sources = SCRIPTS.map(
    (f) => fs.readFileSync(path.join(__dirname, '..', 'extension', f), 'utf8'));
  sources.push('globalThis.__pages = { pageSaveDraft, pageProbe, pageUploadScreenshot,'
    + ' pageCountScreenshots, pageDeleteOneScreenshot, pageDuplicateScreenshots };');
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

// Partner Center's command bar, reduced to its shape:
//   <v6_he-button>  <span>Save draft</span>            light DOM, carries the label
//     #shadow-root  <button><slot></slot></button>     the real control
// textContent finds the words on neither element — the host has them but is not a
// button, the button has a <slot> and no words.
function commandBarButton(label, opts) {
  document.body.innerHTML = `<command-bar><div class="button-group">
    <v6_he-button class="he-button"><span>${label}</span></v6_he-button>
  </div></command-bar>`;
  const host = document.querySelector('v6_he-button');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<button ${(opts || {}).disabled ? 'disabled' : ''}><slot></slot></button>`;
  return { host, inner: shadow.querySelector('button') };
}

describe('a command bar built out of web components', () => {
  test('is named by the label slotted into it', async () => {
    const { pageSaveDraft } = loadPageFns('');
    commandBarButton('Save draft');
    expect(await pageSaveDraft()).toMatchObject({ ok: true, step: 'saved', label: 'Save draft' });
  });

  // The host carries the name; the handler is on the control inside. Clicking the
  // host alone dispatches an event the component never listens for — a save that
  // silently does nothing, which is the exact failure this step exists to prevent.
  test('is clicked on the control inside, not only on the host', async () => {
    const { pageSaveDraft } = loadPageFns('');
    const { inner } = commandBarButton('Save draft');
    let pressed = 0;
    inner.addEventListener('click', () => { pressed += 1; });
    await pageSaveDraft();
    expect(pressed).toBe(1);
  });

  test('and a greyed-out inner control still reads as nothing to save', async () => {
    const { pageSaveDraft } = loadPageFns('');
    commandBarButton('Save draft', { disabled: true });
    expect(await pageSaveDraft()).toMatchObject({ ok: true, step: 'nothing-to-save' });
  });

  test('the probe sees it too', async () => {
    const { pageProbe } = loadPageFns('');
    commandBarButton('Save draft');
    expect(pageProbe().buttons).toContain('Save draft');
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

describe('the probe and the four asset slots', () => {
  // Each slot — logo, small tile, screenshots, large tile — owns a file input, and
  // an earlier dump found only two of them. That dump used a flat query against a
  // page that keeps its controls inside web components: the others were out of
  // scope, not absent. Two hidden inputs with identical `accept` are then told
  // apart by where they live, which is what chain and label report.
  const slot = (caption) => {
    const host = document.createElement('asset-upload');
    host.innerHTML = `<h3>${caption}</h3>`;
    document.body.appendChild(host);
    host.attachShadow({ mode: 'open' }).innerHTML =
      '<div class="drop"><input type="file" accept=".png"></div>';
    return host;
  };

  test('finds a file input inside a component, not just the light-DOM ones', () => {
    const { pageProbe } = loadPageFns('<input type="file" accept=".png">');
    slot('Screenshots');
    expect(pageProbe().fileInputs).toHaveLength(2);
  });

  test('and reports the component chain above each one', () => {
    const { pageProbe } = loadPageFns('');
    slot('Screenshots');
    const [input] = pageProbe().fileInputs;
    expect(input.chain).toMatch(/^INPUT < DIV\.drop < ASSET-UPLOAD/);
  });

  test('and the caption beside it, which is what tells the slots apart', () => {
    const { pageProbe } = loadPageFns('');
    slot('Store logo');
    slot('Screenshots');
    expect(pageProbe().fileInputs.map((f) => f.label))
      .toEqual(['Store logo', 'Screenshots']);
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

// ── the screenshot slot ──────────────────────────────────────────────────────
//
// A details page carries four asset slots — logo, small tile, screenshots, large
// tile — that are identical from the outside: the same hidden INPUT.fileuploader
// with accept=".png", the same Magnify / Delete / Duplicate trio, no aria-label
// naming any of them. The probe of a real French page showed the one thing that
// separates them, the component each lives in:
//
//   INPUT.fileuploader < FORM < SCREENSHOTS < …
//   INPUT.fileuploader < FORM < DIV.row.form-group-tall < … < SECTION.section
//
// So these tests are all about scope. A step that reaches outside <screenshots>
// can put a screenshot in the logo slot, and no assertion about the happy path
// would notice.
describe('the screenshot slot', () => {
  const page = ({ shots = 0, withSlot = true } = {}) => {
    const thumb = (n, alt) => `<div class="asset"><img alt="${alt}" src="x.png">
      <button aria-label="Magnify"></button><button aria-label="Delete"></button></div>`;
    const inside = Array.from({ length: shots }, (_, i) => thumb(i, `Screenshot shot${i}.png`))
      .join('')
      + (shots ? '<button>Duplicate this screenshot for all languages</button>' : '')
      + '<form><input type="file" class="fileuploader" accept=".png"></form>';

    // The logo slot: same controls, same input, different component. Nothing here
    // may ever be counted, clicked or filled.
    const logo = `<section class="section"><div class="row form-group-tall">
      <img alt="Extension Store logo icon128.png" src="l.png">
      <button aria-label="Magnify"></button><button aria-label="Delete"></button>
      <button>Duplicate this logo for all languages</button>
      <form><input type="file" class="fileuploader" accept=".png"></form>
    </div></section>`;

    document.body.innerHTML = logo + (withSlot ? `<screenshots>${inside}</screenshots>` : '');
    document.querySelectorAll('img').forEach((img) => {
      Object.defineProperty(img, 'clientWidth', { value: 200, configurable: true });
    });
    document.querySelectorAll('input[type="file"]').forEach((inp) => {
      Object.defineProperty(inp, 'files', { value: null, writable: true, configurable: true });
    });
  };

  test('counts only what is in it', () => {
    const { pageCountScreenshots } = loadPageFns('');
    page({ shots: 2 });
    expect(pageCountScreenshots()).toMatchObject({ ok: true, count: 2 });
  });

  test('and reports the filenames, which is how a re-run knows what is there', () => {
    const { pageCountScreenshots } = loadPageFns('');
    page({ shots: 2 });
    expect(pageCountScreenshots().files)
      .toEqual(['Screenshot shot0.png', 'Screenshot shot1.png']);
  });

  test('uploading fills the slot input, never the logo one', () => {
    const { pageUploadScreenshot } = loadPageFns('');
    page();
    const b64 = Buffer.from('PNGDATA').toString('base64');
    expect(pageUploadScreenshot(b64, 'Promo_1_fr.png'))
      .toMatchObject({ ok: true, filename: 'Promo_1_fr.png' });

    const [logoInput, slotInput] = document.querySelectorAll('input[type="file"]');
    expect(logoInput.files).toBeNull();
    expect(slotInput.files[0].name).toBe('Promo_1_fr.png');
  });

  test('deleting clicks a Delete inside the slot, not the logo Delete', async () => {
    const { pageDeleteOneScreenshot } = loadPageFns('');
    page({ shots: 1 });
    const logoDelete = document.querySelector('section [aria-label="Delete"]');
    let logoClicks = 0;
    logoDelete.addEventListener('click', () => { logoClicks += 1; });
    // The page removes the thumbnail, which is what the step waits for — it polls
    // the count rather than trusting the click, because Partner Center removes it
    // asynchronously and a loop that trusted the click would spin on a stale DOM.
    document.querySelector('screenshots [aria-label="Delete"]')
      .addEventListener('click', (e) => e.target.closest('.asset').remove());

    expect(await pageDeleteOneScreenshot()).toMatchObject({ ok: true, before: 1, after: 0 });
    expect(logoClicks).toBe(0);
  });

  test('duplicating presses the slot button, not the logo one', async () => {
    const { pageDuplicateScreenshots } = loadPageFns('');
    page({ shots: 1 });
    let pressed = null;
    document.addEventListener('click', (e) => { pressed = e.target.textContent; }, true);
    await pageDuplicateScreenshots();
    expect(pressed).toBe('Duplicate this screenshot for all languages');
  });

  // The refusal that matters. Without the component there is no way to tell the
  // four inputs apart, and picking one is how a screenshot lands in the logo slot.
  test('every step refuses when the component is not on the page', async () => {
    const fns = loadPageFns('');
    page({ withSlot: false });
    expect(fns.pageCountScreenshots()).toMatchObject({ ok: false, step: 'no-screenshot-slot' });
    expect(fns.pageUploadScreenshot('AAA=', 'x.png'))
      .toMatchObject({ ok: false, step: 'no-screenshot-slot' });
    expect(await fns.pageDeleteOneScreenshot())
      .toMatchObject({ ok: false, step: 'no-screenshot-slot' });
    expect(await fns.pageDuplicateScreenshots())
      .toMatchObject({ ok: false, step: 'no-screenshot-slot' });
  });

  test('and the refusal shows the inputs it would not choose between', () => {
    const { pageUploadScreenshot } = loadPageFns('');
    page({ withSlot: false });
    const out = pageUploadScreenshot('AAA=', 'x.png');
    expect(out.fileInputs).toHaveLength(1);
    expect(out.fileInputs[0].chain).toMatch(/SECTION/);
  });
});

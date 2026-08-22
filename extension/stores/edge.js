// Microsoft Partner Center driver for the Store Listing Publisher.
//
// The Edge Add-ons API can upload a package and publish a submission but has no
// listing metadata at all, so the localized description and screenshots are only
// reachable by driving Partner Center — same situation as the Chrome Web Store,
// and the reason this file exists next to stores/cws.js.
//
// Written against real dumps of both pages, not against guesses. Only
// uploadScreenshot still refuses, for a reason stated where it refuses.
//
// How this store differs from the CWS, all of it confirmed on the page:
//
// - **There is no language dropdown.** Store listings is a TABLE, one row per
//   language, and each row's button — aria-labelled "Edit <Language> language
//   details page" — opens a separate "Details for <language>" page. So
//   selectLanguage is a navigation, not an in-place pick.
// - **A language must be ADDED before it exists.** The package only makes one
//   *available*: a product with 43 locales in its zip still shows one row until
//   the others are added from the "Add a language" menu. This surprises everyone
//   once, including Microsoft's own troubleshooting page.
// - **Partner Center's language names are not always ours.** It writes Bangla for
//   Bengali, Kiswahili for Swahili, Norwegian (Bokmål) for Norwegian — so every
//   lookup here passes languageNames(locale), never locale.name alone.
// - **Filipino is not on the menu at all.** 41 languages are offered; ours that
//   is missing cannot have an Edge listing, which is a store limit and not a
//   lookup failure, so pageAddLanguage says so in those words.
// - The description is a plain <textarea> (aria-label "Description ", with the
//   trailing space) and there is no contenteditable, so the CWS write path
//   transfers unchanged. Its maxlength is 10000, which is checked BEFORE writing:
//   a browser truncates at maxlength silently, and a listing ending mid-sentence
//   is worse than an aborted run.
// - **"Duplicate these screenshots for all languages"** is a real button. It is
//   why 43 languages do not need 215 uploads — fill one, press it once. Nothing
//   else in this file saves as much.
// - Saving is "Save draft", upper right. Publishing is a separate button on the
//   Store listings page, and this driver will never press it — the API does that
//   (edge/edge_publish.py --publish), and reviewing before submitting stays human.
//
// languageNames() comes from lib/locales.js, which the manifest must load BEFORE
// this file.

const EDGE = {
  BASE: 'https://partner.microsoft.com/dashboard/microsoftedge',
  // Partner Center bounces through Entra ID, so a login redirect can land on
  // either host.
  LOGIN_RE: /login\.microsoftonline\.com|login\.live\.com|\/public\/login/i,
};

// ── page functions (serialised — self-contained) ─────────────────────────────

// Diagnostic dump of everything a driver for this page would need to find.
//
// Deliberately a superset of the CWS probe: Partner Center is a navigation-driven
// SPA, so this also collects anchors and table structure. The listing lives
// behind a link and a per-row button rather than a dropdown, and the exact paths
// are not documented — the anchors are how we learn them instead of guessing.
function pageProbe() {
  const visible = el => {
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0;
  };
  const txt = el => (el.textContent || '').replace(/\s+/g, ' ').trim();
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]'))
    .filter(visible).filter(h => { const t = txt(h); return t && t.length < 80; });
  const trail = el => headings
    .filter(h => h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
    .map(txt);

  const textareas = Array.from(document.querySelectorAll('textarea')).map(ta => ({
    visible: visible(ta),
    ariaLabel: ta.getAttribute('aria-label'),
    id: ta.id || null,
    maxLength: ta.getAttribute('maxlength'),
    size: `${ta.clientWidth}x${ta.clientHeight}`,
    valueStart: (ta.value || '').slice(0, 60),
    valueLength: (ta.value || '').length,
    trail: trail(ta).slice(-3),
  }));

  // Partner Center's description box may well be a rich-text editor rather than
  // a <textarea>, which would change the write path entirely — so look for one.
  const editables = Array.from(document.querySelectorAll('[contenteditable="true"]'))
    .filter(visible)
    .map(el => ({
      role: el.getAttribute('role'),
      ariaLabel: el.getAttribute('aria-label'),
      size: `${el.clientWidth}x${el.clientHeight}`,
      textStart: txt(el).slice(0, 60),
      trail: trail(el).slice(-3),
    }));

  const inputs = Array.from(document.querySelectorAll('input')).filter(visible).map(inp => ({
    type: inp.type,
    ariaLabel: inp.getAttribute('aria-label'),
    placeholder: inp.getAttribute('placeholder'),
    id: inp.id || null,
    trail: trail(inp).slice(-2),
  })).slice(0, 40);

  const fileInputs = Array.from(document.querySelectorAll('input[type="file"]')).map(inp => ({
    accept: inp.getAttribute('accept'),
    multiple: inp.multiple,
    hidden: !visible(inp),
    trail: trail(inp).slice(-3),
  }));

  // The language table: how many rows, what each row says, and what its buttons
  // are called. This is the thing the CWS has no equivalent of.
  const tables = Array.from(document.querySelectorAll('table, [role="grid"], [role="table"]'))
    .filter(visible)
    .map(t => {
      const rows = Array.from(t.querySelectorAll('tr, [role="row"]'));
      return {
        rowCount: rows.length,
        headerCells: Array.from(t.querySelectorAll('th, [role="columnheader"]')).map(txt),
        firstRows: rows.slice(0, 4).map(r => ({
          cells: Array.from(r.querySelectorAll('td, th, [role="cell"], [role="gridcell"]'))
            .map(c => txt(c).slice(0, 40)),
          buttons: Array.from(r.querySelectorAll('button, [role="button"], a'))
            .map(b => (b.getAttribute('aria-label') || txt(b)).slice(0, 40))
            .filter(Boolean),
        })),
        trail: trail(t).slice(-2),
      };
    });

  // Anchors, so the real URL of the Store listings page and of a per-language
  // page can be read off the nav instead of guessed.
  const links = Array.from(document.querySelectorAll('a[href]'))
    .filter(visible)
    .map(a => ({ text: txt(a).slice(0, 40), href: a.getAttribute('href') }))
    .filter(l => l.href && !l.href.startsWith('#'))
    .filter(l => /microsoftedge|listing|package|availability|propert|privacy/i
      .test(l.href + ' ' + l.text))
    .slice(0, 50);

  const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
    .filter(visible)
    .map(b => (b.getAttribute('aria-label') || txt(b)).slice(0, 50))
    .filter(Boolean)
    .slice(0, 80);

  const images = Array.from(document.querySelectorAll('img'))
    .filter(visible).filter(i => i.clientWidth >= 40)
    .slice(0, 30)
    .map(i => ({ size: `${i.clientWidth}x${i.clientHeight}`, alt: i.alt || null,
                 trail: trail(i).slice(-2) }));

  return {
    url: location.href,
    title: document.title,
    headings: headings.map(txt).slice(0, 80),
    tables, links, textareas, editables, inputs, fileInputs, images, buttons,
  };
}

// Opens the "Add a language" control and dumps its options, then closes it.
//
// A separate function because it CLICKS, and a probe that clicks should say so in
// its name. It exists because the alternative does not work: opening the popup
// moves focus out of the page, and a menu that closes on blur is gone before the
// probe runs — so the operator cannot hold it open for us. Opening it from inside
// the page is the only reliable way to see what is in it.
//
// The options are what an add-the-missing-42-languages step needs: how Partner
// Center names each language, so our locale table can be matched against it.
async function pageProbeAddLanguage() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = el => {
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0;
  };
  const txt = el => (el.textContent || '').replace(/\s+/g, ' ').trim();
  const label = el => (el.getAttribute('aria-label') || txt(el)).trim();

  const control = Array.from(document.querySelectorAll(
    'button, [role="button"], select, [role="combobox"], input'))
    .filter(visible)
    .find(el => /add a language/i.test(label(el))
             || /add a language/i.test(el.getAttribute('placeholder') || ''));

  if (!control) {
    return { ok: false, step: 'no-add-language-control',
             detail: 'No "Add a language" control on this page. Is this the Store '
               + 'listings page?' };
  }

  const describe = el => ({
    tag: el.tagName,
    role: el.getAttribute('role'),
    ariaLabel: el.getAttribute('aria-label'),
    expanded: el.getAttribute('aria-expanded'),
    controls: el.getAttribute('aria-controls'),
  });
  const beforeControl = describe(control);

  // A native <select> needs no opening: its options are already in the DOM.
  if (control.tagName === 'SELECT') {
    return {
      ok: true, kind: 'select', control: beforeControl,
      options: Array.from(control.options).map(o => ({ value: o.value, text: txt(o) })),
    };
  }

  control.click();
  await sleep(1200);

  const optionEls = Array.from(document.querySelectorAll(
    '[role="option"], [role="menuitem"], [role="menuitemradio"], li, option'))
    .filter(visible)
    .filter(el => { const t = txt(el); return t && t.length < 60; });

  const result = {
    ok: true,
    kind: 'menu',
    control: describe(control),
    optionCount: optionEls.length,
    // No slice: the first dump truncated at 80 and hid one language, which is
    // exactly the kind of gap that costs a round trip to notice.
    options: optionEls.map(el => ({
      tag: el.tagName,
      role: el.getAttribute('role'),
      text: txt(el),
      value: el.getAttribute('value') || el.getAttribute('data-value') || null,
      ariaLabel: el.getAttribute('aria-label'),
    })),
    // Where the options live, so the option lookup can be scoped rather than
    // matching anything on the page that happens to look like a list item.
    containers: [...new Set(optionEls.map(el => {
      const p = el.closest('[role="listbox"], [role="menu"], ul, div[id]');
      return p ? `${p.tagName}${p.id ? '#' + p.id : ''}[role=${p.getAttribute('role')}]` : '(none)';
    }))].slice(0, 6),
  };

  // Put the page back as it was: a probe must not leave a menu hanging open.
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(200);
  return result;
}

// Reads the Store listings table: which languages have been ADDED, and what
// state each is in.
//
// Confirmed against a real dump. The table's columns are Language / Status /
// Extension name / Description / Extension logo / Action, and each row carries
// two buttons whose aria-labels embed the language name in English:
//
//     "Edit English language details page"
//     "Remove English language"
//
// That English name is exactly what the locale table already holds in `name` —
// it was there for the CWS dropdown — so nothing new has to be configured.
//
// The distinction that matters: the package makes a language AVAILABLE, it does
// not add it. A fresh product lists one row even with 43 locales in the zip,
// which is the store's model and not a fault in the package.
function pageListLanguages() {
  const visible = el => {
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0;
  };
  const txt = el => (el.textContent || '').replace(/\s+/g, ' ').trim();
  const label = el => (el.getAttribute('aria-label') || txt(el));

  const EDIT_RE = /^Edit\s+(.+?)\s+language details page$/i;
  const rows = [];
  for (const el of document.querySelectorAll('button, [role="button"], a')) {
    if (!visible(el)) continue;
    const m = EDIT_RE.exec(label(el).trim());
    if (!m) continue;
    const row = el.closest('tr, [role="row"]');
    const cells = row
      ? Array.from(row.querySelectorAll('td, th, [role="cell"], [role="gridcell"]')).map(txt)
      : [];
    rows.push({ language: m[1], status: cells[1] || '', cells: cells.slice(0, 2) });
  }

  const addControl = Array.from(document.querySelectorAll(
    'button, [role="button"], select, [role="combobox"]'))
    .filter(visible)
    .find(el => /add a language/i.test(label(el)));

  return {
    ok: true,
    languages: rows,
    canAdd: !!addControl,
    addLabel: addControl ? label(addControl).trim() : null,
  };
}

// Adds a language to the listing, from the "Add a language" menu.
//
// The package makes a language available; this is what puts it in the table. The
// menu is a `UL[role="menu"]` whose entries come in pairs — an `LI` wrapper and
// an `A[role="option"]` carrying the same text — so the anchor is the clickable
// one and the wrapper would be a no-op.
//
// `names` is every label the locale might go by, because Partner Center does not
// always use the name we do: it says Bangla for Bengali, Kiswahili for Swahili,
// and Norwegian (Bokmål) where we say Norwegian.
async function pageAddLanguage(names) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = el => {
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0;
  };
  const txt = el => (el.textContent || '').replace(/\s+/g, ' ').trim();
  const label = el => (el.getAttribute('aria-label') || txt(el)).trim();
  const wanted = names.map(n => String(n).toLowerCase());

  const control = Array.from(document.querySelectorAll('button, [role="button"]'))
    .filter(visible)
    .find(el => /add a language/i.test(label(el)));
  if (!control) return { ok: false, step: 'no-add-language-control' };

  control.click();
  await sleep(1200);

  const options = Array.from(document.querySelectorAll('[role="option"]')).filter(visible);
  const offered = options.map(txt);
  const target = options.find(el => wanted.includes(txt(el).toLowerCase()));

  if (!target) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return {
      ok: false,
      step: 'language-not-offered',
      wanted: names,
      offered,
      // Not every language we ship exists here — Filipino, for one, is not on the
      // menu at all. That is a store limit, not a lookup failure, and saying so
      // is the difference between "skip this locale" and "something is broken".
      detail: `Partner Center does not offer ${names[0]} for this listing. Its menu `
        + `has ${offered.length} languages, from the ${'_locales'} in the uploaded `
        + 'package — a language missing from it cannot be added at all.',
    };
  }

  const added = txt(target);
  target.click();
  await sleep(1500);
  return { ok: true, added, url: location.href };
}

// Opens a language's "Details for <language>" page by clicking its row button.
//
// This store has no in-place language switch, so this is a NAVIGATION. It
// verifies it actually moved before reporting success — the CWS driver refuses on
// an unconfirmed switch rather than writing into the wrong locale, and the same
// rule matters more here, where the wrong page is a different URL entirely.
async function pageOpenLanguage(names) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = el => {
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0;
  };
  const txt = el => (el.textContent || '').replace(/\s+/g, ' ').trim();
  const label = el => (el.getAttribute('aria-label') || txt(el)).trim();

  // Every label the locale might go by, not just our own name for it: Partner
  // Center writes Norwegian (Bokmål) where our table says Norwegian, so matching
  // on one name alone silently fails on the locales that need an alias most.
  const wanted = names.map(n => String(n).toLowerCase());
  const EDIT_RE = /^Edit\s+(.+?)\s+language details page$/i;

  const candidates = Array.from(document.querySelectorAll('button, [role="button"], a'))
    .filter(visible)
    .map(el => ({ el, m: EDIT_RE.exec(label(el)) }))
    .filter(x => x.m);

  const seen = candidates.map(x => x.m[1]);
  const target = candidates.find(x => wanted.includes(x.m[1].toLowerCase()));

  if (!target) {
    return {
      ok: false,
      step: 'language-not-added',
      wanted: names,
      languagesPresent: seen,
      // The single most confusing thing about this store, so say it here rather
      // than let it read as "the page is broken".
      detail: `${names[0]} is not in the Store listings table. The package makes a `
        + 'language available; it still has to be added from the "Add a language" '
        + 'menu before it has a details page.',
    };
  }

  const before = location.href;
  target.el.click();
  for (let i = 0; i < 20; i++) {
    await sleep(400);
    if (location.href !== before) break;
  }
  const heading = Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"]'))
    .filter(visible).map(txt).find(t => /details for/i.test(t)) || '';
  const confirmed = location.href !== before || /details for/i.test(heading);

  return { ok: true, selected: target.m[1], confirmed, url: location.href, heading };
}

// Writes the localized description.
//
// There is exactly one <textarea> on a details page and no contenteditable, so
// the CWS approach transfers unchanged: set through the native value setter and
// fire input/change so the SPA registers it. Its aria-label is "Description "
// with a trailing space, hence the trim.
//
// It checks maxlength BEFORE writing. Partner Center caps the field at 10,000,
// and a browser silently truncates at maxlength rather than refusing — so
// without this a too-long description becomes a listing that ends mid-sentence,
// which is far worse than an aborted run.
function pageSetDescription(text, apply) {
  const visible = el => {
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0;
  };
  const tas = Array.from(document.querySelectorAll('textarea')).filter(visible);
  const described = tas.filter(
    ta => /^description$/i.test((ta.getAttribute('aria-label') || '').trim()));

  if (!described.length) {
    return {
      ok: false,
      step: 'no-description-field',
      textareasSeen: tas.map(ta => (ta.getAttribute('aria-label') || '').trim()),
      detail: 'No textarea labelled "Description" here. Is this a "Details for '
        + '<language>" page rather than the Store listings table?',
    };
  }
  if (described.length > 1) {
    return { ok: false, step: 'ambiguous-description-field', count: described.length };
  }

  const ta = described[0];
  const max = parseInt(ta.getAttribute('maxlength') || '0', 10) || null;
  const label = (ta.getAttribute('aria-label') || '').trim();

  if (max && text.length > max) {
    return {
      ok: false,
      step: 'description-too-long',
      length: text.length,
      max,
      detail: `The description is ${text.length} characters and the field accepts `
        + `${max}. The browser would truncate it silently, so nothing was written. `
        + 'Shorten the source text for this target.',
    };
  }

  if (!apply) {
    return { ok: true, dryRun: true, label, max, currentLength: (ta.value || '').length,
             wouldWrite: text.length };
  }

  ta.focus();
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, text);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.dispatchEvent(new Event('change', { bubbles: true }));
  ta.blur();
  return { ok: ta.value === text, step: 'done', label, length: ta.value.length, max };
}

// Counts the screenshots on a details page.
//
// Keyed on the per-image buttons, whose aria-labels carry the filename —
// "Delete screenshot Promo_1_en.png" — which also keeps the logo and the two
// promo tiles out of the count: they have bare "Delete" buttons instead.
function pageCountScreenshots() {
  const visible = el => {
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0;
  };
  const label = el => (el.getAttribute('aria-label')
    || (el.textContent || '').replace(/\s+/g, ' ')).trim();

  const names = Array.from(document.querySelectorAll('button, [role="button"]'))
    .filter(visible)
    .map(el => /^Delete screenshot\s+(.+)$/i.exec(label(el)))
    .filter(Boolean)
    .map(m => m[1]);

  return { ok: true, count: names.length, files: names, scope: 'localized' };
}

// Deletes the first screenshot, and waits for the count to actually drop.
async function pageDeleteOneScreenshot() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = el => {
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0;
  };
  const label = el => (el.getAttribute('aria-label')
    || (el.textContent || '').replace(/\s+/g, ' ')).trim();
  const deleters = () => Array.from(document.querySelectorAll('button, [role="button"]'))
    .filter(visible)
    .filter(el => /^Delete screenshot\s+/i.test(label(el)));

  const before = deleters().length;
  if (!before) return { ok: true, before: 0, after: 0, nothingToDelete: true };

  deleters()[0].click();
  await sleep(600);

  const dlg = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'))
    .find(visible);
  if (dlg) {
    const confirm = Array.from(dlg.querySelectorAll('button, [role="button"]'))
      .filter(visible)
      .find(b => /delete|remove|yes|confirm|ok/i.test(label(b)));
    if (confirm) { confirm.click(); await sleep(600); }
  }

  const deadline = Date.now() + 10000;
  let after = before;
  while (Date.now() < deadline) {
    await sleep(500);
    after = deleters().length;
    if (after < before) break;
  }
  return { ok: after < before, before, after };
}

// Copies this language's screenshots to every other language.
//
// The store's own feature, labelled exactly "Duplicate these screenshots for all
// languages". It is the reason a 43-language listing does not need 215 uploads:
// fill one language, press this once. Nothing else in this driver saves as much.
async function pageDuplicateScreenshots() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = el => {
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0;
  };
  const label = el => (el.getAttribute('aria-label')
    || (el.textContent || '').replace(/\s+/g, ' ')).trim();

  const button = Array.from(document.querySelectorAll('button, [role="button"]'))
    .filter(visible)
    .find(el => /duplicate these screenshots for all languages/i.test(label(el)));

  if (!button) {
    return {
      ok: false,
      step: 'no-duplicate-control',
      detail: 'No "Duplicate these screenshots for all languages" button here. It '
        + 'only appears once at least one screenshot has been uploaded for this '
        + 'language.',
    };
  }
  button.click();
  await sleep(2000);
  return { ok: true, step: 'duplicated' };
}

// ── driver (background context) ───────────────────────────────────────────────

async function edgeExec(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN', func, args,
  });
  return results?.[0]?.result;
}

// The steps that still need a dump of a "Details for <language>" page. Returning
// ok:false rather than nothing is what lets the orchestration abort with a
// message instead of walking into a code path built for a result.
const NOT_YET = (step, why) => ({
  ok: false,
  step: 'not-implemented',
  store: 'edge',
  detail: `The Partner Center driver cannot ${step} yet. ${why} `
    + 'Run "Probe page" and send the dump — the selectors are written against '
    + 'that, not guessed. See the notes at the bottom of stores/edge.js.',
});

// Same surface as CwsDriver, documented at the bottom of stores/cws.js.
const EdgeDriver = {
  id: 'edge',

  // Which block of config.assets holds this store's path templates.
  assetProfile: 'edge',

  // The Store listings page. `edgeListingPath` in the config overrides the tail,
  // because the exact route is not documented and the probe is how we learn it —
  // an override means finding out does not need a code change.
  listingUrl: (config, item) => {
    const productId = ((config.edge || {}).productIds || {})[item.slug] || '';
    const tail = (config.edge || {}).edgeListingPath || 'listings';
    return `${EDGE.BASE}/${productId}/${tail}`;
  },

  isLoginUrl: url => EDGE.LOGIN_RE.test(url),

  // Whether a tab belongs to this store, so a probe can reuse a page already
  // open instead of navigating away from it — which is the only way to dump a
  // language's details page. Matches the Edge dashboard and nothing else on
  // partner.microsoft.com, which also hosts unrelated programs.
  ownsUrl: url => /^https?:\/\/partner\.microsoft\.com\/.*\/microsoftedge\//.test(url),

  // One click has to be enough, so the probe also opens the "Add a language"
  // control and reports its options. On a page that has no such control — a
  // language's details page — that half reports ok:false and the rest is
  // unaffected.
  async probe(tabId) {
    const page = await edgeExec(tabId, pageProbe);
    const addLanguage = await edgeExec(tabId, pageProbeAddLanguage);
    return { ...(page || {}), addLanguage };
  },

  // Which languages have actually been added to the listing. Not part of the
  // driver interface — the orchestration does not call it — but it is how a run
  // can report "42 of your 43 are not added yet" instead of failing 42 times.
  listLanguages: tabId => edgeExec(tabId, pageListLanguages),

  // Adds a language to the listing. Not part of the driver interface — the
  // orchestration has no concept of a store where a locale must be enrolled
  // before it can be written — but it is what makes 42 of them reachable.
  addLanguage: (tabId, locale) =>
    edgeExec(tabId, pageAddLanguage, [languageNames(locale)]),

  // A navigation, not a dropdown pick: this store has no in-place switch. Passes
  // every alias, because Partner Center's name is not always ours.
  selectLanguage: (tabId, locale) =>
    edgeExec(tabId, pageOpenLanguage, [languageNames(locale)]),

  setDescription: (tabId, text, apply) =>
    edgeExec(tabId, pageSetDescription, [text, apply]),

  countScreenshots: tabId => edgeExec(tabId, pageCountScreenshots),
  deleteOneScreenshot: tabId => edgeExec(tabId, pageDeleteOneScreenshot),

  // Copies one language's screenshots to all the others — the store's own
  // feature, and the reason uploading per language is mostly unnecessary here.
  duplicateScreenshots: tabId => edgeExec(tabId, pageDuplicateScreenshots),

  // The one step still guessing would be dangerous. A details page exposes only
  // TWO hidden .png inputs for four asset slots — logo, small tile, screenshots,
  // large tile — and nothing in the dump distinguishes them. Putting a
  // screenshot in the logo slot is a bad way to find out, and duplicateScreenshots
  // removes most of the need: fill one language by hand, copy it to the rest.
  uploadScreenshot: async () => NOT_YET('upload a screenshot',
    'A "Details for <language>" page exposes only TWO hidden .png inputs for four '
    + 'asset slots — logo, small tile, screenshots, large tile — and nothing in '
    + 'the dump tells them apart. Use duplicateScreenshots instead: fill one '
    + 'language by hand and copy it to the rest. To finish this properly, probe a '
    + 'details page whose screenshots have been deleted; the input that appears '
    + 'then is the screenshots one.'),
};

// ── What the dumps settled ───────────────────────────────────────────────────
//
// Probed against a real Store listings page, 2026-08-22:
//
// - The route is right. `/listings` works; Partner Center normalises the URL to
//   /en-us/dashboard/... on its own, so isLoginUrl must not treat a locale
//   segment as a login (it does not — it looks for /public/login).
// - The table's row buttons are aria-labelled "Edit <Language> language details
//   page" and "Remove <Language> language", with the language name in English.
//   pageListLanguages and pageOpenLanguage are written against exactly that.
// - textareas, editables, inputs, fileInputs and images were ALL empty on this
//   page. Nothing to write here: every field lives behind the row button, on the
//   "Details for <language>" page. That is why the remaining steps still refuse.
// - "Add a language" exists as a control, and only ONE row (English) was present
//   despite 43 locales in the package — verified inside the zip. That is the
//   store's model, not a defect: the package makes a language AVAILABLE, adding
//   it is a separate action. Any run over 43 locales has to add 42 of them first.
//
// ── What is still needed ─────────────────────────────────────────────────────
//
// 1. A dump of a "Details for <language>" page. `textareas` vs `editables`
//    decides how the description is written: a plain textarea takes the CWS
//    approach (native value setter + input/change events), a rich-text editor
//    does not. `maxLength` there should confirm the 10,000-character cap.
// 2. A dump with the "Add a language" control open, to learn how its options are
//    rendered and how they name languages — that mapping is what an
//    add-42-languages step needs, and it is the last unknown of this page.
// 3. Screenshots: look for "Duplicate this screenshot for all languages" in the
//    Details dump. If it is there, the right shape is upload 5 once and
//    duplicate, not 215 uploads. The cap is 6, sizes 640x480 or 1280x800; ours
//    are 1280x800.
// 4. Never press Publish. That is edge/edge_publish.py's job, and the review
//    before it stays human.

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

  // Anything clickable, by affordance rather than by tag, shadow roots included.
  //
  // Two rounds of narrower queries each missed a control this page really has, so
  // the probe now matches what pageSaveDraft matches: a div with a click handler
  // is a button as far as the operator is concerned, and an icon-only command bar
  // button carries its label in `title` or `aria-labelledby`, neither of which the
  // old `aria-label || textContent` could read.
  const deepAll = (root, out) => {
    out = out || [];
    for (const el of root.querySelectorAll('*')) {
      out.push(el);
      if (el.shadowRoot) deepAll(el.shadowRoot, out);
    }
    return out;
  };
  // Text as a reader sees it, with <slot> resolved to what is slotted into it.
  //
  // Partner Center's command bar is a web component: <v6_he-button>Save draft</v6_he-button>
  // renders a real <button> inside its shadow root and slots the label in from the
  // light DOM. textContent then finds the label on neither side — the shadow button
  // holds a <slot>, not the words — which is how a visible, documented control ended
  // up among the nineteen with no name.
  const slotText = (node, depth) => {
    if ((depth || 0) > 8) return '';
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.nodeType !== 1) return '';
    if (node.tagName === 'SLOT') {
      return (node.assignedNodes ? node.assignedNodes() : [])
        .map(n => slotText(n, (depth || 0) + 1)).join(' ');
    }
    let out = '';
    for (const child of node.childNodes) out += ' ' + slotText(child, (depth || 0) + 1);
    return out;
  };
  const ownText = el => slotText(el, 0).replace(/\s+/g, ' ').trim().slice(0, 200);

  const accName = el => {
    const by = el.getAttribute('aria-labelledby');
    const referenced = by && by.split(/\s+/)
      .map(id => el.ownerDocument.getElementById(id)).filter(Boolean).map(txt).join(' ');
    const alt = el.querySelector && el.querySelector('img[alt], svg > title');
    return (el.getAttribute('aria-label')
      || referenced
      || el.getAttribute('title')
      || ownText(el)
      || el.value
      || (alt && (alt.getAttribute('alt') || txt(alt)))
      || '').replace(/\s+/g, ' ').trim();
  };
  const isClickable = el => {
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (el.tagName === 'BUTTON' || el.tagName === 'A') return true;
    if (el.tagName === 'INPUT' && /^(submit|button|reset)$/i.test(el.type)) return true;
    if (['button', 'menuitem', 'menuitemcheckbox', 'link', 'tab'].includes(role)) return true;
    if (el.hasAttribute('onclick')) return true;
    // A custom element whose shadow root holds a real control: the host is what
    // carries the label, and it is what the page treats as the button.
    if (el.tagName.includes('-') && el.shadowRoot
        && el.shadowRoot.querySelector('button, [role="button"], a, input')) return true;
    return el.hasAttribute('tabindex')
      && !['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
  };

  const everything = deepAll(document);
  const controls = everything.filter(isClickable).filter(visible)
    .map(el => ({ el, name: accName(el) }));

  // No cap and no name filter: a missing control the page definitely has is the
  // worst kind of gap, and the last dump proved a filtered diagnostic can come
  // back empty without meaning the page is empty.
  const buttons = controls.filter(c => c.name).map(c => {
    const off = c.el.disabled || c.el.getAttribute('aria-disabled') === 'true';
    const n = c.name.slice(0, 60);
    return off ? `${n} [disabled]` : n;
  });

  // Counts, so an empty list can be told apart from an unreadable one; and frames,
  // because executeScript runs in the top frame only — a control inside an iframe
  // is a different fix, not a wider selector.
  const shell = {
    elements: everything.length,
    shadowRoots: everything.filter(el => el.shadowRoot).length,
    clickable: controls.length,
    unnamed: controls.filter(c => !c.name).length,
    frames: Array.from(document.querySelectorAll('iframe, frame'))
      .map(f => ({ src: f.getAttribute('src'), name: f.getAttribute('name') })),
  };

  // The page's action bar, called out separately because it is what a write needs.
  const actions = controls
    .map(c => ({
      tag: c.el.tagName,
      role: c.el.getAttribute('role'),
      name: c.name.slice(0, 60),
      disabled: !!(c.el.disabled || c.el.getAttribute('aria-disabled') === 'true'),
    }))
    .filter(a => /save|close|submit|publish|draft|discard|cancel|apply|done/i.test(a.name));


  const images = Array.from(document.querySelectorAll('img'))
    .filter(visible).filter(i => i.clientWidth >= 40)
    .slice(0, 30)
    .map(i => ({ size: `${i.clientWidth}x${i.clientHeight}`, alt: i.alt || null,
                 trail: trail(i).slice(-2) }));

  return {
    url: location.href,
    title: document.title,
    headings: headings.map(txt).slice(0, 80),
    shell,
    tables, links, textareas, editables, inputs, fileInputs, images, buttons,
    actions,
  };
}

// Saves the current "Details for <language>" page.
//
// This store needs it and the Chrome Web Store does not, and the difference is
// structural rather than a preference: the CWS keeps all 43 languages behind one
// dropdown on a single page, so one manual "Save draft" at the end commits every
// one of them. Partner Center gives each language its own page, and leaving a page
// discards what was typed into it. Without this step a run would write 43
// descriptions and keep none.
//
// Finding that control has now failed twice, each time because the search was
// narrower than the page. The lesson taken here is to stop guessing shapes: an
// element counts as clickable by affordance rather than by tag, shadow roots are
// walked, the name is the accessible name rather than aria-label and text, and a
// failure dumps every named control unfiltered. The second round reported
// `candidates: []` on a page the documentation says has a "Save draft" in its
// upper right — a diagnostic that filtered itself on the same words that had
// just failed to match, and so could not distinguish "nothing here" from
// "here, unnamed".
async function pageSaveDraft() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Every element on the page, shadow roots included.
  //
  // querySelectorAll stops at a shadow boundary. Partner Center's page shell and
  // the Angular form inside it are not the same technology — the field ids say
  // `formly_*` — so a command bar rendered as a web component would be on screen,
  // documented, and still absent from a flat query.
  const deepAll = (root, out) => {
    out = out || [];
    for (const el of root.querySelectorAll('*')) {
      out.push(el);
      if (el.shadowRoot) deepAll(el.shadowRoot, out);
    }
    return out;
  };

  const visible = el => {
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0;
  };
  const txt = el => (el.textContent || '').replace(/\s+/g, ' ').trim();

  // The accessible name — not just aria-label and text.
  //
  // This is what the previous attempt got wrong, and it is why a page that
  // demonstrably has a "Save draft" reported `candidates: []`. A command bar
  // button with an icon carries its label in `title`, or points at one with
  // `aria-labelledby`; both were unreadable here, so such a control was found,
  // given an empty name, and then dropped by the very filter meant to describe it.
  // Text as a reader sees it, with <slot> resolved to what is slotted into it.
  //
  // Partner Center's command bar is a web component: <v6_he-button>Save draft</v6_he-button>
  // renders a real <button> inside its shadow root and slots the label in from the
  // light DOM. textContent then finds the label on neither side — the shadow button
  // holds a <slot>, not the words — which is how a visible, documented control ended
  // up among the nineteen with no name.
  const slotText = (node, depth) => {
    if ((depth || 0) > 8) return '';
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.nodeType !== 1) return '';
    if (node.tagName === 'SLOT') {
      return (node.assignedNodes ? node.assignedNodes() : [])
        .map(n => slotText(n, (depth || 0) + 1)).join(' ');
    }
    let out = '';
    for (const child of node.childNodes) out += ' ' + slotText(child, (depth || 0) + 1);
    return out;
  };
  const ownText = el => slotText(el, 0).replace(/\s+/g, ' ').trim().slice(0, 200);

  const accName = el => {
    const by = el.getAttribute('aria-labelledby');
    const referenced = by && by.split(/\s+/)
      .map(id => el.ownerDocument.getElementById(id)).filter(Boolean).map(txt).join(' ');
    const alt = el.querySelector && el.querySelector('img[alt], svg > title');
    return (el.getAttribute('aria-label')
      || referenced
      || el.getAttribute('title')
      || ownText(el)
      || el.value
      || (alt && (alt.getAttribute('alt') || txt(alt)))
      || '').replace(/\s+/g, ' ').trim();
  };

  // Clickable by affordance rather than by tag: a div with a click handler is a
  // button as far as the user is concerned, and two rounds of narrower guesses
  // have now each missed a control the page really has.
  const clickable = el => {
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (el.tagName === 'BUTTON' || el.tagName === 'A') return true;
    if (el.tagName === 'INPUT' && /^(submit|button|reset)$/i.test(el.type)) return true;
    if (['button', 'menuitem', 'menuitemcheckbox', 'link', 'tab'].includes(role)) return true;
    if (el.hasAttribute('onclick')) return true;
    // A custom element whose shadow root holds a real control: the host is what
    // carries the label, and it is what the page treats as the button.
    if (el.tagName.includes('-') && el.shadowRoot
        && el.shadowRoot.querySelector('button, [role="button"], a, input')) return true;
    return el.hasAttribute('tabindex')
      && !['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
  };

  const all = deepAll(document);
  const controls = all.filter(clickable).filter(visible).map(el => ({ el, name: accName(el) }));

  // "Save draft" first, then a bare "Save", then any control whose name contains
  // the word: the exact wording is documented, but a console that renames its own
  // button is likelier than one that stops saving, and "Save as draft" or "Save
  // and continue" would both slip past the first two patterns.
  //
  // The last pass excludes publish and submit. A save that also submits is not a
  // save for our purposes: sending a listing for certification is
  // edge/edge_publish.py's job, and the human review before it is the point.
  const hit = controls.find(c => /save\s*draft/i.test(c.name))
    || controls.find(c => /^save$/i.test(c.name))
    || controls.find(c => /\bsave\b/i.test(c.name) && !/publish|submit/i.test(c.name));

  if (!hit) {
    // Report before filtering, and report the whole page.
    //
    // The round before this one filtered its own diagnostic on the words the
    // search had just failed on, so it came back empty exactly when it mattered.
    // This round listed only the *named* controls — and the page turned out to
    // have 19 nameless ones, which is precisely where a save button could still
    // be hiding. So: every control, named or not, on one line each, because 82
    // objects do not survive being pasted into a chat.
    const cls = el => (typeof el.className === 'string' ? el.className : '')
      .trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
    const at = el => {
      const r = el.getBoundingClientRect();
      return `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
    };
    const describe = c => [
      c.el.tagName,
      c.el.getAttribute('role') ? `[${c.el.getAttribute('role')}]` : '',
      cls(c.el) ? `.${cls(c.el)}` : '',
      ` @${at(c.el)}`,
      c.el.disabled || c.el.getAttribute('aria-disabled') === 'true' ? ' (off)' : '',
      ` :: ${c.name ? c.name.slice(0, 50) : '(no name)'}`,
    ].join('');

    // And the question that decides what to do next: do the words exist at all?
    //
    // If "Save draft" is written anywhere in this DOM, the leaf holding it is
    // found here and the chain up to the nearest clickable ancestor — marked
    // with * — is the selector to write. If the words appear nowhere, then this
    // page genuinely has no save of its own, and the fix is a different one
    // entirely: the commit is somewhere else, not behind a better selector.
    const chain = el => {
      const out = [];
      let p = el;
      for (let i = 0; i < 7 && p; i += 1) {
        out.push(p.tagName + (cls(p) ? `.${cls(p)}` : '') + (clickable(p) ? '*' : ''));
        p = p.parentElement || (p.getRootNode() && p.getRootNode().host) || null;
      }
      return out.join(' < ');
    };
    const wordHits = all
      .filter(el => !el.querySelector('*'))
      .map(el => ({ el, t: txt(el) }))
      .filter(h => h.t && h.t.length < 40 && /save|draft|submit|apply|discard/i.test(h.t))
      .slice(0, 15)
      .map(h => ({ text: h.t, visible: visible(h.el), chain: chain(h.el) }));

    return {
      ok: false,
      step: 'no-save-control',
      scanned: all.length,
      shadowRoots: all.filter(el => el.shadowRoot).length,
      clickable: controls.length,
      unnamed: controls.filter(c => !c.name).length,
      // Same-origin frames are reported rather than searched: executeScript runs
      // in the top frame only, so a control inside one is unreachable from here
      // and that is a different fix, not a wider selector.
      frames: Array.from(document.querySelectorAll('iframe, frame'))
        .map(f => ({ src: f.getAttribute('src'), name: f.getAttribute('name') })),
      saveWords: wordHits,
      candidates: controls.map(describe),
      detail: 'No "Save draft" control found on this page. Leaving a details page '
        + 'without saving discards the description, so nothing was written. '
        + '"candidates" is every clickable on the page including the nameless '
        + 'ones; "saveWords" is every leaf whose text says save/draft/submit, '
        + 'with * marking a clickable ancestor.',
    };
  }

  // The name lives on the host, the click handler usually on the control inside
  // it. Clicking the host alone would dispatch an event the component never
  // listens for — a save that silently does nothing is the exact failure this
  // whole step exists to prevent.
  const inner = hit.el.shadowRoot
    && hit.el.shadowRoot.querySelector('button, [role="button"], a, input');
  const press = inner || hit.el;

  const label = hit.name;
  const off = el => !!(el.disabled || el.getAttribute('aria-disabled') === 'true');
  if (off(hit.el) || off(press)) {
    // Partner Center greys Save out when nothing changed. That is a success, not
    // a failure: it means the field already held what we were about to write.
    return { ok: true, step: 'nothing-to-save', label };
  }

  press.click();
  await sleep(2500);
  return { ok: true, step: 'saved', label };
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

// Navigates the tab to the Store listings page and waits for it to settle.
//
// Self-contained rather than reusing background.js's waitForTabComplete: that one
// is declared with const in a script the manifest loads after this file, and
// depending on the evaluation order of two classic scripts to be reachable at call
// time is a coupling that works until someone reorders the manifest.
async function goToListings(tabId, listingUrl) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  await chrome.tabs.update(tabId, { url: listingUrl });
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const tab = await chrome.tabs.get(tabId);
    if (tab?.status === 'complete') break;
  }
  // Partner Center renders its table after load, so a complete tab is not yet a
  // page with rows on it.
  await sleep(3000);
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
  //
  // It goes back to the listings page FIRST. The row buttons it clicks exist only
  // there, so after writing one language the walk is standing on a details page
  // with nothing to click — the second locale of a run would fail as though the
  // language were missing. `ctx.listingUrl` comes from the orchestration; without
  // it the driver falls back to clicking whatever is on the current page, which is
  // right for the first locale and for a probe.
  async selectLanguage(tabId, locale, ctx) {
    if (ctx?.listingUrl) await goToListings(tabId, ctx.listingUrl);
    return edgeExec(tabId, pageOpenLanguage, [languageNames(locale)]);
  },

  // Each language is its own page here, and leaving one discards what was typed.
  // The orchestration calls this after writing, on stores that expose it.
  saveDraft: tabId => edgeExec(tabId, pageSaveDraft),

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

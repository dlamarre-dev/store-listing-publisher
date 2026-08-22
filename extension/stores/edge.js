// Microsoft Partner Center driver for the Store Listing Publisher.
//
// The Edge Add-ons API can upload a package and publish a submission but has no
// listing metadata at all, so the localized description and screenshots are only
// reachable by driving Partner Center — same situation as the Chrome Web Store,
// and the reason this file exists next to stores/cws.js.
//
// Written against real dumps of both pages, not against guesses. Every step is
// implemented; the notes at the bottom record what each dump settled.
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

  // The outermost host of whatever tree an element lives in.
  //
  // compareDocumentPosition across a shadow boundary reports DISCONNECTED, so a
  // heading trail computed on a shadow node is meaningless. Comparing the host
  // instead puts the element back on the page's own axis, which is the thing the
  // trail is actually about: what section of the page is this in.
  const inDoc = el => {
    let p = el;
    while (p && p.getRootNode() !== document && p.getRootNode().host) p = p.getRootNode().host;
    return p || el;
  };

  // The chain up to the page, crossing shadow boundaries. This is what tells four
  // asset slots apart when their file inputs look identical.
  const chain = el => {
    const out = [];
    let p = el;
    for (let i = 0; i < 8 && p; i += 1) {
      const cls = (typeof p.className === 'string' ? p.className : '')
        .trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
      out.push(p.tagName + (cls ? '.' + cls : ''));
      p = p.parentElement || (p.getRootNode() && p.getRootNode().host) || null;
    }
    return out.join(' < ');
  };

  // The nearest ancestor that reads as a caption: the words next to the control.
  const nearestLabel = el => {
    let p = el.parentElement || (el.getRootNode() && el.getRootNode().host);
    for (let i = 0; i < 6 && p; i += 1) {
      const t = ownText(p);
      if (t && t.length < 120) return t;
      p = p.parentElement || (p.getRootNode() && p.getRootNode().host) || null;
    }
    return null;
  };

  const HEADING = el => /^H[1-6]$/.test(el.tagName)
    || (el.getAttribute('role') || '') === 'heading';
  const headings = everything.filter(HEADING)
    .filter(visible).filter(h => { const t = ownText(h); return t && t.length < 80; });
  const trail = el => headings
    .filter(h => inDoc(h).compareDocumentPosition(inDoc(el)) & Node.DOCUMENT_POSITION_FOLLOWING)
    .map(ownText);

  const textareas = everything.filter(el => el.tagName === 'TEXTAREA').map(ta => ({
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
  const editables = everything.filter(el => el.getAttribute('contenteditable') === 'true')
    .filter(visible)
    .map(el => ({
      role: el.getAttribute('role'),
      ariaLabel: el.getAttribute('aria-label'),
      size: `${el.clientWidth}x${el.clientHeight}`,
      textStart: txt(el).slice(0, 60),
      trail: trail(el).slice(-3),
    }));

  const inputs = everything.filter(el => el.tagName === 'INPUT')
    .filter(visible).map(inp => ({
    type: inp.type,
    ariaLabel: inp.getAttribute('aria-label'),
    placeholder: inp.getAttribute('placeholder'),
    id: inp.id || null,
    trail: trail(inp).slice(-2),
  })).slice(0, 40);

  // The four asset slots — logo, small tile, screenshots, large tile — each own a
  // file input, and an earlier dump found only two. That dump used a flat query,
  // and this page keeps its controls inside web components, so the others were
  // never in scope rather than absent. Shadow roots are walked now, and each input
  // is reported with the component chain above it and the caption beside it: two
  // hidden inputs with identical `accept` are told apart by where they live, not
  // by what they are.
  const fileInputs = everything
    .filter(el => el.tagName === 'INPUT' && (el.getAttribute('type') || '') === 'file')
    .map(inp => ({
      accept: inp.getAttribute('accept'),
      multiple: inp.multiple,
      hidden: !visible(inp),
      id: inp.id || null,
      ariaLabel: inp.getAttribute('aria-label'),
      label: nearestLabel(inp),
      chain: chain(inp),
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
  // A component and the control inside it are the same button to a reader, and
  // listing both doubles every dump — "Save draft" twice, "Close" twice. The host
  // is the one kept: it carries the label, and the click path already reaches
  // inward from there.
  const dropShadowTwins = list => list.filter(c => {
    const host = c.el.getRootNode() && c.el.getRootNode().host;
    return !(host && list.some(o => o.el === host && o.name === c.name));
  });

  const controls = dropShadowTwins(everything.filter(isClickable).filter(visible)
    .map(el => ({ el, name: accName(el) })));

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


  const images = everything.filter(el => el.tagName === 'IMG')
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
  // A component and the control inside it are the same button to a reader, and
  // listing both doubles every dump — "Save draft" twice, "Close" twice. The host
  // is the one kept: it carries the label, and the click path already reaches
  // inward from there.
  const dropShadowTwins = list => list.filter(c => {
    const host = c.el.getRootNode() && c.el.getRootNode().host;
    return !(host && list.some(o => o.el === host && o.name === c.name));
  });

  const controls = dropShadowTwins(
    all.filter(clickable).filter(visible).map(el => ({ el, name: accName(el) })));

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
async function pageListLanguages() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = el => {
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0;
  };
  const txt = el => (el.textContent || '').replace(/\s+/g, ' ').trim();
  const label = el => (el.getAttribute('aria-label') || txt(el));

  const EDIT_RE = /^Edit\s+(.+?)\s+language details page$/i;
  const read = () => {
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
    return { rows, addControl };
  };

  // Partner Center renders this table after the page reports complete, so reading
  // once can catch it empty — and an empty table is indistinguishable from a
  // listing with no languages. That is not a cosmetic difference: enrolment reads
  // this to decide what is missing, so an early read reports every language
  // missing and the run tries to add one that is already there.
  //
  // Polled by attempts rather than by wall clock, so the wait is bounded without
  // a timer the tests have to sit through.
  let state = read();
  for (let i = 0; i < 40 && !state.rows.length; i += 1) {
    await sleep(500);
    state = read();
  }

  // Still nothing after the wait. If the "Add a language" control is there, the
  // view did render and this listing genuinely has no languages yet. If it is not,
  // nothing rendered — and saying so beats reporting an empty listing that would
  // send the caller off adding 43 languages to a page it never read.
  if (!state.rows.length && !state.addControl) {
    return {
      ok: false,
      step: 'listing-not-rendered',
      detail: 'The Store listings page showed neither a language row nor the "Add '
        + 'a language" control after waiting. It was probably read before it '
        + 'finished rendering; reporting an empty listing here would make the run '
        + 'add languages that already exist.',
    };
  }

  return {
    ok: true,
    languages: state.rows,
    canAdd: !!state.addControl,
    addLabel: state.addControl ? label(state.addControl).trim() : null,
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
// ── the screenshot slot ──────────────────────────────────────────────────────
//
// A "Details for <language>" page has four asset slots — logo, small promotional
// tile, screenshots, large promotional tile — and from the outside they are the
// same thing four times: a hidden INPUT.fileuploader with accept=".png", a
// Magnify / Delete / Duplicate trio, and no aria-label that names which is which.
// Guessing between them is how a screenshot ends up in the logo slot.
//
// What does tell them apart is the component each lives in. The probe of a real
// French details page reported:
//
//   INPUT.fileuploader < FORM < SCREENSHOTS < FORM.spacer-xl-bottom < …
//   INPUT.fileuploader < FORM < DIV.row.form-group-tall < … < SECTION.section
//
// So every step below scopes itself to the <screenshots> element and matches
// nothing outside it. That also retires this driver's earlier assumption that the
// delete buttons read "Delete screenshot <file>" — on the real page they read
// "Delete", exactly like the logo's, and only their container distinguishes them.
// Inside the right container, a plain "Delete" is unambiguous.
// The root lookup is repeated inside each function rather than shared: these are
// serialized by executeScript one at a time, so a helper in this file would not
// travel with them.
// Whether the slot has finished with what is already in it.
//
// Three runs said the same thing once they were read together: every accepted
// upload happened after roughly half a minute had passed since the previous one,
// and the "winning" gesture was simply whichever one was being attempted when the
// wait ran out. Shortening the probe to three seconds removed the delay that had
// been making everything else look like it worked.
//
// So the thing to wait for is the slot, not another gesture — and waiting for an
// observable beats waiting for a number. A committed screenshot carries its own
// per-image controls, "Delete screenshot <file>" among them, which is how a
// thumbnail that is merely being previewed is told from one the console has
// accepted. Ready means every thumbnail has them.
function pageSlotState() {
  const deepAll = (root, out) => {
    out = out || [];
    for (const el of root.querySelectorAll('*')) {
      out.push(el);
      if (el.shadowRoot) deepAll(el.shadowRoot, out);
    }
    return out;
  };
  const root = document.querySelector('screenshots')
    || deepAll(document).find(el => el.tagName === 'SCREENSHOTS') || null;
  if (!root) return { ok: false, step: 'no-screenshot-slot' };

  const visible = el => {
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0;
  };
  const label = el => (el.getAttribute('aria-label')
    || el.getAttribute('title')
    || (el.textContent || '').replace(/\s+/g, ' ')).trim();

  const shots = deepAll(root).filter(el => el.tagName === 'IMG')
    .filter(visible).filter(i => i.clientWidth >= 40);
  // "Delete screenshot Promo_1_fr.png" — the name is in the control, so a
  // thumbnail is matched to its own controls rather than to a count of them.
  const deletable = new Set(deepAll(root)
    .filter(el => el.tagName === 'BUTTON' || el.tagName === 'A'
      || (el.getAttribute('role') || '').toLowerCase() === 'button')
    .filter(visible)
    .map(label)
    .map(t => /^delete\s+screenshot\s+(.+)$/i.exec(t))
    .filter(Boolean)
    .map(m => m[1].trim()));

  const names = shots.map(i => (i.alt || '').replace(/^screenshot\s+/i, '').trim());
  const committed = names.filter(n => n && deletable.has(n)).length;

  return {
    ok: true,
    count: shots.length,
    committed,
    ready: committed === shots.length,
    names,
    deletable: Array.from(deletable),
  };
}

function pageCountScreenshots() {
  const root = (() => {
    const direct = document.querySelector('screenshots');
    if (direct) return direct;
    const deep = (r, out) => {
      for (const el of r.querySelectorAll('*')) {
        out.push(el);
        if (el.shadowRoot) deep(el.shadowRoot, out);
      }
      return out;
    };
    return deep(document, []).find(el => el.tagName === 'SCREENSHOTS') || null;
  })();

  if (!root) {
    return { ok: false, step: 'no-screenshot-slot', scope: 'localized',
             detail: 'No <screenshots> element on this page. Is this a "Details '
               + 'for <language>" page?' };
  }

  const visible = el => {
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0;
  };
  // The thumbnail is what a screenshot IS here, and its alt carries the filename —
  // the sibling slots render theirs as "Extension Store logo icon128.png" and
  // "Promotile promo-440x280.png", so the same shape is expected in this one.
  const shots = Array.from(root.querySelectorAll('img'))
    .filter(visible).filter(i => i.clientWidth >= 40);

  return {
    ok: true,
    count: shots.length,
    files: shots.map(i => i.alt || null),
    scope: 'localized',
  };
}

// Deletes one, confirms the dialog, then waits for the count to actually drop.
//
// Three things this has to get right, and the first two were got wrong once each.
//
// The dialog is a web component. Partner Center's shell renders one as
// <shell_he-dialog>, which carries no role="dialog" on the host and may keep its
// buttons in a shadow root — so a flat querySelectorAll for [role="dialog"] finds
// nothing, the confirmation is never pressed, and the delete silently does not
// happen. Matched by role, by the native <dialog> tag, and by a tag name ending
// in -DIALOG, over the deep tree.
//
// The button inside it is a component too: the label sits on the host and the
// handler on the real control inside, same as "Save draft".
//
// And waiting on the count rather than on the click is what makes the caller's
// loop safe — Partner Center removes the thumbnail asynchronously.
async function pageDeleteOneScreenshot() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const deepAll = (root, out) => {
    out = out || [];
    for (const el of root.querySelectorAll('*')) {
      out.push(el);
      if (el.shadowRoot) deepAll(el.shadowRoot, out);
    }
    return out;
  };
  const root = (() => {
    const direct = document.querySelector('screenshots');
    if (direct) return direct;
    return deepAll(document).find(el => el.tagName === 'SCREENSHOTS') || null;
  })();
  if (!root) return { ok: false, step: 'no-screenshot-slot' };

  const visible = el => {
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0;
  };
  // Slot-resolved, because a component's label is slotted in from the light DOM
  // and textContent finds it on neither side.
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
  const name = el => (el.getAttribute('aria-label')
    || el.getAttribute('title')
    || slotText(el, 0)).replace(/\s+/g, ' ').trim();

  const deleters = () => Array.from(root.querySelectorAll('button, [role="button"]'))
    .filter(visible)
    .filter(el => /^delete\b/i.test(name(el)));

  const before = deleters().length;
  if (!before) return { ok: true, before: 0, after: 0, nothingToDelete: true };

  deleters()[0].click();

  // The dialog is rendered after the click, so look for it more than once.
  const dialogs = () => deepAll(document)
    .filter(el => ['dialog', 'alertdialog'].includes((el.getAttribute('role') || '').toLowerCase())
      || el.tagName === 'DIALOG'
      || /-DIALOG$/.test(el.tagName))
    .filter(visible);

  let open = [];
  for (let i = 0; i < 10 && !open.length; i += 1) {
    await sleep(400);
    open = dialogs();
  }

  const named = dlg => deepAll(dlg)
    .filter(el => el.tagName === 'BUTTON' || el.tagName === 'A'
      || (el.getAttribute('role') || '').toLowerCase() === 'button'
      || (el.tagName.includes('-') && el.shadowRoot
          && el.shadowRoot.querySelector('button, [role="button"]')))
    .filter(visible)
    .map(el => ({ el, name: name(el) }))
    .filter(c => c.name);
  // Host and inner control are one button to a reader; keep the host, which is
  // what carries the label.
  const controls = dlg => named(dlg).filter((c, _i, list) => {
    const host = c.el.getRootNode() && c.el.getRootNode().host;
    return !(host && list.some(o => o.el === host && o.name === c.name));
  });

  let confirmed = null;
  for (const dlg of open) {
    // Affirmative only. "Cancel", "Close" and "No" are the ones that would leave
    // the screenshot in place while the run believed it had gone.
    const hit = controls(dlg)
      .filter(c => !/cancel|close|\bno\b|dismiss/i.test(c.name))
      .find(c => /^(delete|remove|yes|confirm|ok)\b/i.test(c.name));
    if (hit) {
      const inner = hit.el.shadowRoot
        && hit.el.shadowRoot.querySelector('button, [role="button"]');
      (inner || hit.el).click();
      confirmed = hit.name;
      break;
    }
  }

  if (open.length && !confirmed) {
    // Report what the dialog offered rather than timing out against a page that
    // is waiting for an answer. Unfiltered, because the previous version of this
    // step returned {ok:false, before:1, after:1} and said nothing at all.
    return {
      ok: false,
      step: 'no-confirm-control',
      before,
      after: deleters().length,
      dialogs: open.map(d => ({ tag: d.tagName, role: d.getAttribute('role'),
                                buttons: controls(d).map(c => c.name) })),
      detail: 'A confirmation dialog opened and nothing in it read as an '
        + 'affirmative. The screenshot is still there and the dialog is still '
        + 'open. "dialogs" lists every control it offers.',
    };
  }

  let after = before;
  for (let i = 0; i < 20 && after >= before; i += 1) {
    await sleep(500);
    after = deleters().length;
  }

  if (after >= before) {
    return {
      ok: false,
      step: 'delete-did-not-take',
      before,
      after,
      sawDialog: open.length > 0,
      confirmed,
      detail: open.length
        ? `Pressed "${confirmed}" in the confirmation dialog, but the thumbnail is `
          + 'still there.'
        : 'No confirmation dialog appeared after clicking Delete, and the '
          + 'thumbnail is still there. Partner Center does ask for confirmation, '
          + 'so the dialog is probably rendered as something this did not match.',
    };
  }
  return { ok: true, before, after, confirmed };
}

// Applies ONE upload mechanism, and returns immediately.
//
// Short on purpose. This used to carry the verify-and-escalate loop itself, which
// meant a single injected script running for up to 45 seconds — and an injected
// script that outlives a re-render of the page dies with it, taking its promise
// with it. That is what a run looked like when it stopped after two screenshots
// with no error at all: nothing had failed, nothing was going to answer either.
// The loop belongs in the driver, where it survives the page and can time out.
//
// `mechanism` says which gesture to make:
//
//   1  a file picker: assign input.files, then input + change. Works on an empty
//      slot; the second upload is where it stops being enough.
//   2  a drop on the card. The card announces its accepted file types, so it is a
//      drop zone as well as a picker, and a component can listen for one without
//      listening for the other. Does NOT touch input.files — a drop does not.
//   3  focus / input / change / blur, for a form that commits on blur rather than
//      on change.
//
// The visible "Add Image" affordance is never clicked: it opens the OS file
// picker, which no script can fill.
function pageApplyUpload(b64, filename, mechanism) {
  const deepAll = (root, out) => {
    out = out || [];
    for (const el of root.querySelectorAll('*')) {
      out.push(el);
      if (el.shadowRoot) deepAll(el.shadowRoot, out);
    }
    return out;
  };
  const root = document.querySelector('screenshots')
    || deepAll(document).find(el => el.tagName === 'SCREENSHOTS') || null;

  if (!root) {
    const chain = el => {
      const out = [];
      let p = el;
      for (let i = 0; i < 8 && p; i += 1) { out.push(p.tagName); p = p.parentElement; }
      return out.join(' < ');
    };
    return {
      ok: false,
      step: 'no-screenshot-slot',
      detail: 'No <screenshots> element on this page, so there is no way to tell '
        + 'the screenshot input from the logo and promo-tile ones. Refusing '
        + 'rather than picking one: a screenshot in the logo slot is an expensive '
        + 'way to find out.',
      fileInputs: Array.from(document.querySelectorAll('input[type="file"]'))
        .map(i => ({ accept: i.getAttribute('accept'), chain: chain(i) })),
    };
  }

  // The card an uploader belongs to: the outermost element under the slot that
  // contains it. This slot has one shared input, so there is one card — but a slot
  // that grew a replacement uploader per image would still be handled, a
  // replacement's card holding the thumbnail it would replace.
  const card = el => {
    let p = el;
    while (p.parentElement && p.parentElement !== root) p = p.parentElement;
    return p;
  };
  const nearestLabel = el => {
    let p = el.parentElement;
    for (let i = 0; i < 6 && p && p !== root; i += 1) {
      const t = (p.textContent || '').replace(/\s+/g, ' ').trim();
      if (t && t.length < 120) return t;
      p = p.parentElement;
    }
    return '';
  };

  const inputs = deepAll(root)
    .filter(el => el.tagName === 'INPUT' && (el.getAttribute('type') || '') === 'file');
  if (!inputs.length) {
    return { ok: false, step: 'no-screenshot-file-input',
             detail: 'The <screenshots> element has no file input at all. It may '
               + 'already hold the maximum of six images.' };
  }
  const empty = inputs.filter(i => !Array.from(card(i).querySelectorAll('img'))
    .some(img => img.clientWidth >= 40));
  const byLabel = empty.find(i => /add\s*image/i.test(nearestLabel(i)));
  const input = byLabel || empty[empty.length - 1] || inputs[inputs.length - 1];
  const chose = byLabel ? 'add-image' : (empty.length ? 'no-thumbnail' : 'last');

  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const transfer = () => {
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], filename, { type: 'image/png' }));
    return dt;
  };
  const fill = () => {
    // Cleared first, the way a real re-selection leaves it. An uploader that reads
    // files[0] and resets its input sees no change when the same element is
    // assigned again while still holding the previous file.
    try { input.value = ''; } catch (e) { /* some inputs refuse; assigning still works */ }
    input.files = transfer().files;
  };

  const common = { inputs: inputs.length, chose, mechanism, filename,
                   size: bytes.length };

  if (mechanism === 2) {
    const zone = card(input);
    const dt = transfer();
    for (const type of ['dragenter', 'dragover', 'drop']) {
      let ev;
      try {
        ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
      } catch (e) {
        ev = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'dataTransfer', { value: dt });
      }
      zone.dispatchEvent(ev);
    }
    return { ok: true, ...common };
  }

  if (mechanism === 3) {
    fill();
    input.dispatchEvent(new Event('focus', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    return { ok: true, ...common };
  }

  fill();
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, ...common };
}

// What the screenshot slot actually looks like right now.
//
// Called when an upload reports success and the count does not move — which has
// now happened twice for two different reasons, and both times the run failed
// with a bare timeout that said only "last: 1". A timeout that cannot say what
// the page looked like sends the operator back for a probe, and by then the run
// has been abandoned and the page has moved on.
//
// So this reports the whole slot: every file input with its caption and whether
// anything is sitting in it, every thumbnail, and every control. Nothing here is
// filtered on what the caller expected to find.
function pageDescribeSlot() {
  const deepAll = (root, out) => {
    out = out || [];
    for (const el of root.querySelectorAll('*')) {
      out.push(el);
      if (el.shadowRoot) deepAll(el.shadowRoot, out);
    }
    return out;
  };
  const root = document.querySelector('screenshots')
    || deepAll(document).find(el => el.tagName === 'SCREENSHOTS') || null;
  if (!root) return { ok: false, step: 'no-screenshot-slot' };

  const visible = el => {
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0;
  };
  const txt = el => (el.textContent || '').replace(/\s+/g, ' ').trim();
  const near = el => {
    let p = el.parentElement;
    for (let i = 0; i < 6 && p && p !== root; i += 1) {
      const t = txt(p);
      if (t && t.length < 120) return t;
      p = p.parentElement;
    }
    return null;
  };
  const chain = el => {
    const out = [];
    let p = el;
    for (let i = 0; i < 6 && p; i += 1) {
      const cls = (typeof p.className === 'string' ? p.className : '')
        .trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
      out.push(p.tagName + (cls ? '.' + cls : ''));
      p = p.parentElement || (p.getRootNode() && p.getRootNode().host) || null;
    }
    return out.join(' < ');
  };

  return {
    ok: true,
    fileInputs: deepAll(root)
      .filter(el => el.tagName === 'INPUT' && (el.getAttribute('type') || '') === 'file')
      .map(inp => ({
        caption: near(inp),
        // Whether the previous assignment is still sitting in it. An uploader
        // that never drains its input is a different problem from one that never
        // received a second file.
        holds: inp.files && inp.files.length ? inp.files[0].name : null,
        value: inp.value || null,
        disabled: !!inp.disabled,
        hidden: !visible(inp),
        chain: chain(inp),
      })),
    images: deepAll(root).filter(el => el.tagName === 'IMG')
      .map(i => ({ alt: i.alt || null, size: `${i.clientWidth}x${i.clientHeight}`,
                   visible: visible(i) })),
    controls: deepAll(root)
      .filter(el => el.tagName === 'BUTTON' || el.tagName === 'A'
        || (el.getAttribute('role') || '').toLowerCase() === 'button')
      .filter(visible)
      .map(el => (el.getAttribute('aria-label') || el.getAttribute('title') || txt(el)))
      .filter(Boolean),
    text: txt(root).slice(0, 400),
  };
}

// Copies this language's screenshots to every other language.
//
// The store's own feature, and the reason a 43-language listing does not need 215
// uploads: fill one language, press this once. Nothing else in this driver saves
// as much.
//
// Matched inside the slot on the word "duplicate" alone. The sibling slots label
// theirs "Duplicate this logo for all languages" and "Duplicate this promotional
// tile for all languages", so the screenshot wording is predictable but not
// observed — and inside the right component it does not need to be.
async function pageDuplicateScreenshots() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const root = (() => {
    const direct = document.querySelector('screenshots');
    if (direct) return direct;
    const deep = (r, out) => {
      for (const el of r.querySelectorAll('*')) {
        out.push(el);
        if (el.shadowRoot) deep(el.shadowRoot, out);
      }
      return out;
    };
    return deep(document, []).find(el => el.tagName === 'SCREENSHOTS') || null;
  })();
  if (!root) return { ok: false, step: 'no-screenshot-slot' };

  const visible = el => {
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0;
  };
  const label = el => (el.getAttribute('aria-label')
    || el.getAttribute('title')
    || (el.textContent || '').replace(/\s+/g, ' ')).trim();

  const button = Array.from(root.querySelectorAll('button, [role="button"]'))
    .filter(visible)
    .find(el => /duplicate/i.test(label(el)));

  if (!button) {
    return {
      ok: false,
      step: 'no-duplicate-control',
      detail: 'No duplicate button in the screenshot slot. It only appears once at '
        + 'least one screenshot has been uploaded for this language.',
      buttons: Array.from(root.querySelectorAll('button, [role="button"]'))
        .filter(visible).map(label).filter(Boolean),
    };
  }
  button.click();
  await sleep(2000);
  return { ok: true, step: 'duplicated' };
}

// ── driver (background context) ───────────────────────────────────────────────

const edgeSleep = ms => new Promise(r => setTimeout(r, ms));

// Which upload gesture this store answered last time.
//
// The escalation is safe but it is not free: a gesture that will not be taken
// costs the whole verification window before the next is tried. A real run showed
// the shape of it — the first screenshot went in on gesture 1, and every one after
// it on gesture 3, so uploads 2 through 5 each paid for two gestures they were
// never going to accept. Over 43 locales that is not a rough edge, it is the run.
//
// So the order is learned rather than fixed. Remembering costs nothing and cannot
// break anything: a wrong preference only changes which gesture is tried first,
// and the rest still follow. Persisted, because the answer is a property of the
// console rather than of a run — and if the console changes its mind, the first
// upload of the next run relearns it.
// Prime, then commit.
//
// This console swallows the first assignment made to a slot that already holds an
// image, and honours the second. That was not a theory: a five-screenshot run
// reported its winners as 1, 3, 1, 3, 1 — alternating, because the previous
// design remembered whichever gesture had just worked, tried it first, and it
// failed. Gestures 1 and 3 are the two that assign input.files; the drop does not,
// and has never been accepted on the real page.
//
// So both filling gestures are made every time, and only the second one is waited
// on properly:
//
//   1. fill and dispatch. Wait a SHORT probe — an empty slot takes this one, and
//      the observed latency when it does is under a second.
//   2. fill and dispatch again. Wait the LONG window. This is the one a non-empty
//      slot takes.
//   3. only if neither landed, the drop, as a fallback that has never been needed.
//
// The probe is what keeps this from uploading twice. Doing both fills back to
// back — the obvious reading of "it honours the second" — would append a
// duplicate whenever the first was in fact honoured, and this slot appends rather
// than replaces: the cap is six and we upload five. Waiting first means the second
// fill only happens once the first has demonstrably done nothing.
//
// The learned-gesture preference that used to live here is gone. It was built on
// the idea that one gesture works and the others do not, which is not what this
// page does — and remembering the last winner is actively wrong when the winner
// alternates. What is still worth learning is how long an honoured fill takes to
// show, because that is what sizes the probe.
const FILL_GESTURES = [1, 3];
const DROP_GESTURE = 2;
const LATENCY_KEY = 'edgeUploadLatencyMs';
const POLL_MS = 500;
const LONG_WINDOW_MS = 30000;
const PROBE_MIN_MS = 3000;
const PROBE_MAX_MS = 10000;
const SETTLE_MAX_MS = 45000;

// The shortest gap this console has ever been seen to accept between two uploads
// into the same slot.
//
// This is the knob. Three runs agreed that an upload lands about half a minute
// after the previous one and not before, whichever gesture is used, so the gap is
// waited out deliberately instead of being paid for by accident inside a
// verification window. Correct and slow beats fast and wrong: at five screenshots
// a locale it costs about two minutes each, and a run that completes is worth more
// than one that fails on the second file.
//
// Lower it only against a run that shows uploads accepted sooner — the log prints
// the gap it waited, so that evidence is there to collect.
const MIN_UPLOAD_GAP_MS = 30000;
let lastUploadAt = 0;
let learnedLatency = null;

async function loadLatency() {
  if (learnedLatency !== null) return;
  learnedLatency = 0;
  try {
    const stored = await chrome.storage.local.get(LATENCY_KEY);
    learnedLatency = (stored && stored[LATENCY_KEY]) || 0;
  } catch (e) { /* a session-only measurement is still worth having */ }
}

// How long to wait on the FIRST fill before deciding it was swallowed.
//
// Four times the slowest first-fill success ever seen. Only first-fill successes
// count: the latency of a success that needed two fills includes the swallowed
// one, so feeding it back here would inflate the probe with a number that answers
// a different question.
//
// Floored at 3s so a fast console cannot make the probe flaky, and capped at 10s
// because past that the probe costs more than the escalation it is avoiding.
async function probeWindowMs() {
  await loadLatency();
  if (!learnedLatency) return PROBE_MIN_MS;
  return Math.min(PROBE_MAX_MS, Math.max(PROBE_MIN_MS, learnedLatency * 4));
}

async function rememberLatency(ms) {
  await loadLatency();
  if (!ms || ms <= learnedLatency) return;
  learnedLatency = ms;
  try { await chrome.storage.local.set({ [LATENCY_KEY]: ms }); }
  catch (e) { /* as above */ }
}

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
  // feature.
  //
  // **Nothing calls this.** It is offered, not used: the orchestration uploads
  // each locale's own screenshots, and duplicating would overwrite 42 languages
  // with one language's images. It is only ever right from the default locale,
  // and only for a project whose screenshots carry no text — which is not this
  // one. A caller that wires it up should check both.
  duplicateScreenshots: tabId => edgeExec(tabId, pageDuplicateScreenshots),

  // Optional, and the orchestration calls it only when an upload reports success
  // and the count does not follow. A bare timeout has now hidden two different
  // causes; this is what turns the next one into one round trip instead of three.
  describeAssets: tabId => edgeExec(tabId, pageDescribeSlot),

  // Puts one PNG into the screenshot slot. It refused until a probe of a real
  // details page showed what separates the four slots — the component each lives
  // in, <screenshots> for this one — because the alternative was picking between
  // identical-looking hidden inputs, and a screenshot in the logo slot is an
  // expensive way to find out you picked wrong.
  //
  // `scope` is ignored: this store has no global assets card, every asset on a
  // details page belongs to that language, and duplicateScreenshots is how one
  // language reaches the other 42.
  // Applies a mechanism, verifies it, escalates only if the page did not react.
  //
  // The loop lives here rather than in the page because an injected script that
  // outlives a re-render dies with it and its promise never settles — a run that
  // stopped after two screenshots with no error at all was exactly that. From
  // here every injection is short, the waiting is ours, and a page that stops
  // answering becomes a timeout instead of a silence.
  //
  // The count is re-read before each escalation, so a mechanism that merely takes
  // its time is not overtaken by the next one and the same file uploaded twice.
  async uploadScreenshot(tabId, b64, filename) {
    const shots = async () => {
      const res = await edgeExec(tabId, pageCountScreenshots);
      return res && res.ok ? res.count : null;
    };
    const before = await shots();
    const tried = [];

    // Returns how long it took for the count to rise, or 0.
    const waitFor = async (windowMs) => {
      const polls = Math.ceil(windowMs / POLL_MS);
      for (let i = 1; i <= polls; i += 1) {
        await edgeSleep(POLL_MS);
        const now = await shots();
        if (now !== null && before !== null && now > before) return i * POLL_MS;
      }
      return 0;
    };

    // Wait for the slot to finish with what is already in it before adding to it.
    //
    // This is the delay the earlier designs were paying for by accident: every
    // accepted upload came after roughly half a minute since the previous one, and
    // the gesture that happened to be current took the credit. Waiting on an
    // observable — every thumbnail carrying its own per-image controls — costs
    // nothing when the slot is already idle, which is the case on the first
    // upload of a locale.
    let settleMs = 0;
    if (before) {
      // First the observable: every thumbnail carrying its own per-image
      // controls, which is how one the console has committed is told from one it
      // is merely previewing.
      const settlePolls = Math.ceil(SETTLE_MAX_MS / POLL_MS);
      for (let i = 1; i <= settlePolls; i += 1) {
        const state = await edgeExec(tabId, pageSlotState);
        if (!state || state.ok !== true) break;
        if (state.ready) break;
        await edgeSleep(POLL_MS);
        settleMs = i * POLL_MS;
      }

      // Then the gap, which is the part the evidence is actually about. The
      // readiness check above is a hypothesis about WHAT the wait is for; the gap
      // is the only thing three runs measured. Whatever the readiness check
      // already spent counts towards it, and so does everything else that
      // happened since — the previous upload's own verification, the count polls,
      // a description write.
      const elapsed = lastUploadAt ? Date.now() - lastUploadAt : MIN_UPLOAD_GAP_MS;
      const owed = MIN_UPLOAD_GAP_MS - elapsed;
      if (owed > 0) {
        await edgeSleep(owed);
        settleMs += owed;
      }
    }

    const probeMs = await probeWindowMs();
    const order = [...FILL_GESTURES, DROP_GESTURE];

    for (let n = 0; n < order.length; n += 1) {
      const mechanism = order[n];
      const applied = await edgeExec(tabId, pageApplyUpload, [b64, filename, mechanism]);
      tried.push({ mechanism, ok: applied ? applied.ok === true : false,
                   step: applied ? applied.step : 'no-result',
                   chose: applied ? applied.chose : null });
      // A refusal about the page rather than the gesture — no slot, no input —
      // will not be fixed by making a different gesture at it.
      if (applied && applied.ok !== true) return { ...applied, tried, before };
      if (!applied) continue;

      // Only the first fill gets the short probe. It is there to catch the empty
      // slot cheaply and to prove the fill was swallowed before another is made;
      // everything after it is given the full window, because by then there is
      // nothing left to escalate to in a hurry.
      const isFirstFill = n === 0;
      const tookMs = await waitFor(isFirstFill ? probeMs : LONG_WINDOW_MS);
      if (!tookMs) continue;

      const after = await shots();
      // Two files where one was expected. This slot appends, so a duplicate is
      // not self-correcting: five screenshots plus one duplicate is the cap, and
      // the next upload would fail for a reason that has nothing to do with it.
      // Better to stop here, where it is attributable.
      if (after !== null && before !== null && after > before + 1) {
        lastUploadAt = Date.now();
        return {
          ok: false,
          step: 'upload-duplicated',
          filename, before, after, tried, via: mechanism,
          detail: 'The count rose by more than one, so the file went in twice. '
            + 'This slot appends rather than replaces and its cap is six, so a '
            + 'duplicate has to be removed by hand before the run continues.',
        };
      }
      if (isFirstFill) await rememberLatency(tookMs);
      lastUploadAt = Date.now();
      return { ok: true, filename, via: mechanism, before, after, tried,
               chose: applied.chose, tookMs, settleMs };
    }

    return {
      ok: false,
      step: 'upload-not-accepted',
      filename,
      before,
      after: await shots(),
      tried,
      settleMs,
      slot: await edgeExec(tabId, pageSlotState),
      detail: 'The file was put into the slot twice and dropped on it once, and '
        + 'the page took none of them. Each attempt was verified against the '
        + 'thumbnail count before the next: the first fill against a short probe, '
        + 'the rest against the full window.',
    };
  },
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
//   "Details for <language>" page.
// - "Add a language" exists as a control, and only ONE row (English) was present
//   despite 43 locales in the package — verified inside the zip. That is the
//   store's model, not a defect: the package makes a language AVAILABLE, adding
//   it is a separate action. Any run over 43 locales has to add 42 of them first.
//
// ── What the Details page settled ───────────────────────────────────────────
//
// Probed against "Details for French", 2026-08-22, with the screenshot slot
// empty — the state that makes its file input visible to a dump at all.
//
// - The description is a plain <textarea>, id `formly_2_textarea_description_1`,
//   maxlength 10000. Angular Formly, so the CWS write path applies: native value
//   setter, then input and change. `editables` was empty — no rich-text editor.
// - Save draft is <v6_he-button>Save draft</v6_he-button>: a real <button> in a
//   shadow root with the label slotted in from the light DOM. It reads
//   "[disabled]" once the page is saved, which is what nothing-to-save reports.
// - **Four asset slots, one shape.** Logo, small promotional tile, screenshots
//   and large promotional tile each own a hidden INPUT.fileuploader with
//   accept=".png", a Magnify / Delete / Duplicate trio, and no aria-label naming
//   which is which. The only thing separating them is the component they live in:
//
//       INPUT.fileuploader < FORM < SCREENSHOTS < FORM.spacer-xl-bottom < …
//       INPUT.fileuploader < FORM < DIV.row.form-group-tall < … < SECTION.section
//
//   Every screenshot step is scoped to <screenshots> for this reason, and refuses
//   when it is absent.
// - **The slot has ONE shared file input**, directly under <screenshots>, and it
//   holds nothing after an upload. Settled by a describeAssets dump taken at the
//   moment of failure, which also ruled out every theory about picking the wrong
//   element. The first upload is accepted and the second is not, with the same
//   input, the same code and a valid 1280x800 file — so what differs is the
//   component's state, and that is still unexplained. The upload therefore
//   verifies each mechanism against the thumbnail count instead of trusting its
//   own dispatch, and reports which one worked.
// - **The console honours the SECOND assignment, not a particular gesture.** A
//   five-screenshot run reported its winners as 1, 3, 1, 3, 1 — alternating,
//   because the learned order tries whatever just worked and that one then fails.
//   Gestures 1 and 3 are the two that assign input.files; gesture 2, a drop, does
//   not, and has never been accepted. So an upload into a non-empty slot needs two
//   filling attempts, and which gesture makes them is beside the point.
//   So both fills are made every time, and only the second is waited on properly:
//   fill, probe briefly, fill again, wait the full window, and only then the drop.
//   The probe is what keeps this from uploading twice — this slot appends rather
//   than replaces, so a second fill made while the first was merely slow would
//   append a duplicate, and the cap is six against the five we send.
//   **But the operative variable is time, not the gesture.** Read together, three
//   runs agreed: an upload into a slot that already holds an image lands about
//   half a minute after the previous one and not before, whichever gesture is
//   used, and every design before this one was paying that gap by accident inside
//   windows it thought it was spending on gestures. Shortening the probe to three
//   seconds removed the delay that had been making the rest look like it worked,
//   and the second screenshot of the first locale failed. So the gap is waited out
//   deliberately — MIN_UPLOAD_GAP_MS, owed only against an upload this run made,
//   and reported in the log so it can be lowered against evidence rather than
//   guessed downward again.
//   One number matters and it is easy to get wrong: the probe must be sized from
//   FIRST-fill successes only. A success that needed two fills is slower by
//   construction, and sizing the probe from it makes every later upload wait out
//   the very fill it is trying to rule out quickly. Sizing it from a 0.8s best
//   case is the mirror of that mistake, and it made a run fail after one
//   screenshot.
// - **Keep injected functions short.** The verify-and-escalate loop lived in the
//   page for one round, which made a single injected script run for up to 45
//   seconds — and a script that outlives a re-render dies with it, its promise
//   never settling. The symptom was a run that stopped after two screenshots with
//   no error at all: nothing had failed and nothing was going to answer. Loops
//   that wait on the page belong in the driver, where a page that stops answering
//   becomes a timeout.
// - The card's own text gives the accepted sizes as **1280 x 800 or 640 x 400** —
//   not 640x480, as a note here once said. Ours are 1280x800.
// - **A slot MIGHT carry one uploader per image, plus one to add with.** The logo slot
//   was full in that dump and still exposed an input — the replace affordance —
//   so the conclusion drawn at the time, that a filled slot exposes none, had the
//   fact backwards. It cost a run: taking the first input in the slot replaced
//   screenshot 1 with screenshot 2, the count stayed at 1, and the upload loop
//   timed out waiting for it to reach 2. The one to fill is decided by structure,
//   not by wording: a replacement uploader shares its card with the thumbnail it
//   would replace, the add uploader's card has none. The caption "Add Image" is
//   read first where it is there, but it was only there while the slot was empty
//   — which is why the caption rule passed its first run and failed its second.
// - The delete buttons read "Delete", not "Delete screenshot <file>" — an earlier
//   assumption in this driver, never observed. Inside the right component a plain
//   "Delete" is unambiguous, which is the whole argument for scoping by component
//   rather than by label text.
// - **Deleting asks for confirmation**, and the dialog is a component too:
//   <shell_he-dialog>, no role="dialog" on the host, buttons that are themselves
//   components. A flat query for [role="dialog"] finds nothing and the delete
//   silently does not happen. Never press Cancel or Close there: the screenshot
//   stays while the run believes it is gone, and the next upload then overflows
//   the cap of six.
// - **A component and the control inside it are one button.** Matching both made
//   every dump list each control twice ("Save draft", "Save draft"), which is
//   noise in a dump that has to be pasted by hand. The host is the one kept — it
//   carries the label, and the click path reaches inward from there.
// - Thumbnail alts carry the filename: "Extension Store logo icon128.png",
//   "Promotile promo-440x280.png". countScreenshots reads the same shape.
// - The duplicate buttons are per slot: "Duplicate this logo for all languages",
//   "Duplicate this promotional tile for all languages". The screenshot wording
//   is predictable but was not observed — the slot was empty, and the control
//   only appears once an image is in it. Matched on "duplicate" inside the
//   component, so the exact wording does not matter.
//
// ── Standing rules ───────────────────────────────────────────────────────────
//
// 1. Never press Publish. That is edge/edge_publish.py's job, and the review
//    before it stays human.
// 2. The screenshot cap is 6; sizes 640x480 or 1280x800, ours are 1280x800.
// 3. **Do not duplicate one language's screenshots across the others.** The store
//    offers it and this driver exposes it, but nothing calls it: each locale has
//    its own localized screenshots, and duplicating would overwrite 42 languages
//    with one language's images. A language with no page of its own already falls
//    back to the default one on the store side, which is the behaviour wanted —
//    so there is nothing to gain and a whole listing to lose.
// 4. When the console changes, probe first. Three separate controls have now been
//    missed by a selector narrower than the page, and each time the dump found
//    them once it stopped filtering itself.

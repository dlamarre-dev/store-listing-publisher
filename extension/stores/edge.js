// Microsoft Partner Center driver for the Store Listing Publisher.
//
// The Edge Add-ons API can upload a package and publish a submission but has no
// listing metadata at all, so the localized description and screenshots are only
// reachable by driving Partner Center — same situation as the Chrome Web Store,
// and the reason this file exists next to stores/cws.js.
//
// It is DELIBERATELY probe-only for now. Everything except probe() refuses with
// an instruction instead of guessing, because Partner Center's markup has not
// been read yet and selectors written blind are fiction that looks like code.
// Click "Probe page", send the dump, and the page* functions get written against
// it. See "Filling this in" at the bottom.
//
// Page facts from Microsoft's own documentation (learn.microsoft.com,
// microsoft-edge/extensions/publish/publish-extension), which already make this
// store structurally different from the CWS:
//
// - The left nav is Packages / Availability / Properties / Privacy /
//   Store listings / Analytics. The listing lives under "Store listings".
// - **There is no language dropdown.** The Store listings page is a TABLE, one
//   row per language, and each row has an "Edit details" button that opens a
//   separate "Details for <language>" page. So the CWS's select-language-in-place
//   model does not transfer: this driver navigates per language.
// - The languages in that table come from the package's _locales, so all 43
//   appear on their own once a package is uploaded.
// - Per language: Description (250–10,000 chars, editable), Extension logo
//   (required, 300x300), Screenshots (optional, max 6, 640x480 or 1280x800),
//   promo tiles, YouTube URL, Search terms. Extension name and Short description
//   are read-only — they come from the manifest.
// - **"Duplicate this asset for all languages"** exists under each asset. That
//   is worth building around: 5 screenshots uploaded once and duplicated beats
//   5 x 43 uploads, and it is the store's own feature rather than a trick.
// - Saving is "Save draft", upper right. Publishing is a separate button on the
//   Store listings page, and this driver will never press it — the API does that
//   (edge/edge_publish.py --publish), and reviewing before submitting stays human.

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

// ── driver (background context) ───────────────────────────────────────────────

async function edgeExec(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN', func, args,
  });
  return results?.[0]?.result;
}

// Every step other than the probe reports the same refusal, so a run cannot
// half-work: the orchestration aborts on ok:false and prints the detail.
const NOT_YET = step => ({
  ok: false,
  step: 'not-implemented',
  store: 'edge',
  detail: `The Partner Center driver cannot ${step} yet. Run "Probe page" against `
    + 'the Store listings page and send the dump — the selectors are written '
    + 'against that, not guessed. See the notes at the bottom of stores/edge.js.',
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

  probe: tabId => edgeExec(tabId, pageProbe),

  selectLanguage: async () => NOT_YET('open a language\'s details page'),
  setDescription: async () => NOT_YET('write the description'),
  countScreenshots: async () => NOT_YET('count screenshots'),
  deleteOneScreenshot: async () => NOT_YET('delete a screenshot'),
  uploadScreenshot: async () => NOT_YET('upload a screenshot'),
};

// ── Filling this in ──────────────────────────────────────────────────────────
//
// 1. Probe the Store listings page. The dump's `links` gives the real route to a
//    "Details for <language>" page, and `tables` gives the row shape and the
//    exact label of the per-row edit button.
// 2. Probe one Details page. `textareas` vs `editables` decides how the
//    description is written: a plain textarea takes the CWS approach (native
//    value setter + input/change), a contenteditable does not. `maxLength` should
//    confirm the 10,000 cap the build already trims to.
// 3. selectLanguage becomes a navigation, not a dropdown pick — this store has
//    no in-place language switch. It should verify it landed on the right
//    language before writing, the same way the CWS driver refuses on an
//    unconfirmed switch rather than writing into the wrong locale.
// 4. Screenshots: look for "Duplicate this screenshot for all languages" in
//    `buttons` first. If it is there, the right shape is upload 5 once and
//    duplicate — not 215 uploads. Note the cap is 6 and the accepted sizes are
//    640x480 and 1280x800; ours are 1280x800.
// 5. Never press Publish. That is edge/edge_publish.py's job, and the review
//    before it stays human.

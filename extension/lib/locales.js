// Locale helpers. The table itself is data now — it lives in config.json, so a
// consuming project declares its own set of languages instead of patching this
// file. Every function here takes that table as an argument.
//
// A row:
//   internal  the project's own code, and the key everything else hangs off
//   cws       Chrome Web Store code (Google uses "iw" for Hebrew, "no" for
//             Norwegian, "fil" for Filipino, and dashes for regional variants)
//   amo       addons.mozilla.org code, or null when AMO cannot store listing
//             translations for that language (its PROD_LANGUAGES list)
//   name      label the CWS console shows in its language dropdown (hl=en)
//   altNames  optional extra labels to match, when the console's wording
//             differs from `name` ("Chinese (Simplified)" for zh_CN)
//   fileCode  optional override for {LANG} in path templates (see paths.js)

function validateLocales(locales) {
  if (!Array.isArray(locales) || !locales.length) {
    throw new Error('config.locales must be a non-empty array.');
  }
  const seenInternal = new Set();
  const seenCws = new Set();
  for (const l of locales) {
    for (const field of ['internal', 'cws', 'name']) {
      if (!l || typeof l[field] !== 'string' || !l[field]) {
        throw new Error(`Locale row missing "${field}": ${JSON.stringify(l)}`);
      }
    }
    if (seenInternal.has(l.internal)) throw new Error(`Duplicate internal locale: ${l.internal}`);
    if (seenCws.has(l.cws)) throw new Error(`Duplicate CWS locale: ${l.cws}`);
    seenInternal.add(l.internal);
    seenCws.add(l.cws);
  }
  return locales;
}

// Parses the popup's locale-filter field:
//   ""            → all locales
//   "fr, de"      → only those (internal codes), in the order given
//   "from:pl"     → pl and everything after it (resume an aborted run)
function filterLocales(locales, filterText) {
  const text = (filterText || '').trim().toLowerCase();
  if (!text) return locales.slice();

  const fromMatch = text.match(/^from:\s*(\S+)$/);
  if (fromMatch) {
    const idx = locales.findIndex(l => l.internal.toLowerCase() === fromMatch[1]);
    if (idx === -1) throw new Error(`Unknown locale in "from:" filter: ${fromMatch[1]}`);
    return locales.slice(idx);
  }

  const wanted = text.split(',').map(s => s.trim()).filter(Boolean);
  const result = wanted.map(code => {
    const loc = locales.find(l => l.internal.toLowerCase() === code);
    if (!loc) throw new Error(`Unknown locale in filter: ${code}`);
    return loc;
  });
  if (!result.length) throw new Error('Locale filter parsed to an empty list.');
  return result;
}

// Which options require walking the language dropdown. The detailed description
// and the "Localized assets" screenshots are per-language; the international
// screenshots live in the language-independent "Global assets" card, so a
// global-only run has nothing to select and must not spend minutes switching
// languages it will not write to — worse, one unconfirmed switch aborts the run
// before the global step it was asked to perform.
function needsLocaleWalk(opts) {
  return !!(opts && (opts.updateTexts || opts.updateImages));
}

// Labels to try in the console's language dropdown, best first.
function languageNames(locale) {
  return [locale.name, ...(locale.altNames || [])];
}

if (typeof module !== 'undefined') {
  module.exports = { validateLocales, filterLocales, needsLocaleWalk, languageNames };
}

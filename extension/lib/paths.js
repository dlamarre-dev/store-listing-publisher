// Asset path resolution.
//
// The tool has no idea how a project lays its marketing assets out, so every
// path is a template in config.json. Placeholders:
//
//   {slug}     the item's slug            ("ai-folders")
//   {lang}     the locale's internal code  ("pt_BR", "zh_CN")
//   {LANG}     uppercase of fileCode ?? internal ("PT_BR", "CN")
//   {cwsLang}  the Chrome Web Store code   ("pt-BR", "zh-CN", "iw", "no")
//   {amoLang}  the addons.mozilla.org code ("pt-BR", "he", "nb-NO") — "" when
//              the locale is not on AMO
//   {n}        screenshot index, 1-based
//
// {LANG} exists for the one thing a template cannot express: a project whose
// filenames use a code that is neither the internal one nor a store one. Set
// `fileCode` on that locale's row and {LANG} follows it, instead of putting a
// special case in the code (AI Folders' zh_CN → PromoCN.txt is the reason).
//
// Templates always use "/" as separator; joinPath converts to the host's.

function localeVars(locale) {
  return {
    lang: locale.internal,
    LANG: String(locale.fileCode || locale.internal).toUpperCase(),
    cwsLang: locale.cws || '',
    amoLang: locale.amo || '',
  };
}

function resolveTemplate(template, vars) {
  if (typeof template !== 'string' || !template) {
    throw new Error(`Path template missing or not a string: ${JSON.stringify(template)}`);
  }
  const out = template.replace(/\{(\w+)\}/g, (match, key) => {
    if (!(key in vars)) throw new Error(`Unknown placeholder ${match} in template "${template}"`);
    return String(vars[key]);
  });
  // An unfilled placeholder would silently read the wrong file; a template that
  // omits {lang} on a per-locale path collapses 43 reads onto one.
  if (out.includes('{') || out.includes('}')) {
    throw new Error(`Template "${template}" did not fully resolve: "${out}"`);
  }
  return out;
}

// Joins a "/"-separated relative path onto an absolute root, using whichever
// separator the root itself uses. The extension never sees a real path API —
// the root is a string handed over by config and passed back to the native
// host, so it must come back in the host's own notation.
function joinPath(root, relative) {
  const sep = root.includes('\\') ? '\\' : '/';
  const parts = String(relative).split('/').filter(Boolean);
  return [String(root).replace(/[\\/]+$/, ''), ...parts].join(sep);
}

// The three call sites. `profile` is the assets block for the store being
// published ("chrome" or "firefox").
function descriptionPath(assetsRoot, profile, item, locale) {
  return joinPath(assetsRoot, resolveTemplate(profile.description, {
    slug: item.slug, ...localeVars(locale),
  }));
}

function screenshotPath(assetsRoot, profile, item, locale, index) {
  return joinPath(assetsRoot, resolveTemplate(profile.screenshot, {
    slug: item.slug, ...localeVars(locale), n: index,
  }));
}

// Optional: a JSON file carrying the listing summary / name (AMO only).
function metaPath(assetsRoot, template, item, locale) {
  return joinPath(assetsRoot, resolveTemplate(template, {
    slug: item.slug, ...localeVars(locale),
  }));
}

// The base name, for log lines and for the File the upload hands the page.
function baseName(p) {
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1];
}

if (typeof module !== 'undefined') {
  module.exports = {
    localeVars, resolveTemplate, joinPath,
    descriptionPath, screenshotPath, metaPath, baseName,
  };
}

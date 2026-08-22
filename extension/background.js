// Orchestrates a store-listing publish run.
//
// lib/config.js, lib/locales.js, lib/paths.js and the stores/ drivers load first
// (manifest background scripts), so their functions are globals here.
//
// The orchestration is store-agnostic: it only talks to a driver object through
// the interface documented at the bottom of stores/cws.js, and it knows nothing
// about how the project lays its assets out — every path comes from a template
// in the config (lib/paths.js). CwsDriver is complete; EdgeDriver is probe-only
// for now and every other step refuses with an instruction, so a run against it
// aborts rather than half-works.

const SETTLE_PAGE_MS  = 6000;   // initial SPA render after tab load
const SETTLE_FIELD_MS = 1200;   // after a language switch, before touching fields
const TAB_LOAD_MS     = 60000;
const UPLOAD_WAIT_MS  = 45000;  // per-screenshot upload (thumbnail appears)
const MAX_DELETES     = 12;     // safety bound on the delete loop

const DRIVERS = { cws: CwsDriver, edge: EdgeDriver };

// ── native messaging ──────────────────────────────────────────────────────────

const NATIVE_HOST = 'com.storelistingpublisher.filereader';
// The host manifest records an absolute path to the launcher, so moving this
// checkout invalidates it — that is what a connect failure usually means.
const NATIVE_HINT = 'run native/install-native-host.ps1 (or .sh) '
  + '— re-run it after moving or renaming this checkout.';

// One request/response over the native host. Binary reads arrive as a stream of
// {ok, chunk, done} messages: Firefox caps native→extension messages at 1 MB and
// a screenshot's base64 exceeds that, so the chunks are joined back here.
function nativeRequest(payload) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST);
    } catch (e) {
      reject(new Error('Native host unavailable — ' + NATIVE_HINT + ' ' + e.message));
      return;
    }
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      try { port.disconnect(); } catch (_) {}
      fn(value);
    };
    const parts = [];
    port.onMessage.addListener(msg => {
      if (!msg.ok) {
        finish(reject, new Error(`Native error (${payload.path ?? payload.cmd}): ${msg.error}`));
        return;
      }
      if (msg.chunk !== undefined) {
        parts.push(msg.chunk);
        if (msg.done) finish(resolve, { ...msg, content: parts.join('') });
        return;
      }
      finish(resolve, msg);
    });
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message ?? 'disconnected';
      finish(reject, new Error(`Native host disconnected: ${err} — ${NATIVE_HINT}`));
    });
    port.postMessage(payload);
  });
}

function readFileNative(path, binary = false) {
  return nativeRequest(binary ? { path, binary: true } : { path }).then(msg => msg.content);
}

// ── configuration ─────────────────────────────────────────────────────────────

// The popup hands over the bundled config.json. If it extends a project-owned
// file, that one is read through the native host — the add-on has no filesystem
// of its own. It must be an absolute path: an extension knows its
// moz-extension:// origin and never its location on disk, so there is nothing
// for a relative path to resolve against.
async function loadFullConfig(config) {
  if (!config.extends) return validateConfig(config);
  if (!isAbsolutePath(config.extends)) {
    throw new Error(`"extends" must be an absolute path (got "${config.extends}") — `
      + 'the add-on cannot resolve a relative one, having no path of its own.');
  }
  let raw;
  try {
    raw = await readFileNative(config.extends);
  } catch (e) {
    throw new Error(`Could not read the project config at ${config.extends}: ${e.message}\n`
      + 'Is that path inside one of the roots the native host is allowed to read? '
      + 'See native/allowed-roots.json.');
  }
  let base;
  try {
    base = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${config.extends} is not valid JSON: ${e.message}`);
  }
  const merged = mergeConfig(base, config);
  delete merged.extends;
  return validateConfig(merged);
}

// ── tab helpers ───────────────────────────────────────────────────────────────

function waitForTabComplete(tabId, timeoutMs = TAB_LOAD_MS) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdate);
      resolve();
    };
    const onUpdate = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
    chrome.tabs.onUpdated.addListener(onUpdate);
    chrome.tabs.get(tabId, t => { if (!chrome.runtime.lastError && t?.status === 'complete') finish(); });
    setTimeout(() => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdate);
      reject(new Error(`Timeout waiting for tab ${tabId}`));
    }, timeoutMs);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// A tab already showing this store, preferring the active one.
//
// Queried across every window rather than asking for the current one: clicking
// the toolbar button moves focus to the popup, so "the current window's active
// tab" is not reliably the page the operator was just looking at. Filtering the
// whole list on the driver's own host is both simpler and safe — a tab this
// driver does not own is never touched.
async function findStoreTab(driver) {
  if (typeof driver.ownsUrl !== 'function') return null;
  const tabs = await chrome.tabs.query({});
  const owned = tabs.filter(t => t.url && driver.ownsUrl(t.url));
  return owned.find(t => t.active) || owned[0] || null;
}

// ── failure type carrying page diagnostics ────────────────────────────────────

class PublishError extends Error {
  constructor(message, detail) {
    super(message);
    this.detail = detail;
  }
}

function fmtDetail(detail) {
  try { return JSON.stringify(detail, null, 1).slice(0, 1500); }
  catch { return String(detail); }
}

// ── screenshot replacement (delete all, upload 1..N) ──────────────────────────

async function waitForShotCount(driver, tabId, scope, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    await sleep(1000);
    const res = await driver.countScreenshots(tabId, scope);
    if (res?.ok) {
      last = res.count;
      if (res.count >= expected) return res.count;
    }
  }
  throw new PublishError(`Screenshot count (${scope}) did not reach ${expected} within ${timeoutMs / 1000}s (last: ${last})`, null);
}

async function replaceScreenshots(driver, tabId, ctx, locale, scope, onProgress) {
  const countRes = await driver.countScreenshots(tabId, scope);
  if (!countRes?.ok) throw new PublishError(`Screenshot section (${scope}) not found`, countRes);
  onProgress(`  ${scope} screenshots: ${countRes.count} existing`);

  let guard = MAX_DELETES;
  let remaining = countRes.count;
  while (remaining > 0 && guard-- > 0) {
    const res = await driver.deleteOneScreenshot(tabId, scope);
    if (!res?.ok) throw new PublishError('Screenshot delete failed', res);
    remaining = res.after;
  }
  if (remaining > 0) throw new PublishError(`Still ${remaining} screenshots after ${MAX_DELETES} delete attempts`, null);
  if (countRes.count > 0) onProgress('  screenshots: cleared');

  const total = screenshotsPerListing(ctx.profile);
  for (let i = 1; i <= total; i++) {
    const path = screenshotPath(ctx.assetsRoot, ctx.profile, ctx.item, locale, i);
    const name = baseName(path);
    const b64 = await readFileNative(path, true);

    const before = await driver.countScreenshots(tabId, scope);
    const up = await driver.uploadScreenshot(tabId, b64, name, scope);
    if (!up?.ok) throw new PublishError(`Upload of ${name} failed`, up);
    await waitForShotCount(driver, tabId, scope, (before?.count ?? 0) + 1, UPLOAD_WAIT_MS);
    onProgress(`  upload ${name} ✓`);
  }
}

// ── per-locale step ───────────────────────────────────────────────────────────

async function publishLocale(driver, tabId, locale, text, opts, ctx, onProgress) {
  onProgress(`${locale.internal} (${locale.name})`);

  const sel = await driver.selectLanguage(tabId, locale);
  if (!sel?.ok) throw new PublishError(`Language "${locale.name}" not selectable`, sel);
  onProgress(`  language → "${sel.selected}"${sel.confirmed === false ? ' (UNCONFIRMED)' : ''}`);
  if (sel.confirmed === false && !opts.dryRun) {
    throw new PublishError(`Language switch to "${locale.name}" could not be confirmed (combobox shows "${sel.trigger}") — aborting before writing into the wrong locale`, sel);
  }
  await sleep(SETTLE_FIELD_MS);

  if (opts.updateTexts) {
    const res = await driver.setDescription(tabId, text, !opts.dryRun);
    if (!res?.ok) throw new PublishError('Description field not updated', res);
    onProgress(opts.dryRun
      ? `  description target: "${res.label}" (currently ${res.currentLength} chars)`
      : `  description ✓ ${res.length} chars (field "${res.label}")`);
  }

  if (opts.updateImages) {
    if (opts.dryRun) {
      const c = await driver.countScreenshots(tabId, 'localized');
      onProgress(c?.ok
        ? `  localized screenshots: ${c.count} existing`
        : '  ⚠ localized screenshots card NOT found: ' + fmtDetail(c));
    } else {
      await replaceScreenshots(driver, tabId, ctx, locale, 'localized', onProgress);
    }
  }
}

// ── run ───────────────────────────────────────────────────────────────────────

async function runPublish(rawConfig, opts, onProgress) {
  const driver = DRIVERS[opts.store || 'cws'];
  if (!driver) throw new Error(`Unknown store driver: ${opts.store}`);

  const config = await loadFullConfig(rawConfig);
  validateLocales(config.locales);

  const item = config.items.find(i => i.slug === opts.itemSlug);
  if (!item) throw new Error(`Item "${opts.itemSlug}" not in the configuration`);

  const profile = config.assets[driver.assetProfile];
  if (!profile) {
    throw new Error(`config.assets.${driver.assetProfile} is missing — the ${driver.id} `
      + 'driver has no path templates to work from.');
  }

  // Nothing ticked would open a tab, walk every language and write nothing.
  if (!opts.probeOnly && !opts.updateTexts && !opts.updateImages && !opts.updateGlobalImages) {
    throw new Error('Nothing selected — tick at least one of the description / localized '
      + 'screenshots / international screenshots options, or use "Probe page".');
  }

  const walkLocales = needsLocaleWalk(opts);
  // Parsed even when unused, so a bad filter is still rejected up front.
  const locales = filterLocales(config.locales, opts.localeFilter);
  if (!walkLocales && opts.localeFilter) {
    onProgress(`Locale filter "${opts.localeFilter}" ignored — no per-language step selected.`);
  }

  // Which locale's screenshots fill the language-independent "Global assets"
  // card. English by convention; a project can say otherwise.
  const globalLocale = config.locales.find(l => l.internal === (config.globalLocale || 'en'))
    || config.locales[0];
  const ctx = { assetsRoot: config.assets.root, profile, item };

  if (!opts.probeOnly) onProgress(`Assets root: ${config.assets.root}`);

  // Pre-flight: read every description up front so a missing/stale file aborts
  // the run before the page is touched. (Skipped for a pure probe.)
  const texts = {};
  if (opts.updateTexts && !opts.probeOnly) {
    onProgress(`Pre-flight: reading ${locales.length} descriptions…`);
    for (const locale of locales) {
      texts[locale.internal] = await readFileNative(
        descriptionPath(ctx.assetsRoot, profile, item, locale));
    }
    onProgress('Pre-flight texts OK.');
  }
  if ((opts.updateImages || opts.updateGlobalImages) && !opts.probeOnly) {
    // Spot-check one image per concerned locale set (full bytes are read lazily).
    const probeLocale = opts.updateImages ? locales[0] : globalLocale;
    await readFileNative(screenshotPath(ctx.assetsRoot, profile, item, probeLocale, 1), true);
    onProgress('Pre-flight screenshots OK.');
  }

  // Open the listing page. The tab stays open at the end — the manual
  // "Save draft" + review is the operator's job.
  //
  // A probe REUSES a tab already showing this store, and only opens the listing
  // page when there is none. Opening a fresh tab is what a probe wants the first
  // time and exactly what it must not do afterwards: the pages worth dumping are
  // the ones you navigated to — a language's details page, a menu you opened —
  // and navigating away is precisely what destroys them.
  let tab = null;
  if (opts.probeOnly) tab = await findStoreTab(driver);

  if (tab) {
    onProgress(`Probing the open tab: ${tab.url}`);
    // Already rendered — no need to wait out the SPA's first paint.
    await sleep(500);
  } else {
    const url = driver.listingUrl(config, item);
    onProgress(`Opening ${url}`);
    tab = await chrome.tabs.create({ url, active: true });
    await waitForTabComplete(tab.id);
    const { url: finalUrl } = await chrome.tabs.get(tab.id);
    if (driver.isLoginUrl(finalUrl)) {
      throw new Error(`Not logged in — redirected to ${finalUrl}. Log in in this profile and re-run.`);
    }
    await sleep(SETTLE_PAGE_MS);
  }

  if (opts.probeOnly) {
    const probe = await driver.probe(tab.id);
    onProgress('Probe result:');
    onProgress(JSON.stringify(probe, null, 1)); // full dump, never truncated
    return;
  }

  // The language walk is only for what lives behind the language dropdown: the
  // description and the "Localized assets" screenshots. Skipping it when neither
  // is selected is not just a speed-up — a single unconfirmed language switch
  // throws, and the global block below sits *after* this loop, so a global-only
  // run could abort before ever reaching what it was asked to do.
  if (walkLocales) {
    for (const locale of locales) {
      try {
        await publishLocale(driver, tab.id, locale, texts[locale.internal], opts, ctx, onProgress);
      } catch (e) {
        if (e.detail) onProgress('Diagnostics: ' + fmtDetail(e.detail));
        onProgress(`Aborted at locale "${locale.internal}". Fix the issue (see stores/${driver.id}.js), then resume with filter "from:${locale.internal}".`);
        throw e;
      }
    }
  } else {
    onProgress('No per-language step selected — skipping the language walk.');
  }

  // International / global screenshots: the "Global assets" card on the same
  // page, independent of the selected language. Replaced once per deployment.
  if (opts.updateGlobalImages) {
    onProgress(`International screenshots (Global assets) → ${globalLocale.internal} set…`);
    if (opts.dryRun) {
      const c = await driver.countScreenshots(tab.id, 'global');
      onProgress(c?.ok
        ? `  global screenshots: ${c.count} existing`
        : '  ⚠ global screenshots card NOT found: ' + fmtDetail(c));
    } else {
      await replaceScreenshots(driver, tab.id, ctx, globalLocale, 'global', onProgress);
    }
  }

  onProgress('All done. Review the page, then click "Save draft" yourself — nothing has been saved.');
}

// ── persistent run log ──────────────────────────────────────────────────────
// The popup window is destroyed whenever it loses focus, taking its in-DOM log
// with it. So the background owns the log: every line is mirrored to
// storage.local, which survives popup close (and service-worker restarts) and
// is broadcast to the popup live via chrome.storage.onChanged. Starting a run
// clears the buffer, so relaunching an action wipes the previous output.

let runLog = [];

function pushLog(text, cls, state) {
  runLog.push(cls ? { text, cls } : { text });
  const data = { run_log: runLog };
  if (state) data.run_state = state;
  chrome.storage.local.set(data);
}

function resetLog() {
  runLog = [];
  chrome.storage.local.set({ run_log: runLog, run_state: 'running' });
}

// ── message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // The popup needs the item list before it can offer a run, and that list may
  // live in the project config behind "extends" — which only the native host
  // can read. So the popup asks here instead of resolving it itself.
  if (msg.type === 'RESOLVE_CONFIG') {
    loadFullConfig(msg.config)
      .then(config => {
        validateLocales(config.locales);
        sendResponse({ ok: true, config });
      })
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type !== 'START_PUBLISH') return;
  const { config, opts } = msg;
  (async () => {
    resetLog();
    pushLog(opts.probeOnly ? 'Probing…' : 'Starting…');
    try {
      await runPublish(config, opts, status => pushLog(status));
      pushLog('Done.', 'ok', 'done');
      sendResponse({ ok: true });
    } catch (e) {
      pushLog('Error: ' + e.message, 'err', 'error');
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;
});

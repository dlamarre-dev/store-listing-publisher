const itemSel    = document.getElementById('item');
const storeSel   = document.getElementById('store');
const optTexts   = document.getElementById('optTexts');
const optImages  = document.getElementById('optImages');
const optGlobal  = document.getElementById('optGlobalImages');
const globalRow  = document.getElementById('optGlobalImagesRow');
const optDryRun  = document.getElementById('optDryRun');
const filterIn   = document.getElementById('filter');
const runBtn     = document.getElementById('run');
const probeBtn   = document.getElementById('probe');
const stopBtn    = document.getElementById('stop');
const logEl      = document.getElementById('log');
const noteEl     = document.getElementById('note');

// Rebuild the log view from the persisted buffer. The background owns the log
// (see background.js): rendering purely from storage means focus loss — which
// destroys this popup — never loses output, and reopening restores it.
function renderLog(log) {
  logEl.textContent = '';
  if (!log || !log.length) { logEl.style.display = 'none'; return; }
  logEl.style.display = 'block';
  for (const { text, cls } of log) {
    const line = document.createElement('div');
    if (cls) line.className = cls;
    line.textContent = text;
    logEl.appendChild(line);
  }
  logEl.scrollTop = logEl.scrollHeight;
}

// Local-only notice (e.g. config-load failure) that never reaches the background.
function appendLocal(text, cls) {
  logEl.style.display = 'block';
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = text;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

// The bundled half. It may be almost nothing — just "extends" plus the secrets.
// It has to sit beside manifest.json: an extension can only fetch resources from
// its own directory, and Firefox reports a missing one as a bare network failure
// ("The operation was aborted."), which says nothing about what to do.
async function loadBundledConfig() {
  const url = chrome.runtime.getURL('config.json');
  let resp;
  try {
    resp = await fetch(url);
  } catch (e) {
    throw new Error('config.json is missing from the add-on directory. '
      + 'Copy extension/config.example.json to extension/config.json and fill it in. '
      + `(${e.message})`);
  }
  if (!resp.ok) {
    throw new Error(`config.json could not be read (HTTP ${resp.status}) — `
      + 'copy extension/config.example.json to extension/config.json.');
  }
  try {
    return await resp.json();
  } catch (e) {
    throw new Error(`config.json is not valid JSON: ${e.message}`);
  }
}

// "extends" points at a file on disk, which only the native host can read, so
// the merge happens in the background and the popup asks for the result. That
// resolved object is what a run is then started with — no second resolution,
// and one place where the schema is validated.
function resolveConfig(raw) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'RESOLVE_CONFIG', config: raw }, res => {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      if (!res?.ok) { reject(new Error(res?.error || 'Could not resolve the configuration.')); return; }
      resolve(res.config);
    });
  });
}

let resolvedConfig = null;
// What each store can be asked for, from the drivers themselves (STORE_INFO).
let storeInfo = {};

// Greys out the options the selected store has no card for.
//
// Partner Center has no global assets card — each language owns every screenshot
// on its own details page — so "Replace international screenshots" means nothing
// there, and what it would have done is worse than nothing: a "global" upload
// lands on whichever language's page is open. Which store that is, is the
// driver's fact; this only reflects it.
//
// Unticked as well as disabled, because a disabled checkbox still reports
// `checked` and the run would be asked for it anyway.
function applyStoreCapabilities() {
  const scopes = storeInfo[storeSel.value]?.screenshotScopes;
  // Unknown store, or an answer that has not arrived: offer everything rather
  // than silently hide an option that does exist.
  const hasGlobal = !scopes || scopes.includes('global');
  optGlobal.disabled = !hasGlobal;
  if (!hasGlobal) optGlobal.checked = false;
  globalRow.classList.toggle('unavailable', !hasGlobal);
  // The store's own label, not its id: this is a sentence the operator reads.
  const label = storeSel.options[storeSel.selectedIndex]?.textContent || storeSel.value;
  globalRow.title = hasGlobal ? ''
    : `${label} gives each language its own page, so every screenshot on one `
      + 'belongs to that language. There is no international set to replace.';
}

storeSel.addEventListener('change', applyStoreCapabilities);

function showNote(text) {
  noteEl.textContent = text || '';
  noteEl.style.display = text ? 'block' : 'none';
}

// The button states, from one place, because there are now three buttons and two
// of them mean the opposite thing.
//
// `running` is never inferred from the log or from a leftover in storage — only
// the background knows, and it is asked. A run_state of "running" survives the
// page that was running, and believing it is what left this popup with every
// button greyed out and no way back short of reloading the add-on.
function applyState(state) {
  const running  = state === 'running' || state === 'stopping';
  const stopping = state === 'stopping';
  runBtn.disabled   = running || !resolvedConfig;
  probeBtn.disabled = running || !resolvedConfig;
  stopBtn.disabled  = !running || stopping;
  stopBtn.textContent = stopping ? 'Stopping…' : 'Stop';
  if (state === 'interrupted') {
    showNote('The previous run ended when the add-on was reloaded or the '
      + 'background page was unloaded. Nothing is running — you can start again.');
  }
}

function currentOpts(probeOnly) {
  return {
    store: storeSel.value,
    itemSlug: itemSel.value,
    updateTexts: optTexts.checked,
    updateImages: optImages.checked,
    updateGlobalImages: optGlobal.checked,
    dryRun: optDryRun.checked,
    localeFilter: filterIn.value.trim(),
    probeOnly: !!probeOnly,
  };
}

function start(probeOnly) {
  if (!resolvedConfig) return;
  applyState('running');
  showNote('');
  const opts = currentOpts(probeOnly);
  chrome.storage.local.set({ publisher_opts: opts });

  // Progress and the final result are reflected via storage.local, so the
  // sendMessage callback carries nothing a run needs — it would be dropped if the
  // popup closed first. A refusal is the exception: the background turns one down
  // synchronously, before any of it is logged, so this is the only place it can be
  // heard.
  chrome.runtime.sendMessage({ type: 'START_PUBLISH', config: resolvedConfig, opts }, res => {
    if (chrome.runtime.lastError) return;
    if (res && res.ok === false && res.error) {
      showNote(res.error);
      askState();
    }
  });
}

runBtn.addEventListener('click', () => start(false));
probeBtn.addEventListener('click', () => start(true));
stopBtn.addEventListener('click', () => {
  stopBtn.disabled = true;
  chrome.runtime.sendMessage({ type: 'STOP_RUN' }, () => {
    if (chrome.runtime.lastError) return;
    askState();
  });
});

// What the background says, not what storage remembers.
function askState() {
  chrome.runtime.sendMessage({ type: 'RUN_STATE' }, res => {
    if (chrome.runtime.lastError) { applyState('error'); return; }
    if (!res?.running) {
      // Keep whatever storage says only when it agrees that nothing is running;
      // "done" and "error" colour nothing here, but "running" would.
      chrome.storage.local.get(['run_state'], ({ run_state }) => {
        applyState(run_state === 'running' || run_state === 'stopping'
          ? 'interrupted' : run_state);
      });
      return;
    }
    applyState(res.stopping ? 'stopping' : 'running');
  });
}

// Live updates from the background, broadcast even while the popup was closed.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.run_log)   renderLog(changes.run_log.newValue);
  if (changes.run_state) applyState(changes.run_state.newValue);
  // Written when a run aborts or is stopped: where a Run would have to pick up.
  // Offered in the field rather than applied behind a button, so what the next
  // run will do is on screen before it is asked for.
  if (changes.run_resume && changes.run_resume.newValue) {
    const { filter, locale, reason } = changes.run_resume.newValue;
    filterIn.value = filter;
    showNote(reason === 'stopped'
      ? `Stopped before "${locale}". Filter set to "${filter}" — Run picks up there.`
      : `Aborted on "${locale}". Filter set to "${filter}" — Run retries it and carries on.`);
  }
});

// Populate the item dropdown from config, restore the last-used options, and
// restore any log from a previous (possibly still-running) run.
applyState(null);
// Asked once, before the config: the options it greys out are on screen from the
// first paint, and it does not depend on a config that may fail to load.
chrome.runtime.sendMessage({ type: 'STORE_INFO' }, res => {
  if (chrome.runtime.lastError || !res?.ok) return;
  storeInfo = res.stores;
  applyStoreCapabilities();
});
loadBundledConfig()
  .then(resolveConfig)
  .then(config => {
    resolvedConfig = config;
    for (const item of config.items) {
      const opt = document.createElement('option');
      opt.value = item.slug;
      opt.textContent = item.name;
      itemSel.appendChild(opt);
    }
    chrome.storage.local.get(['publisher_opts', 'run_log', 'run_resume'], ({ publisher_opts: saved, run_log, run_resume }) => {
      if (saved) {
        if (config.items.some(i => i.slug === saved.itemSlug)) itemSel.value = saved.itemSlug;
        if (saved.store) storeSel.value = saved.store;
        optTexts.checked  = saved.updateTexts !== false;
        optImages.checked = !!saved.updateImages;
        optGlobal.checked = !!saved.updateGlobalImages;
        optDryRun.checked = !!saved.dryRun;
        filterIn.value    = saved.localeFilter || '';
      }
      // After the saved options, so a pending resume wins over the filter the
      // stopped run was started with.
      if (run_resume) {
        filterIn.value = run_resume.filter;
        showNote(`Last run ${run_resume.reason === 'stopped' ? 'stopped' : 'aborted'} — `
          + `filter set to "${run_resume.filter}".`);
      }
      // After the saved options: a run remembered from a store that has a global
      // card must not leave the box ticked on one that has none.
      applyStoreCapabilities();
      renderLog(run_log);
      askState();
    });
  })
  .catch(e => appendLocal(e.message, 'err'));

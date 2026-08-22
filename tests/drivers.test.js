// Every store driver must expose the same surface, and a driver that is not
// finished must refuse rather than half-work.
//
// The orchestration in background.js calls the driver blind: it aborts on
// `ok: false` and prints the detail, which is what makes an incomplete driver
// safe — but only if the incomplete steps actually return `ok: false` instead of
// undefined. A step returning undefined reads as "no result" and the code path
// after it is not designed for that.
//
// The stores/ files are plain scripts loaded as manifest background scripts, so
// there is nothing to require. They are evaluated here in a sandbox with a stub
// `chrome`, which is also a check that they have no side effects at load time.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

function loadDrivers() {
  const sandbox = {
    chrome: { scripting: { executeScript: async () => [{ result: null }] } },
    getComputedStyle: () => ({}),
    document: { querySelectorAll: () => [] },
    location: { href: '' },
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    console,
  };
  // One script, not one per file: a top-level `const` in a vm script is a
  // lexical binding, not a property of the global, so separate runs cannot see
  // each other's drivers — or expose them to us. The browser loads these into
  // one shared scope too, so concatenating is also the truer simulation.
  const sources = ['stores/cws.js', 'stores/edge.js']
    .map((f) => fs.readFileSync(path.join(ROOT, 'extension', f), 'utf8'));
  sources.push('globalThis.__drivers = { cws: CwsDriver, edge: EdgeDriver };');
  vm.runInContext(sources.join('\n;\n'), vm.createContext(sandbox),
                  { filename: 'stores/*.js' });
  return sandbox.__drivers;
}

// The interface documented at the bottom of stores/cws.js.
const SURFACE = [
  'id', 'assetProfile', 'listingUrl', 'isLoginUrl', 'probe', 'selectLanguage',
  'setDescription', 'countScreenshots', 'deleteOneScreenshot', 'uploadScreenshot',
];
const STEPS = ['selectLanguage', 'setDescription', 'countScreenshots',
               'deleteOneScreenshot', 'uploadScreenshot'];

const drivers = loadDrivers();

test('both drivers load with no side effects and no chrome calls', () => {
  expect(Object.keys(drivers).sort()).toEqual(['cws', 'edge']);
  expect(drivers.cws).toBeDefined();
  expect(drivers.edge).toBeDefined();
});

describe.each(Object.entries(drivers))('%s driver', (name, driver) => {
  test('exposes the whole interface', () => {
    const missing = SURFACE.filter((k) => driver[k] === undefined);
    expect(missing).toEqual([]);
  });

  test('its id matches how it is registered', () => {
    expect(driver.id).toBe(name);
  });

  // The driver decides which block of config.assets it reads, so a mismatch here
  // would resolve paths for the wrong store.
  test('names an asset profile', () => {
    expect(typeof driver.assetProfile).toBe('string');
    expect(driver.assetProfile.length).toBeGreaterThan(0);
  });

  // ownsUrl is what lets a probe reuse a page already open instead of navigating
  // away from it. It decides where the driver will inject, so a loose pattern is
  // the difference between "dump this page" and "run my code on any site".
  test('claims its own host and nothing else', () => {
    expect(typeof driver.ownsUrl).toBe('function');
    const foreign = [
      'https://example.com/',
      'https://partner.microsoft.com.evil.test/dashboard/microsoftedge/x',
      'https://chrome.google.com.evil.test/webstore/devconsole/x',
      'about:blank',
      'moz-extension://abc/popup.html',
    ];
    for (const url of foreign) {
      expect({ url, owned: driver.ownsUrl(url) }).toEqual({ url, owned: false });
    }
  });

  test('every step is callable', () => {
    for (const step of STEPS) {
      expect(typeof driver[step]).toBe('function');
    }
  });
});

describe('ownsUrl recognises each store', () => {
  test('the CWS dev console', () => {
    expect(drivers.cws.ownsUrl(
      'https://chrome.google.com/webstore/devconsole/abc/def/edit/listing?hl=en')).toBe(true);
    // Not the public storefront, which the driver has no business touching.
    expect(drivers.cws.ownsUrl(
      'https://chrome.google.com/webstore/detail/abc')).toBe(false);
  });

  test('the Edge dashboard, including the locale segment Partner Center adds', () => {
    expect(drivers.edge.ownsUrl(
      'https://partner.microsoft.com/dashboard/microsoftedge/GUID/listings')).toBe(true);
    expect(drivers.edge.ownsUrl(
      'https://partner.microsoft.com/en-us/dashboard/microsoftedge/GUID/listings')).toBe(true);
    // partner.microsoft.com hosts other programs; those are not ours.
    expect(drivers.edge.ownsUrl(
      'https://partner.microsoft.com/en-us/dashboard/commercial-marketplace/x')).toBe(false);
  });
});

describe('the Edge driver is honest about being unfinished', () => {
  // Split by what the Store listings dump settled. selectLanguage is written
  // against the real aria-labels ("Edit <Language> language details page"); the
  // rest live on a "Details for <language>" page that has not been probed, and
  // must keep refusing until it has been.
  const IMPLEMENTED = ['probe', 'listLanguages', 'selectLanguage'];
  const PENDING = STEPS.filter((s) => !IMPLEMENTED.includes(s));

  test('the split adds up, so neither list can silently empty out', () => {
    expect(PENDING.length).toBeGreaterThan(0);
    expect(PENDING).not.toContain('selectLanguage');
  });

  test.each(PENDING)('%s refuses instead of returning nothing', async (step) => {
    const result = await drivers.edge[step](1, 'x', 'y', 'z');
    expect(result).toMatchObject({ ok: false, step: 'not-implemented', store: 'edge' });
    // The refusal has to say what to do next, or a run just stops with no clue.
    expect(result.detail).toMatch(/Probe page/);
    expect(result.detail).toMatch(/Details for/);
  });

  test.each(IMPLEMENTED)('%s is wired to the page, not stubbed', async (step) => {
    const result = await drivers.edge[step](1, { name: 'English' });
    // Says what it means rather than pinning a shape: the sandbox's
    // executeScript resolves to null, so an implemented step comes back null or
    // wrapping null. Only a stub carries the not-implemented marker.
    expect(result && result.step).not.toBe('not-implemented');
  });

  // One Probe click has to be enough, because the operator cannot hold a menu
  // open across it — clicking the toolbar button moves focus out of the page.
  test('probing reports the Add a language control in the same dump', async () => {
    const result = await drivers.edge.probe(1);
    expect(result).toHaveProperty('addLanguage');
  });

  test('its listing URL is built from the product id and is overridable', () => {
    const config = { edge: { productIds: { app: 'GUID-1' } } };
    const url = drivers.edge.listingUrl(config, { slug: 'app' });
    expect(url).toContain('partner.microsoft.com');
    expect(url).toContain('GUID-1');
    // The exact route is undocumented, so it can be corrected from config rather
    // than needing a code change once the probe reveals it.
    const overridden = drivers.edge.listingUrl(
      { edge: { ...config.edge, edgeListingPath: 'listings/en-us' } }, { slug: 'app' });
    expect(overridden).toContain('listings/en-us');
  });

  // Partner Center signs in through Entra, so the redirect can land on more than
  // one host; missing that would look like "the listing page has no fields".
  test('it recognises the login redirect', () => {
    expect(drivers.edge.isLoginUrl('https://login.microsoftonline.com/x')).toBe(true);
    expect(drivers.edge.isLoginUrl(
      'https://partner.microsoft.com/dashboard/microsoftedge/public/login?ref=dd')).toBe(true);
    expect(drivers.edge.isLoginUrl(
      'https://partner.microsoft.com/dashboard/microsoftedge/GUID/listings')).toBe(false);
  });
});

describe('the manifest loads every driver', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'extension/manifest.json'), 'utf8'));
  // The keys of the DRIVERS map in background.js, read from source: it is a
  // background script, so there is nothing to import.
  const registered = [...fs.readFileSync(path.join(ROOT, 'extension/background.js'), 'utf8')
    .match(/const DRIVERS = \{([^}]*)\}/)[1]
    .matchAll(/(\w+)\s*:/g)].map((m) => m[1]);

  test.each(Object.keys(drivers))('%s is a background script', (name) => {
    expect(manifest.background.scripts).toContain(`stores/${name}.js`);
  });

  test('DRIVERS registers exactly the drivers that exist', () => {
    expect(registered.sort()).toEqual(Object.keys(drivers).sort());
  });

  // Driving a page needs permission for its host. Forgetting this fails at
  // executeScript with an error about the tab, not about the manifest.
  test('each store host is permitted', () => {
    const hosts = manifest.host_permissions.join(' ');
    expect(hosts).toContain('chrome.google.com');
    expect(hosts).toContain('partner.microsoft.com');
  });
});

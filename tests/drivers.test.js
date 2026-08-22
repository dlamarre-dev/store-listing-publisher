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

// Everything the drivers need, in load order.
const SCRIPTS = ['lib/locales.js', 'stores/cws.js', 'stores/edge.js'];

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
  // lib/locales.js first: stores/edge.js calls languageNames() from it, so this
  // list is also the load order the manifest has to declare. A test asserts that
  // below — get it wrong in the manifest and the driver throws a ReferenceError
  // on the first language, in the browser, at run time.
  const sources = SCRIPTS
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
  // Every step is written against a dump of the real page now. uploadScreenshot
  // was the last holdout: four asset slots expose identical hidden .png inputs,
  // and it refused until a probe showed that the component each lives in —
  // <screenshots> for this one — is what separates them.
  const IMPLEMENTED = STEPS.slice();
  const PENDING = [];

  test('nothing is left refusing', () => {
    expect(PENDING).toEqual([]);
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

// Enrolment — adding a language before it can be written — exists for exactly one
// store, and that is precisely why it must not be written as "if this is Edge".
// The orchestration stays store-agnostic by asking the driver what it can do.
describe('enrolment is gated on a capability, not on a store name', () => {
  const background = fs.readFileSync(path.join(ROOT, 'extension/background.js'), 'utf8');

  test('only the Edge driver claims it', () => {
    expect(typeof drivers.edge.addLanguage).toBe('function');
    // The CWS dropdown lists every language whether you touched it or not, so
    // there is nothing to enrol and the whole pass is skipped there.
    expect(drivers.cws.addLanguage).toBeUndefined();
  });

  test('the orchestration checks for the method, never for the id', () => {
    expect(background).toContain("typeof driver.addLanguage !== 'function'");
    expect(background).toContain("typeof driver.saveDraft === 'function'");
    // A store name in the orchestration is the thing this design exists to avoid.
    expect(background).not.toMatch(/driver\.id\s*===\s*['"]edge['"]/);
    expect(background).not.toMatch(/opts\.store\s*===\s*['"]edge['"]/);
  });

  // Each language is its own page on Partner Center and leaving one discards the
  // field, so a run without this writes 43 descriptions and keeps none. The CWS
  // keeps all 43 behind one dropdown, so its single manual save still covers them
  // and it deliberately has no saveDraft.
  test('only the store that needs saving per language claims saveDraft', () => {
    expect(typeof drivers.edge.saveDraft).toBe('function');
    expect(drivers.cws.saveDraft).toBeUndefined();
  });

  // A failed save must abort. Writing and not saving is the one failure mode that
  // looks like success in the log and leaves nothing behind.
  test('a save that did not happen stops the run', () => {
    const clause = background.slice(background.indexOf('driver.saveDraft(tabId)'));
    expect(clause).toContain('throw new PublishError');
    expect(clause).toContain('lost silently');
  });

  test('and a dry run never saves', () => {
    expect(background).toContain("!opts.dryRun && typeof driver.saveDraft === 'function'");
  });

  // Partner Center has no Filipino at all. Aborting a 42-language pass over one
  // language that can never work would be the wrong call, so it is skipped and
  // reported — while any other failure still stops the run.
  test('a language the store does not offer is skipped, not fatal', () => {
    expect(background).toContain("res?.step === 'language-not-offered'");
    const clause = background.slice(background.indexOf("'language-not-offered'"));
    const skip = clause.indexOf('continue');
    const abort = clause.indexOf('throw new PublishError');
    expect(skip).toBeGreaterThan(-1);
    expect(skip).toBeLessThan(abort);
  });

  // Re-running has to resume, not duplicate: it is 42 steps the first time and
  // zero every time after, and the first time can fail partway.
  test('it asks what is already there before adding anything', () => {
    const pass = background.slice(background.indexOf('async function enrolLocales'));
    expect(pass.indexOf('listLanguages')).toBeLessThan(pass.indexOf('addLanguage(tabId'));
    expect(pass).toContain('missingLocales(');
  });

  test('and writes nothing on a dry run', () => {
    const pass = background.slice(background.indexOf('async function enrolLocales'));
    expect(pass.indexOf('opts.dryRun')).toBeLessThan(pass.indexOf('addLanguage(tabId'));
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

  // A real ordering dependency now: stores/edge.js calls languageNames() at
  // driver level. Loaded in the wrong order it is a ReferenceError on the first
  // language — in the browser, mid-run, with 42 to go.
  test('every script a driver depends on loads before it', () => {
    const loaded = manifest.background.scripts;
    for (const script of SCRIPTS) {
      expect(loaded).toContain(script);
    }
    expect(loaded.indexOf('lib/locales.js'))
      .toBeLessThan(loaded.indexOf('stores/edge.js'));
  });
});

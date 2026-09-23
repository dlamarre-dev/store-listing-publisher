# Store Listing Publisher

Operator tooling to publish a browser extension: the package, the release
lifecycle, and the localized listing (descriptions and screenshots), built from
marketing assets on your own disk.

| | Package + release lifecycle | Listing metadata |
|---|---|---|
| **Chrome Web Store** | `cws/cws_publish.py` (API v2) | `extension/`, a Firefox add-on driving the dev console ([no API exists](#why-the-add-on-exists)) |
| **Microsoft Edge Add-ons** | `edge/edge_publish.py` (API v1.1) | `extension/`, driving Partner Center ([no API exists](#why-the-add-on-exists)) |
| **addons.mozilla.org** | `amo/amo_publish.py` (API v5) | `amo/amo_publish.py` (API v5) |

The split follows what each store allows, not the store itself. Where the add-on
appears, it is not a fallback: it is the only way there is.

Three principles:

- **It invents nothing.** You point it at a directory of assets and it puts them
  in the right fields, in the right language, in the right order.
- **Nothing publishes by surprise.** Every write is a dry run unless you pass
  `--apply`, and nothing ever submits a listing for review. That stays a human
  decision in the console.
- **Saving follows the store.** The Chrome Web Store keeps every language on one
  page, so a run leaves the draft filled in and you click **Save draft**. Partner
  Center gives each language its own page and discards unsaved edits when you
  leave it, so an Edge run saves each page as it goes. The last log line says
  which one happened.

---

## Quick start

```bash
git clone https://github.com/dlamarre-dev/store-listing-publisher
cd store-listing-publisher
npm install                     # jest and jsdom, for the tests
cp extension/config.example.json extension/config.json
```

Then:

1. **Describe your assets** in the config (see [Configuration](#configuration)).
   Start from `examples/per-language-dirs.config.json` (one directory per
   language) or `examples/flat-layout.config.json` (language in the filename).
2. **Install the native messaging host**, naming every directory it may read.
   The add-on has no filesystem access of its own; this host reads your PNGs and
   text files, and refuses any path outside the roots you list.
   ```powershell
   .\native\install-native-host.ps1 -Root E:\my-project
   .\native\install-native-host.ps1 -Root E:\my-project,D:\other-assets   # several
   ```
   ```bash
   ./native/install-native-host.sh /srv/marketing
   ./native/install-native-host.sh /srv/marketing /home/me/my-project     # several
   ```
3. **Load the add-on**: Firefox, `about:debugging`, This Firefox, Load Temporary
   Add-on, then pick `extension/manifest.json`. Reload it after each Firefox
   restart. Sign in to the account with publisher access in that profile: the
   browser session is the only authentication.
4. **Click Dry run first.** It walks every language and locates every field
   without writing anything. Always do this on a console layout you have not
   seen the tool work on.

### Releasing

```bash
# Chrome Web Store: package and lifecycle
python cws/cws_publish.py --item my-extension --status                    # read-only
python cws/cws_publish.py --item my-extension --upload --apply            # new draft
#   ... the add-on fills the localized listing, you click Save draft ...
python cws/cws_publish.py --item my-extension --publish --staged --apply
python cws/cws_publish.py --item my-extension --rollout 50 --apply

# Microsoft Edge: package and lifecycle
python edge/edge_publish.py --item my-extension --upload --apply
python edge/edge_publish.py --item my-extension --publish --apply
python edge/edge_publish.py --item my-extension --status

# addons.mozilla.org: package and listing, both by API
python amo/amo_publish.py --item my-extension --upload-version           # dry run
python amo/amo_publish.py --item my-extension --texts --images --apply   # live
```

A dry run makes no API call and needs **no credentials**, so you can check the
resolved package path and the exact request body before setting up any auth.

The scripts use the standard library only, except service-account auth for the
Chrome Web Store (see [Authentication](#authentication)).

---

## Configuration

The config has two layers:

- **The project file**, committed in the repo of the project being published. It
  holds items, path templates and the locale table, where that project's own
  tests can check them.
- **`extension/config.json`**, in this tool, gitignored. It holds only secrets
  and machine-specific paths, and points at the project file with `extends`:

```json
{
  "extends": "E:/my-project/store-publisher.config.json",
  "publisher_id": "your-cws-publisher-uuid",
  "assets": { "root": "/absolute/path/to/your/project" },
  "cws": { "serviceAccountKey": "/path/to/service-account-key.json" },
  "amo": { "jwt_issuer": "user:...", "jwt_secret": "..." }
}
```

Merge rules: local values win; objects merge key by key (a local
`amo: { jwt_secret }` keeps the project's `amo: { previewSet }`); arrays are
replaced whole. You can also skip `extends` and keep everything in one file.

Two constraints:

- **`config.json` must sit in `extension/`, beside `manifest.json`.** It is the
  only place the add-on can read, and the Python scripts look there too. Anywhere
  else, Firefox fails with a bare *"The operation was aborted."* Use `--config`
  to point the Python scripts elsewhere.
- **`extends` must be an absolute path** for the add-on, which does not know its
  own location on disk. `amo_publish.py` accepts a relative one.

### Path templates

No asset layout is hard-coded. Placeholders:

| Placeholder | Value |
|---|---|
| `{slug}` | the item's slug |
| `{lang}` | the locale's internal code (`pt_BR`, `zh_CN`) |
| `{LANG}` | uppercase of `fileCode`, or of `internal` if unset |
| `{cwsLang}` | the Chrome Web Store code (`pt-BR`, `iw`, `no`) |
| `{amoLang}` | the AMO code, or empty when the locale is not on AMO |
| `{n}` | screenshot index, 1-based |
| `{version}` | the built package's version, read from `versionSource` |

Default layout, one directory per language:

```json
"assets": {
  "root": "/srv/marketing",
  "chrome": {
    "description": "{slug}/{lang}/description.txt",
    "screenshot":  "{slug}/{lang}/{n}.png",
    "screenshotsPerListing": 5
  },
  "firefox": { "...": "same shape; omit it if you only publish to one store" }
}
```

`{LANG}` covers filenames that use a code that is neither yours nor a store's:
set `"fileCode": "CN"` on that locale and `{LANG}` follows it.

An unresolved placeholder is a hard error. A template missing `{lang}` would
otherwise publish the same text in every language.

### The package

`cws_publish.py --upload` and `amo_publish.py --upload-version` locate the built
ZIP from a template, and read the version from the built manifest:

```json
"chrome": {
  "package": "dist/{slug}-chrome-v{version}.zip",
  "versionSource": { "path": "dist/{slug}/chrome/manifest.json", "key": "version" }
}
```

Reading the version from the build (instead of taking it as an argument) means
it cannot disagree with the uploaded file. `versionSource` accepts Chrome's
`{"key": {"message": …}}` wrapper. `--package <path>` bypasses all this for a
one-off.

### The locale table

```json
"locales": [
  { "internal": "en", "cws": "en", "amo": "en-US", "name": "English",
    "altNames": ["English (United States)"] },
  { "internal": "he", "cws": "iw", "amo": "he", "name": "Hebrew" },
  { "internal": "zh_CN", "cws": "zh-CN", "amo": "zh-CN", "name": "Chinese (China)",
    "altNames": ["Chinese (Simplified)"], "fileCode": "CN" }
]
```

| Field | Meaning |
|---|---|
| `internal` | your own code; everything else is keyed on it |
| `cws` | the Chrome Web Store code, which often differs: `iw` (Hebrew), `no` (Norwegian), `fil` (Filipino), dashes for regional variants |
| `amo` | the AMO code, or `null` if AMO does not support that language (its texts are then skipped, with a log line) |
| `name` | the English label in the CWS language dropdown. The trailing code in `"French – fr"` is matched first, so small wording changes do not break a run |
| `altNames` | extra labels to try if the console's wording differs |

Duplicate `internal` or `cws` codes are rejected: one language would be written
twice, the second time with another locale's text.

### AMO extras

```json
"amo": {
  "previewSet": "en-only",
  "summarySource": { "path": "{slug}/{lang}/messages.json", "key": "extDesc" },
  "nameSource":    { "path": "{slug}/{lang}/messages.json", "key": "extName" }
}
```

AMO previews are **not** localized: each listing has one shared gallery.
`previewSet` chooses what goes in it:

- `en-only` (default): the base locale's screenshots.
- `en-plus-first-per-locale`: those, plus the first screenshot of every other
  language, to show the listing is translated. One extra upload per language.

`summarySource` and `nameSource` are optional and read one string per locale
from a JSON file. The key may be nested one level, as in Chrome's
`messages.json` (`{"extName": {"message": "…"}}`). If omitted, those fields are
left untouched. The name is only sent where it differs from the live listing,
since AMO throttles writes and every edit is immediate.

---

## Authentication

### Chrome Web Store

Pick one mode under `cws`:

- **Service account** (recommended). Create one in Google Cloud, grant it API
  access from the Developer Dashboard, and set `cws.serviceAccountKey` to its
  JSON key file. It never expires. Requires `pip install cryptography`, because
  the JWT is RS256-signed; it is imported only on this path.
- **OAuth refresh token**: `cws.client_id`, `cws.client_secret` and
  `cws.refresh_token`, from the
  [OAuth Playground flow](https://developer.chrome.com/docs/webstore/using-api).
  No dependency, but while the OAuth consent screen is in "Testing" **the token
  expires every 7 days**, so you redo the flow at every release.

Both end with a bearer token for `https://www.googleapis.com/auth/chromewebstore`.

### Microsoft Edge

`edge.client_id` and `edge.api_key`, from Partner Center > Microsoft Edge >
**Publish API** > *Create API credentials*. v1.1 sends them as two headers: no
token exchange, no signing, no expiry. (v1's `client_credentials` flow is not
supported; it ended 31 December 2024.)

`edge.productIds` maps each item slug to its Partner Center **GUID**. Do not use
the 32-letter id from the public store URL: it fails with a bare 404, so the
format is checked up front.

### addons.mozilla.org

`amo.jwt_issuer` and `amo.jwt_secret`, from
<https://addons.mozilla.org/developers/addon/api/key/>. HS256, standard library
only.

### The add-on

No credentials. It acts as whoever is signed in to the Firefox profile, and only
checks whether it was redirected to a login page.

---

## Using the add-on

The add-on fills the listing draft. It does not upload packages or publish: use
the Python scripts for that, and `cws_publish.py --status` to check whether a
draft is already in review before writing into it.

| Control | What it does |
|---|---|
| **Extension** | the item to publish, from `items` in your config |
| **Update detailed descriptions** | replaces the description in every locale |
| **Replace the localized screenshots per locale** | deletes the existing ones, then uploads `1..N` in order |
| **Replace international screenshots** | the global, non-localized slots. On its own, this skips the language walk entirely |
| **Dry run** | navigates and locates every field, writes nothing |
| **Locale filter** | empty = all; `fr,de` = only those; `from:pl` = resume at `pl`. Ignored when no per-language step is ticked |
| **Stop** | finishes and saves the current locale, then ends the run |
| **Probe page** | dumps the page structure to the log, for debugging (see [Maintaining the drivers](#maintaining-the-drivers)) |

### Stopping and resuming

**Stop is a request, not a kill.** A locale is one unit of work (select the
language, write the description, replace the screenshots, save), and cutting it
short could leave old screenshots deleted and new ones not uploaded. On Partner
Center, finishing can take a couple of minutes; the log confirms right away that
the stop was received.

A run also **aborts at the first failed step**, with diagnostics, rather than
risk writing into the wrong locale.

After either, **you can start again without reloading the add-on.** The locale
filter is pre-filled with where to resume: the locale that aborted (it was not
written), or the one after the last locale a stop finished. Check it and press
Run.

If the add-on is reloaded or Firefox unloads its background page, the run dies
with it; nothing keeps writing in the background. The popup reports that the
last run was interrupted, and its log shows how far it got.

The log is kept in `storage.local`, not in the popup, because Firefox closes the
popup whenever it loses focus. Reopen it and the log is still there, still
updating.

---

## Why the add-on exists

**The Chrome Web Store API has no listing metadata at all.** Its
[discovery document](https://chromewebstore.googleapis.com/$discovery/rest?version=v2)
defines five methods over two resources:

| `media` | `upload` (the package ZIP) |
|---|---|
| `publishers.items` | `publish`, `fetchStatus`, `cancelSubmission`, `setPublishedDeployPercentage` |

Nothing for descriptions, screenshots, promo tiles or categories. The
[`publishers.items` reference](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items)
says it has "no persistent data", and the
[usage guide](https://developer.chrome.com/docs/webstore/using-api) says: *"Before
you can publish a new item, you have to fill out the Store listing and Privacy
tabs in the Developer Dashboard."*

It is not in v1 either (which sunsets 15 October 2026). v2 added service-account
auth, staged publishing and rollout control, all used by `cws_publish.py`, none
of which touch the listing.

**Microsoft says the same about Edge:**

> There aren't REST API endpoints for: Creating a new product. Updating a
> product's metadata, such as the description. To create a new product or update
> a product's metadata, you must use Microsoft Partner Center.

Asked directly in December 2024, the Edge team said the API targets CI/CD package
uploads and that they were "looking into" listing metadata. Nothing has shipped
since.

---

## Security notes

- **The native host is confined.** Every requested path is resolved (collapsing
  `..`, following symlinks) and must land inside a root listed in
  `native/allowed-roots.json`, which the installer writes. If that file is
  missing, every read is refused: a broken install cannot grant access to
  everything.
- **`extension/config.json` and `.amo-previews-state.json` are gitignored.** The
  config holds your AMO API secret and CWS publisher id. If you commit it by
  mistake, rotate the key at
  <https://addons.mozilla.org/developers/addon/api/key/>.
- **The add-on stores no credentials.** It uses the Firefox profile's session.
- **The add-on is dev-only.** Load it temporarily via `about:debugging`; it is
  not meant to be signed or installed permanently.

---

## Tests

```bash
npm test                             # the add-on (jest)
python tests/test_cws_publish.py     # request bodies, URLs, auth-mode choice
python tests/test_edge_publish.py    # endpoint versioning, the Location header
python tests/test_config_parity.py   # the config loaders cannot drift apart
python tests/test_native_host.py     # the native host's confinement
```

The Python tests target quiet failures: a publish body Google accepts but that
does the wrong thing, an upload sent to `/v2` instead of `/upload/v2`,
`skipReview` sneaking into a body, a template missing `{version}` that would
upload whatever build is lying around, or the two config loaders disagreeing.

The JavaScript suites:

- `tests/edge-page-functions.test.js` runs the real `edgePage*` functions in
  jsdom, over the shapes Partner Center actually serves (web-component command
  bar, a slot with an error tile, a language table that renders late). A
  hand-written stub would share the same wrong assumptions that caused the bugs.
- `tests/edge-upload-escalation.test.js` fakes the page at the `executeScript`
  boundary and drives the real upload loop, including a page that answers slowly.
- `tests/screenshot-verify.test.js` checks that the repair pass removes an error
  tile **by name**, not by position.
- `tests/run-lifecycle.test.js` drives the real message handler through start,
  stop and restart: a stop finishes the current locale, an aborted or stopped run
  always allows another, and a stale `run_state` from a dead background page is
  reconciled, not trusted.

What no test can tell you is whether the console still looks like this today.
That is what **Dry run** and **Probe page** are for.

---

## Maintaining the drivers

All DOM logic lives in `extension/stores/cws.js` and `extension/stores/edge.js`.
Selectors rely on text and roles, not CSS classes, so cosmetic redesigns do not
break them.

**When a step fails:** navigate to the page in question, click **Probe page**,
read the dump, fix the matching `<store>Page*` function, reload the temporary
add-on, and resume with `from:<locale>`.

### About Probe page

- It **reuses a tab already showing that store**, and only opens the listing page
  if there is none. Navigate to the page you want dumped first: opening a fresh
  tab would lose it. Tabs are matched by the driver's `ownsUrl`, and the log says
  which one was used.
- On Edge, it opens the "Add a language" menu itself and closes it again, since
  the menu closes as soon as focus leaves the page.
- It reads the page like a screen reader: accessible names (including `title` and
  `aria-labelledby`), shadow roots walked, `<slot>` resolved to its content. It
  reports counts along with the dump.

### Rules for editing a store file

- **Prefix every function with the store id** (`cwsPageSetDescription`,
  `edgePageSetDescription`). All `stores/` files share one scope, where a
  duplicate top-level `function` silently replaces the other one.
- **`<store>Page*` functions must be self-contained.** They are serialized into
  the page by `chrome.scripting.executeScript({ world: 'MAIN' })`, so helpers
  (`visible`, `txt`, `trail`) are repeated in each. There is no bundler.
- **Keep them short.** Waiting loops belong in the driver. An injected script
  that outlives a page re-render dies silently and its promise never settles;
  from the driver, the same wait is a clean timeout.
- **Report before filtering.** A diagnostic that filters on the words that just
  failed to match comes back empty exactly when you need it. Dump everything,
  add counts, keep it compact.
- **`listingUrl` pins `hl=en`.** Every heading and `aria-label` pattern assumes
  the English console.

To support another store, add `extension/stores/<id>.js` with the same surface,
documented at the bottom of `cws.js`. Store differences are expressed as
capabilities the driver declares (`addLanguage`, `saveDraft`,
`screenshotScopes`), never as checks on the store's name.

### Partner Center (Edge) specifics

`stores/edge.js` handles descriptions, screenshots, per-page saving and adding
languages. It was written against dumps of the real page; **probe first** matters
here more than anywhere.

How it differs from the Chrome Web Store:

- **No language dropdown.** Store listings is a table, one row per language, and
  each *Edit details* button opens a separate page. Selecting a language is a
  navigation, and the run returns to the table between languages.
- **Leaving a page discards it**, so each page is saved as it is written.
- **Limits:** up to 6 screenshots, 1280×800 or 640×400; descriptions from 250 to
  10,000 characters. A project may need shorter text for Edge than for the other
  stores.
- **It never presses Publish.** That is `edge_publish.py`'s job, after human
  review.

Things that are easy to get wrong:

- **Controls are web components.** *Save draft* is
  `<v6_he-button>Save draft</v6_he-button>`: a real `<button>` inside a shadow
  root, with the label slotted from the light DOM, so neither element has the
  text in its `textContent`. Resolve names like a screen reader, walk shadow
  roots, and treat a component and its inner control as one button.
- **Screenshot uploads need spacing.** The console accepts an upload about
  fifteen seconds after the previous one, however the file is handed over. The
  driver waits `MIN_UPLOAD_GAP_MS` (counted only from its own uploads), then
  waits until every thumbnail shows its own per-image controls, which marks it as
  committed. The last upload of a language gets the same wait before saving.
- **The count is not the check.** An upload can fail after its thumbnail appears,
  leaving an error tile. The driver compares thumbnails against the filenames it
  sent (Partner Center labels each one), deletes any stray tile by name and
  re-sends that file before saving.
- **Do not duplicate screenshots across languages.** The store offers it and the
  driver exposes it, but nothing calls it: with localized screenshots it would
  overwrite every language with one language's images. Languages without their
  own page already fall back to the default one. Only use it for text-free
  screenshots, from the base locale.

#### Adding the languages

Partner Center only lists languages you have **added**; the package makes them
*available*, which is not the same. A fresh product shows a single row whatever
its ZIP contains.

So an Edge run starts by adding the missing languages. This step runs because the
driver has `addLanguage`, not because the store is Edge. It is idempotent: it
reads what already exists and adds only the rest, so re-running after an abort
resumes. Each addition opens the new language's page, so the listings page is
reopened between them. A dry run lists what it would add.

- **A language the store does not offer is skipped and reported**, not fatal
  (Filipino, for example, is not in Partner Center's menu). Any other failure
  stops the run.
- **The table renders after the page reports complete.** The reader that lists
  languages waits for the row count to settle, and the one that opens a language
  waits for that language's row. Reading once caused runs that aborted on a
  "missing" language that changed from run to run.

---

## License

MIT, see [LICENSE](LICENSE).

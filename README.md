# Store Listing Publisher

Operator tooling that publishes a browser extension: the package, the release
lifecycle, and the localized listing — descriptions and screenshots — from
marketing assets on your own disk.

It is split by **what each mechanism can actually do**, not by store:

| | Package + release lifecycle | Listing metadata |
|---|---|---|
| **Chrome Web Store** | `cws/cws_publish.py` — API v2 | **`extension/`**, a Firefox add-on driving the dev console — [no API exists](#why-the-add-on-exists) |
| **Microsoft Edge Add-ons** | `edge/edge_publish.py` — API v1.1 | **`extension/`** driving Partner Center — [no API exists](#why-the-add-on-exists) *(probe-only so far)* |
| **addons.mozilla.org** | `amo/amo_publish.py` — API v5 | `amo/amo_publish.py` — API v5 |

Four of those six boxes are real APIs. Of the two that are not, both are store
listings, and only one store of the three publishes an API for its own listing.
The add-on is not a fallback or a legacy path — where it appears, it is the only
way there is.

Nothing here invents content. You point it at a directory of assets and it puts
them in the right fields, in the right language, in the right order, which is the
part that is unbearable to do 43 times by hand.

**Nothing publishes by surprise.** Every write is dry-run by default and needs
`--apply`. The add-on never saves at all: a run leaves the listing tab open with
the draft filled in, and clicking **Save draft** stays yours.

---

## Quick start

```bash
git clone https://github.com/dlamarre-dev/store-listing-publisher
cd store-listing-publisher
npm install                     # jest only, for the tests
cp extension/config.example.json extension/config.json
```

Then, in order:

1. **Describe your assets** — see [Configuration](#configuration). Start from
   `examples/per-language-dirs.config.json` (one directory per language) or
   `examples/flat-layout.config.json` (language in the filename).
2. **Install the native messaging host**, naming every directory it may read:
   ```powershell
   .\native\install-native-host.ps1 -Root E:\my-project
   .\native\install-native-host.ps1 -Root E:\my-project,D:\other-assets   # several
   ```
   ```bash
   ./native/install-native-host.sh /srv/marketing
   ./native/install-native-host.sh /srv/marketing /home/me/my-project     # several
   ```
   The add-on has no filesystem of its own; this host is how it reads your PNGs
   and text files. It refuses any path outside the roots you list.
3. **Load the add-on**: Firefox → `about:debugging` → This Firefox → Load
   Temporary Add-on → pick `extension/manifest.json`. Reload it after each
   Firefox restart. Be signed into the Google account with publisher access in
   this profile — there is no credential handling, the session is the auth.
4. **Click Dry run first.** It walks every language and locates every field
   without writing anything. Do this before trusting a run on a console layout
   you have not seen the tool work on.

### Releasing

```bash
# Chrome Web Store — package and lifecycle
python cws/cws_publish.py --item my-extension --status                    # read-only
python cws/cws_publish.py --item my-extension --upload --apply            # new draft
#   ... then the add-on fills the localized listing draft, and you Save draft ...
python cws/cws_publish.py --item my-extension --publish --staged --apply
python cws/cws_publish.py --item my-extension --rollout 50 --apply

# Microsoft Edge — package and lifecycle
python edge/edge_publish.py --item my-extension --upload --apply
python edge/edge_publish.py --item my-extension --publish --apply
python edge/edge_publish.py --item my-extension --status

# addons.mozilla.org — package and listing, both by API
python amo/amo_publish.py --item my-extension --upload-version           # dry-run
python amo/amo_publish.py --item my-extension --texts --images --apply   # writes, live
```

A dry-run of a write makes no API call and needs **no credentials at all**, so
you can check the resolved package path and the exact body that would be sent
before doing any OAuth setup.

Stdlib only, with one exception: service-account auth signs its JWT with RS256,
which the standard library cannot do. See [Authentication](#authentication).

---

## Configuration

Two layers, and the split is the point.

The **project** whose assets are being published owns the interesting half —
items, path templates, the locale table — in a file it commits to its own repo,
where its own tests can check it. This tool's `config.json` then holds only what
must never be committed, and points at the other with `extends`:

```json
{
  "extends": "E:/my-project/store-publisher.config.json",
  "publisher_id": "your-cws-publisher-uuid",
  "assets": { "root": "/absolute/path/to/your/project" },
  "cws": { "serviceAccountKey": "/path/to/service-account-key.json" },
  "amo": { "jwt_issuer": "user:...", "jwt_secret": "..." }
}
```

Anything declared locally wins. Objects merge a key at a time, so a local
`amo: { jwt_secret }` does not erase the project's `amo: { previewSet }`; arrays
replace wholesale, a half-overridden locale table being worse than either
version. You can also skip `extends` and put everything in one file.

**`config.json` goes in `extension/`, beside `manifest.json`** — that is the only
directory the add-on can read with `chrome.runtime.getURL`, and both Python
scripts default to the same file so every half stays in step. Put it anywhere else and
Firefox fails the fetch with a bare *"The operation was aborted."*, which tells
you nothing. Pass `--config` to point the Python half elsewhere.

`extends` must be **absolute** when the add-on reads it: an extension knows its
`moz-extension://` origin and never its own location on disk, so there is
nothing for a relative path to resolve against. `amo_publish.py`, which does
know where it is, accepts either.

### Path templates

Nothing about your layout is baked into the code. Placeholders:

| | |
|---|---|
| `{slug}` | the item's slug |
| `{lang}` | the locale's internal code (`pt_BR`, `zh_CN`) |
| `{LANG}` | uppercase of `fileCode ?? internal` |
| `{cwsLang}` | the Chrome Web Store code (`pt-BR`, `iw`, `no`) |
| `{amoLang}` | the AMO code, or empty when the locale is not on AMO |
| `{n}` | screenshot index, 1-based |
| `{version}` | the built package's version, read from `versionSource` |

The default — one directory per supported language:

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

### The package

`cws/cws_publish.py --upload` and `amo/amo_publish.py --upload-version` need to
find the built ZIP, and the version is part of its name, so it gets a template
too — plus a source to read the version from:

```json
"chrome": {
  "package": "dist/{slug}-chrome-v{version}.zip",
  "versionSource": { "path": "dist/{slug}/chrome/manifest.json", "key": "version" }
}
```

Reading the version out of the **built** manifest rather than taking it as an
argument is the point: the number then cannot disagree with the bytes being
uploaded. `versionSource` reuses the same `{path, key}` shape as AMO's
`summarySource`, and tolerates Chrome's `{"key": {"message": …}}` wrapper.
`--package <path>` bypasses both for a one-off.

### More on templates

`{LANG}` exists for the one thing a template cannot express: a project whose
filenames use a code that is neither the internal one nor a store one. Put
`"fileCode": "CN"` on that locale's row and `{LANG}` follows it, instead of a
special case in the code.

An unresolved placeholder is a hard error, not a warning. A template that forgot
`{lang}` would read one file for every language and publish the same text
everywhere.

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

- `internal` — your own code, and the key everything hangs off.
- `cws` — the Chrome Web Store's code. It diverges: `iw` for Hebrew, `no` for
  Norwegian, `fil` for Filipino, dashes for regional variants.
- `amo` — the AMO code, or `null` when AMO cannot store listing translations for
  that language (its production language list). Those locales are skipped for
  texts, with a log line.
- `name` — the label the CWS console shows in its language dropdown, in English
  (`hl=en`). Matching prefers the trailing code in `"French – fr"`, so a small
  wording change on Google's side does not break a run.
- `altNames` — extra labels to try when the console's wording differs.

Duplicate `internal` or `cws` codes are rejected: the run would walk the same
language twice and the second pass would overwrite the first with another
locale's text.

### AMO extras

```json
"amo": {
  "previewSet": "en-only",
  "summarySource": { "path": "{slug}/{lang}/messages.json", "key": "extDesc" },
  "nameSource":    { "path": "{slug}/{lang}/messages.json", "key": "extName" }
}
```

AMO previews are **not** localized — one shared gallery per listing — so
composing it is a policy choice, not a store rule:

- `en-only` (default) — the base locale's screenshots. The honest default.
- `en-plus-first-per-locale` — those, then the *first* screenshot of every other
  language, so the gallery shows that the listing is translated. One extra
  upload per language.

`summarySource` / `nameSource` read one string per locale out of a JSON file, for
the listing summary and name. Both optional: omit them and those fields are not
sent, and AMO leaves them alone. A key may be nested one level, matching
Chrome's `messages.json` shape (`{"extName": {"message": "…"}}`). The name is
sent only for locales where it actually differs from the live listing — AMO
throttles writes hard and every edit is immediate.

---

## Why the add-on exists

Because the Chrome Web Store API has no listing metadata. Not "not yet", not
"undocumented" — none. Its
[discovery document](https://chromewebstore.googleapis.com/$discovery/rest?version=v2)
is exhaustive and defines five methods over two resources:

| `media` | `upload` (the package ZIP) |
|---|---|
| `publishers.items` | `publish`, `fetchStatus`, `cancelSubmission`, `setPublishedDeployPercentage` |

No schema, no field, no method for a description, a localized description, a
screenshot, a promo tile or a category. The
[`publishers.items` resource](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items)
says outright that it has "no persistent data", and the
[usage guide](https://developer.chrome.com/docs/webstore/using-api) states the
prerequisite: *"Before you can publish a new item, you have to fill out the Store
listing and Privacy tabs in the Developer Dashboard."*

So driving the dashboard is not a shortcut taken instead of reading the docs. It
is the only mechanism that exists for that half of the job, which is why
`extension/` is a peer of `cws/` here rather than something to be replaced by it.

If you are about to go looking for that API: it is not in v1 either, and v1
sunsets 15 October 2026. What changed in v2 is service-account auth, staged
publishing and rollout control — all of which `cws/cws_publish.py` uses, and none
of which touch the listing.

**Microsoft says the same thing about Edge**, in the same words:

> There aren't REST API endpoints for: Creating a new product. Updating a
> product's metadata, such as the description. To create a new product or update
> a product's metadata, you must use Microsoft Partner Center.

Asked directly, the Edge team answered that the API's scope is CI/CD package
uploads and that they were "looking into" listing metadata — in December 2024,
with no date since. So Edge listings are filled in Partner Center, by hand or by
a driver, exactly like the Chrome Web Store.

---

## Authentication

**Chrome Web Store** — pick one mode under `cws` in your config:

- **Service account** (preferred). Create one in Google Cloud, then grant it API
  access from the Developer Dashboard, and point `cws.serviceAccountKey` at its
  JSON key file. No expiry, nothing to refresh.
  Needs `pip install cryptography`: the assertion is a **RS256**-signed JWT, and
  RSA is not in the standard library. The import happens only on this path, so
  the refresh-token mode still works on a machine with no packages installed.
- **OAuth refresh token** — `cws.client_id` + `cws.client_secret` +
  `cws.refresh_token`, from the
  [OAuth Playground flow](https://developer.chrome.com/docs/webstore/using-api).
  Zero dependencies, but **the refresh token expires every 7 days** while the
  OAuth consent screen is in "Testing", which means redoing the dance at every
  release. That is why the service account is the default recommendation.

Both converge on a bearer token for the scope
`https://www.googleapis.com/auth/chromewebstore`.

**Microsoft Edge** — `edge.client_id` + `edge.api_key`, from Partner Center >
Microsoft Edge > **Publish API** > *Create API credentials*. v1.1 sends them as
two request headers with **no token exchange and nothing to sign**, which makes
it the only one of the three with no dependency and no expiry story. (v1's
`client_credentials` flow is not implemented: support ended 31 December 2024.)

`edge.productIds` maps each item slug to its Partner Center **GUID**. An add-on
has two identifiers and only this one works here — the id in the public store
URL is a 32-letter string, and using it by mistake surfaces as a bare 404 on the
first write, so the shape is checked and called out.

**addons.mozilla.org** — `amo.jwt_issuer` + `amo.jwt_secret` from
<https://addons.mozilla.org/developers/addon/api/key/>. HS256, so stdlib only.

**The add-on has no credentials at all.** It authenticates as whoever the Firefox
profile is signed in as, and only checks whether it got redirected to a login
page.

---

## Using the CWS add-on

- **Extension** — from the `items` in your config.
- **Update detailed descriptions** — replaces the description for every locale.
- **Replace the localized screenshots per locale** — deletes the existing ones,
  then uploads `1..N` in order.
- **Replace international screenshots** — the global, non-localized slots. On its
  own this **skips the language walk entirely**: that card is language-
  independent, so there is nothing to select.
- **Dry run** — navigates and locates every field, writes nothing.
- **Locale filter** — empty = all; `fr,de` = just those; `from:pl` = resume an
  aborted run at `pl`. Ignored, with a log line, when no per-language step is
  ticked.
- **Probe page** — dumps the page's structure (dropdowns, textareas, file
  inputs, headings, buttons) to the log. This is the debugging entry point when a
  console changes.

  **It reuses a tab already showing that store** and only opens the listing page
  when there is none. That matters more than it sounds: the pages worth dumping
  are usually ones you navigated to — a language's details page, a form partway
  through — and opening a fresh tab is exactly what destroys them. Navigate to
  what you want to see, then click Probe.

  A tab is claimed by the driver's own `ownsUrl`, so a page it does not own is
  never injected into, and the log says which tab it used.

  The Edge probe also **opens the "Add a language" control itself** and closes it
  again, because you cannot hold a menu open across the click: pressing the
  toolbar button moves focus out of the page, and a menu that closes on blur is
  gone before the probe runs.

A run aborts at the first failed step, with diagnostics, rather than risk
writing into the wrong locale. Fix, then resume with `from:<locale>`.

The add-on fills the draft; it does not upload packages and does not publish.
Those are `cws/cws_publish.py`'s job, and `--status` there is the way to see
whether a draft is already in review before you start writing into it.

The log lives in `storage.local`, not in the popup: Firefox destroys a popup the
moment it loses focus, and a 43-locale run outlives that many times over. Close
it and reopen — the output is still there, still updating.

---

## When the console changes

Every DOM heuristic lives in `extension/stores/cws.js`, and selectors are
deliberately text- and role-based rather than class-based, so cosmetic
redesigns pass through. When a step fails: click **Probe page**, read the dump,
adjust the matching `page*` function, reload the temporary add-on, resume with
`from:<locale>`.

Two things to know before editing that file:

- The `page*` functions are **serialised** into the page by
  `chrome.scripting.executeScript({ world: 'MAIN' })`, so each one must be
  entirely self-contained. That is why the small helpers (`visible`, `txt`,
  `trail`) are repeated in every one of them. There is no bundler; factoring
  them out would break the injection.
- `listingUrl` pins `hl=en`. Every heading and `aria-label` regex assumes the
  English console.

Supporting another store means a new `extension/stores/<id>.js` exposing the same
surface, documented at the bottom of `cws.js`.

### Partner Center (Edge) — probe-only

`stores/edge.js` exists and is registered, but only `probe` is implemented. Every
other step returns `ok: false` with an instruction, so a run against it aborts
instead of half-working — selectors written before reading the markup are fiction
that looks like code.

It is also structurally different from the CWS, which is why it could not be
copied: **there is no language dropdown.** Partner Center's Store listings page is
a table with one row per language, and each row's *Edit details* button opens a
separate *Details for &lt;language&gt;* page — so `selectLanguage` becomes a
navigation. Two things from Microsoft's docs are worth building around:

- **"Duplicate this asset for all languages"** sits under each asset. Five
  screenshots uploaded once and duplicated beats 5 × 43 uploads, and it is the
  store's own feature rather than a trick.
- Screenshots cap at **6**, sized 640×480 or 1280×800; descriptions run
  **250–10,000** characters. That ceiling is why a consuming project may need to
  shorten its listing text for this target and not the others.

To finish it: click **Probe page** against a real Store listings page and read the
dump. Its `links` gives the route to a language page (undocumented — hence the
`edge.edgeListingPath` override, so learning it needs no code change), `tables`
gives the row shape and the exact button label, and `textareas` vs `editables`
decides how the description is written, since a rich-text editor would not take
the CWS approach. The notes at the bottom of `stores/edge.js` list the steps.

It will never press **Publish**: that is `edge/edge_publish.py`'s job, and the
review before it stays human.

---

## Security notes

- **The native host is confined.** A native messaging host is addressed by name,
  and any add-on the host manifest allows can ask it for a file. Every requested
  path is resolved — collapsing `..` and following symlinks — and must land
  inside one of the roots in `native/allowed-roots.json`, which the installer
  writes from the directories you name. A missing file means no roots, which
  means every read is refused: a botched install cannot quietly grant
  everything.
- **`extension/config.json` and `.amo-previews-state.json` are gitignored.** The first
  holds your AMO API secret and CWS publisher id. If you fork this and commit
  one by accident, rotate the key at
  <https://addons.mozilla.org/developers/addon/api/key/>.
- **No CWS credentials anywhere.** That side authenticates as whoever the
  Firefox profile is signed in as. The add-on only checks whether it got
  redirected to a login page.
- **The add-on is dev-only.** Load it temporarily via `about:debugging`; it is
  not meant to be signed or installed permanently.

---

## Tests

```bash
npm test
```

```bash
npm test                             # the add-on's pure logic (jest)
python tests/test_cws_publish.py     # request bodies, URLs, auth-mode choice
python tests/test_edge_publish.py    # endpoint versioning, the Location header
python tests/test_config_parity.py   # the config loaders cannot drift apart
python tests/test_native_host.py     # the native host's confinement
```

What they pin is the quiet failures: a publish body Google would accept but that
does the wrong thing, an upload sent to the plain `/v2` path instead of
`/upload/v2`, `skipReview` sneaking into a body, a template that dropped
`{version}` and would upload whichever build was lying around, or one config
loader learning a rule the other did not.

The DOM heuristics in `extension/stores/cws.js` are not unit-testable — they
exist to match a page nobody controls, which is what **Dry run** and **Probe
page** are for.

## License

MIT — see [LICENSE](LICENSE).

#!/usr/bin/env python3
"""
AMO (addons.mozilla.org) listing publisher — the API-based half of the Store
Listing Publisher. AMO has an official add-ons API, so unlike the Chrome Web
Store side there is no DOM scraping here.

Per supported locale it PATCHes the listing description, and optionally the
summary and name, from files named by the path templates in your config. With
--images it replaces the listing previews. AMO previews are NOT localized —
there is one shared set per listing — so the images step runs once, not per
locale. Locales whose `amo` field is null are skipped for texts (AMO cannot
store listing translations for languages outside its production list).

!! Unlike the CWS draft flow, AMO listing edits go LIVE IMMEDIATELY — there is
no draft/review stage for listing metadata. The script is dry-run by default;
pass --apply to write.

Usage:
  python amo_publish.py --item <slug> [--texts] [--images] [--apply]
  python amo_publish.py --config /path/to/config.json --item <slug> --texts

Configuration: config.json next to this checkout's root (see
config.example.json), which may "extends" a project-owned file. Credentials go
under "amo": {"jwt_issuer": "user:...", "jwt_secret": "..."}, generated at
https://addons.mozilla.org/developers/addon/api/key/

Stdlib only — no pip dependencies.
"""

import argparse
import base64
import hashlib
import hmac
import json
import mimetypes
import re
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

API_BASE = "https://addons.mozilla.org/api/v5"
TOOL_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOL_DIR.parent
DEFAULT_CONFIG = REPO_ROOT / "config.json"
# Records the screenshot set last uploaded per add-on, so an unchanged gallery
# is skipped instead of torn down and re-uploaded (AMO throttles writes hard).
STATE_FILE = REPO_ROOT / ".amo-previews-state.json"  # gitignored
AMO_SUMMARY_MAX = 250   # AMO rejects summaries above this length
AMO_NAME_MAX = 50       # AMO rejects add-on names above this length
REQUEST_GAP_S = 1.0     # initial delay before each write request (grows on throttle)
MAX_PACE_S = 30.0       # cap for the adaptive pacing delay
AUTO_RETRY_CAP_S = 180  # longest we'll auto-sleep on a single throttle before retrying
LONG_THROTTLE_S = 300   # above this hinted wait, bail with an ETA instead of sleeping
WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
_pace_gap = REQUEST_GAP_S  # adaptive: bumped to the server's hinted rate on 429/503


# ── configuration and path templates ──────────────────────────────────────────
#
# The templates are shared data with the add-on (extension/lib/paths.js) — the
# same strings, resolved the same way, from the same config file. Only the
# resolver is duplicated, because one side is JavaScript in a browser and this
# one is Python. Keep the placeholder set in step.

def load_config(path):
    """Reads config.json and merges the project-owned file it "extends".

    Two layers: the project commits items, path templates and the locale table;
    this checkout's config.json holds only the credentials. Local keys win.
    A relative "extends" resolves against the file that declared it.
    """
    path = Path(path).expanduser()
    if not path.is_file():
        sys.exit(f"Config not found: {path}\n"
                 f"Copy config.example.json to {DEFAULT_CONFIG} and fill it in, "
                 f"or pass --config.")
    try:
        config = json.loads(path.read_text(encoding="utf-8-sig"))
    except ValueError as exc:
        sys.exit(f"{path} is not valid JSON: {exc}")

    parent = config.pop("extends", None)
    if parent:
        parent_path = Path(parent).expanduser()
        if not parent_path.is_absolute():
            parent_path = (path.parent / parent_path).resolve()
        if not parent_path.is_file():
            sys.exit(f'"extends" points at a file that does not exist: {parent_path}')
        try:
            base = json.loads(parent_path.read_text(encoding="utf-8-sig"))
        except ValueError as exc:
            sys.exit(f"{parent_path} is not valid JSON: {exc}")
        config = merge_config(base, config)
    return config


def merge_config(base, over):
    """Objects merge a key at a time so a local `amo: {jwt_secret}` does not
    erase the project's `amo: {previewSet}`; arrays replace wholesale, a
    half-overridden locale table being worse than either version."""
    out = dict(base)
    for key, value in over.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            out[key] = merge_config(base[key], value)
        else:
            out[key] = value
    return out


def locale_vars(locale):
    return {
        "lang": locale["internal"],
        "LANG": str(locale.get("fileCode") or locale["internal"]).upper(),
        "cwsLang": locale.get("cws") or "",
        "amoLang": locale.get("amo") or "",
    }


def resolve_template(template, variables):
    """Substitutes {placeholders}. An unresolved one is fatal: a template that
    drops {lang} would collapse every locale's read onto a single file."""
    if not isinstance(template, str) or not template:
        sys.exit(f"Path template missing or not a string: {template!r}")
    out = template
    for key, value in variables.items():
        out = out.replace("{" + key + "}", str(value))
    if "{" in out or "}" in out:
        sys.exit(f'Template "{template}" did not fully resolve: "{out}"')
    return out


def asset_path(root, template, item, locale, index=None):
    variables = {"slug": item["slug"], **locale_vars(locale)}
    if index is not None:
        variables["n"] = index
    return Path(root) / resolve_template(template, variables)


def assets_profile(config, name="firefox"):
    assets = config.get("assets") or {}
    root = assets.get("root")
    if not root:
        sys.exit('config "assets.root" is required — the absolute path the '
                 "templates hang off. This tool no longer lives inside the "
                 "project it publishes, so there is nothing to infer.")
    profile = assets.get(name)
    if not profile:
        sys.exit(f'config "assets.{name}" is missing — no path templates to work from.')
    return Path(root).expanduser(), profile


def screenshots_per_listing(profile):
    return int(profile.get("screenshotsPerListing") or 5)


def supported_locales(config):
    locales = config.get("locales")
    if not locales:
        sys.exit('config "locales" is required — the list of languages to publish.')
    return locales


# ── AMO API client (JWT auth, stdlib HTTP) ────────────────────────────────────

def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def make_jwt(issuer, secret):
    header = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    now = int(time.time())
    payload = b64url(json.dumps({
        "iss": issuer, "jti": str(uuid.uuid4()), "iat": now, "exp": now + 240,
    }).encode())
    signing_input = f"{header}.{payload}".encode()
    sig = b64url(hmac.new(secret.encode(), signing_input, hashlib.sha256).digest())
    return f"{header}.{payload}.{sig}"


def throttle_wait_s(err):
    """Seconds to wait before retrying a 429/503, from the Retry-After header or
    AMO's "Expected available in N seconds" body. Falls back to None (no hint)."""
    retry_after = err.headers.get("Retry-After")
    if retry_after and retry_after.strip().isdigit():
        return int(retry_after)
    body = getattr(err, "_amo_detail", "")
    m = re.search(r"available in (\d+) second", body)
    return int(m.group(1)) if m else None


def api_request(creds, method, path, json_body=None, multipart=None, max_retries=6):
    """One authenticated API call. `multipart` = dict of name → str | (filename,
    bytes) encoded as multipart/form-data. Returns parsed JSON (or None for 204).
    Retries on 429/503 (AMO throttling), honouring the server's retry delay."""
    url = path if path.startswith("http") else API_BASE + path
    base_headers, data = {}, None

    if json_body is not None:
        data = json.dumps(json_body).encode()
        base_headers["Content-Type"] = "application/json"
    elif multipart is not None:
        boundary = uuid.uuid4().hex
        parts = []
        for name, value in multipart.items():
            if isinstance(value, tuple):
                filename, blob = value
                ctype = mimetypes.guess_type(filename)[0] or "application/octet-stream"
                parts.append(
                    f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; '
                    f'filename="{filename}"\r\nContent-Type: {ctype}\r\n\r\n'.encode() + blob + b"\r\n")
            else:
                parts.append(
                    f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"'
                    f"\r\n\r\n{value}\r\n".encode())
        data = b"".join(parts) + f"--{boundary}--\r\n".encode()
        base_headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"

    global _pace_gap
    for attempt in range(max_retries + 1):
        # Proactively pace writes at the rate the server last told us to use, so
        # requests succeed first try instead of bouncing off the throttle. On a
        # retry (attempt > 0) we already slept the server's hint below, so skip.
        if method in WRITE_METHODS and attempt == 0 and _pace_gap:
            time.sleep(_pace_gap)
        # Fresh JWT (and jti) per attempt — tokens are short-lived.
        headers = {**base_headers,
                   "Authorization": "JWT " + make_jwt(creds["jwt_issuer"], creds["jwt_secret"])}
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                body = resp.read()
                return json.loads(body) if body else None
        except urllib.error.HTTPError as e:
            e._amo_detail = e.read().decode("utf-8", "replace")[:2000]
            if e.code in (429, 503):
                hint = throttle_wait_s(e)
                # A long cooldown means the write quota is exhausted — don't sleep
                # for ages in-process; tell the user when to come back and exit.
                if hint and hint > LONG_THROTTLE_S:
                    mins = max(1, round(hint / 60))
                    sys.exit(f"AMO is throttling writes for ~{hint}s (~{mins} min): your API "
                             f"write quota is temporarily exhausted (repeated runs). Re-run this "
                             f"command in ~{mins} min — a single --texts PATCH is all it takes.")
                if attempt < max_retries:
                    if hint:  # learn the server's rate so later writes pre-wait
                        new_gap = min(max(_pace_gap, hint), MAX_PACE_S)
                        if new_gap > _pace_gap:
                            print(f"  pacing -> {new_gap:g}s/request (server throttle)")
                            _pace_gap = new_gap
                    wait = min((hint or 5 * (attempt + 1)) + 1, AUTO_RETRY_CAP_S)
                    print(f"  throttled (HTTP {e.code}); retrying in {wait}s "
                          f"(attempt {attempt + 1}/{max_retries})")
                    time.sleep(wait)
                    continue
            sys.exit(f"API {method} {path} failed: HTTP {e.code}\n{e._amo_detail}")


# ── steps ─────────────────────────────────────────────────────────────────────

def build_descriptions(root, profile, item, locales):
    """Reads every AMO-supported locale's description. Returns {amo_code: text}."""
    out, skipped, missing = {}, [], []
    for loc in locales:
        if not loc.get("amo"):
            skipped.append(loc["internal"])
            continue
        path = asset_path(root, profile["description"], item, loc)
        if not path.is_file():
            missing.append(str(path))
            continue
        out[loc["amo"]] = path.read_text(encoding="utf-8-sig")
    if missing:
        sys.exit("Description files not found:\n  " + "\n  ".join(missing))
    print(f"Texts: {len(out)} locales to send"
          + (f"; not on AMO, skipped: {', '.join(skipped)}" if skipped else ""))
    return out


def build_meta_field(root, item, locales, source, label, max_len):
    """Reads one string per locale out of a JSON file, for the listing summary or
    name. Optional by design: only a project that keeps those strings in files
    (a browser extension's _locales, say) configures a source for them. Without
    one, the field is simply not sent and AMO leaves it as it is.

    `source` = {"path": "<template>", "key": "<json key>"}. A key may be nested
    one level, matching Chrome's messages.json shape ({"extName": {"message": …}}).
    """
    if not source:
        print(f"{label}: no source configured — not sending")
        return {}
    template, key = source.get("path"), source.get("key")
    if not template or not key:
        sys.exit(f'config amo.{label.lower()}Source needs both "path" and "key".')

    out = {}
    for loc in locales:
        if not loc.get("amo"):
            continue
        path = asset_path(root, template, item, loc)
        if not path.is_file():
            sys.exit(f"{label} source not found: {path}")
        try:
            data = json.loads(path.read_text(encoding="utf-8-sig"))
        except ValueError as exc:
            sys.exit(f"{path} is not valid JSON: {exc}")
        value = data.get(key)
        if isinstance(value, dict):          # Chrome's {"message": "..."} wrapper
            value = value.get("message")
        value = (value or "").strip()
        if not value:
            sys.exit(f'{label}: "{key}" missing or empty in {path}')
        if len(value) > max_len:
            sys.exit(f"{label} for {loc['internal']} is {len(value)} chars "
                     f"(AMO max {max_len}): {value[:80]}…")
        out[loc["amo"]] = value
    print(f"{label}: {len(out)} locales from {key}")
    return out


def changed_only(new, current):
    """Keeps only entries whose value differs from the live listing, so an
    unchanged name/field isn't rewritten (AMO throttles writes and every edit
    goes live immediately). `current` is the addon's localized field (or None)."""
    cur = current if isinstance(current, dict) else {}
    return {code: text for code, text in new.items() if cur.get(code) != text}


def update_texts(creds, guid, descriptions, summaries, names, apply):
    if not apply:
        for code, text in sorted(descriptions.items()):
            print(f"  would send description[{code}]: {len(text)} chars"
                  + (f", summary: {len(summaries[code])} chars" if code in summaries else ""))
        for code, name in sorted(names.items()):
            print(f"  would send name[{code}]: {name!r}")
        if not names:
            print("  name: no changes vs the live listing — nothing to send")
        return
    # One PATCH carries every locale and every field; omitted locales/fields stay
    # untouched on AMO. `name` is sent only for locales that actually changed.
    body = {"description": descriptions}
    if summaries:
        body["summary"] = summaries
    if names:
        body["name"] = names
    api_request(creds, "PATCH", f"/addons/addon/{guid}/", json_body=body)
    print(f"  description + summary updated for {len(descriptions)} locales"
          + (f"; name updated for {len(names)} locale(s) ✓" if names else "; name unchanged ✓"))


def upload_names(root, files):
    """One name per file, unique across the gallery.

    Basenames when they already distinguish the files — which is the case for a
    flat layout naming them Promo_1_en.png. But the default layout puts every
    locale in its own directory and calls them all "1.png", where a basename
    identifies nothing: not the log line, not the state entry, not the file AMO
    receives. There, the path relative to the assets root is the name.
    """
    names = [f.name for f in files]
    if len(set(names)) == len(names):
        return names

    out = []
    for f in files:
        try:
            rel = Path(f).resolve().relative_to(Path(root).resolve())
        except ValueError:
            out.append(f.name)
            continue
        flat = "-".join(rel.parts)
        out.append(flat if flat.lower().endswith(rel.suffix.lower()) else flat + rel.suffix)
    return out


def file_fingerprints(files, names):
    """Ordered [{name, sha1}] over the screenshot files — content-based so it's
    stable across rebuilds that only touch mtimes."""
    return [{"name": name, "sha1": hashlib.sha1(f.read_bytes()).hexdigest()}
            for f, name in zip(files, names)]


def load_previews_state():
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_previews_state(guid, fingerprints):
    state = load_previews_state()
    state[guid] = {
        "uploaded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "count": len(fingerprints),
        "files": fingerprints,
    }
    STATE_FILE.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")


PREVIEW_SETS = ("en-only", "en-plus-first-per-locale")


def preview_files(root, profile, item, locales, preview_set, base_locale):
    """The gallery, in upload order. AMO previews are not localized, so this is a
    policy choice, not a store rule:

      en-only                  the base locale's N screenshots. The honest
                               default for a single shared gallery.
      en-plus-first-per-locale those N, then the FIRST screenshot of every other
                               locale — a gallery that shows the listing is
                               translated. Costs one upload per language.
    """
    if preview_set not in PREVIEW_SETS:
        sys.exit(f'config amo.previewSet must be one of {", ".join(PREVIEW_SETS)} '
                 f'(got "{preview_set}")')
    total = screenshots_per_listing(profile)
    files = [asset_path(root, profile["screenshot"], item, base_locale, i)
             for i in range(1, total + 1)]
    if preview_set == "en-plus-first-per-locale":
        files += [asset_path(root, profile["screenshot"], item, loc, 1)
                  for loc in locales if loc["internal"] != base_locale["internal"]]
    return files


def update_images(creds, guid, addon, root, files, apply, force):
    previews = addon.get("previews", [])
    missing = [str(f) for f in files if not f.exists()]
    if missing:
        sys.exit("Missing screenshot files:\n  " + "\n  ".join(missing))

    names = upload_names(root, files)
    # Skip the whole teardown/re-upload when our recorded gallery already matches
    # the local files AND the live preview count lines up. --force-images overrides.
    fingerprints = file_fingerprints(files, names)
    recorded = load_previews_state().get(guid)
    in_sync = (recorded is not None
               and recorded.get("files") == fingerprints
               and len(previews) == len(files))
    if in_sync and not force:
        print(f"  previews already up to date ({len(files)} images, unchanged since "
              f"{recorded.get('uploaded_at', '?')}) - skipping (use --force-images to redo)")
        return

    if not apply:
        if force and in_sync:
            why = "forced (--force-images)"
        elif recorded is None:
            why = "no recorded state yet"
        elif len(previews) != len(files):
            why = f"live preview count {len(previews)} != expected {len(files)}"
        else:
            why = "screenshot contents changed"
        print(f"  would delete {len(previews)} existing previews, then upload "
              f"{len(files)} [{why}]: " + ", ".join(f["name"] for f in fingerprints))
        return

    # api_request paces writes itself (adaptive throttle handling), so no sleeps here.
    for p in previews:
        api_request(creds, "DELETE", f"/addons/addon/{guid}/previews/{p['id']}/")
        print(f"  deleted preview {p['id']}")
    for position, (f, name) in enumerate(zip(files, names), start=1):
        api_request(creds, "POST", f"/addons/addon/{guid}/previews/",
                    multipart={"image": (name, f.read_bytes()), "position": str(position)})
        print(f"  uploaded {name} (position {position}) ✓")
    # Record only after every upload succeeded (api_request exits on hard failure).
    save_previews_state(guid, fingerprints)
    print(f"  recorded gallery state ({len(files)} images) - future runs will skip if unchanged")


# ── main ──────────────────────────────────────────────────────────────────────

def main():
    # Never let a non-ASCII status char (✓, …) crash on a legacy code-page console.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--item", required=True, help="item slug from the config (e.g. my-extension)")
    ap.add_argument("--config", default=str(DEFAULT_CONFIG),
                    help=f"path to config.json (default: {DEFAULT_CONFIG})")
    ap.add_argument("--texts", action="store_true", help="update localized descriptions (+ summary/name if configured)")
    ap.add_argument("--images", action="store_true", help="replace the listing previews")
    ap.add_argument("--force-images", action="store_true",
                    help="re-upload previews even if the recorded gallery is unchanged")
    ap.add_argument("--apply", action="store_true",
                    help="actually write (default is dry-run). AMO changes go live immediately!")
    args = ap.parse_args()
    if not args.texts and not args.images:
        ap.error("nothing to do — pass --texts and/or --images")

    config = load_config(args.config)
    amo_cfg = config.get("amo") or {}
    if not amo_cfg.get("jwt_issuer") or "YOUR_" in amo_cfg.get("jwt_issuer", ""):
        sys.exit('Fill in "amo": {"jwt_issuer", "jwt_secret"} in your config.json '
                 "(from https://addons.mozilla.org/developers/addon/api/key/)")
    item = next((i for i in config.get("items", []) if i["slug"] == args.item), None)
    if not item:
        sys.exit(f'Item "{args.item}" not in the configuration')
    guid = item.get("amo_guid")
    if not guid:
        sys.exit(f'Item "{args.item}" has no "amo_guid" — AMO addresses add-ons by '
                 "their gecko id, so there is nothing to address.")

    root, profile = assets_profile(config, "firefox")
    locales = supported_locales(config)
    base_code = config.get("globalLocale", "en")
    base_locale = next((l for l in locales if l["internal"] == base_code), locales[0])

    print(f'{"APPLY" if args.apply else "DRY-RUN"} — {item["name"]} ({guid})')
    print(f"Assets root: {root}")
    addon = api_request(amo_cfg, "GET", f"/addons/addon/{guid}/")
    current_desc = addon.get("description") or {}
    if isinstance(current_desc, dict):
        print(f"Current listing: {len(current_desc)} description locales, "
              f"{len(addon.get('previews', []))} previews "
              f"(status: {addon.get('status')})")

    if args.texts:
        descriptions = build_descriptions(root, profile, item, locales)
        summaries = build_meta_field(root, item, locales, amo_cfg.get("summarySource"),
                                     "Summary", AMO_SUMMARY_MAX)
        names = changed_only(
            build_meta_field(root, item, locales, amo_cfg.get("nameSource"),
                             "Name", AMO_NAME_MAX),
            addon.get("name"))
        update_texts(amo_cfg, guid, descriptions, summaries, names, args.apply)
    if args.images:
        files = preview_files(root, profile, item, locales,
                              amo_cfg.get("previewSet", "en-only"), base_locale)
        update_images(amo_cfg, guid, addon, root, files, args.apply, args.force_images)

    print("Done." if args.apply else "Dry-run done — re-run with --apply to write (changes go live immediately).")


if __name__ == "__main__":
    main()

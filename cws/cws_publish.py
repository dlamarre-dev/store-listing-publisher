#!/usr/bin/env python3
"""
Chrome Web Store publisher — the API half of the CWS side.

Uploads the built package and drives the publication lifecycle through the
official Chrome Web Store API v2 (`chromewebstore.googleapis.com`). No scraping:
this is a real API.

What it CANNOT do, and why the Firefox add-on in extension/ exists: the API has
no listing metadata at all. Its discovery document defines five methods over two
resources, and not one field for a description, a localized description, a
screenshot, a promo tile or a category. The official guide states the prerequisite
outright — "Before you can publish a new item, you have to fill out the Store
listing and Privacy tabs in the Developer Dashboard." So the release splits by
what each mechanism can actually do:

    package + publication lifecycle  ->  this script
    localized listing draft          ->  extension/ (the only way there is)

The v1 API is deprecated and sunsets 15 October 2026; this targets v2 directly.

Usage (dry-run by default; --apply writes):
  python cws/cws_publish.py --item <slug> --status
  python cws/cws_publish.py --item <slug> --upload  [--package PATH] [--apply]
  python cws/cws_publish.py --item <slug> --publish [--staged] [--percentage N] [--apply]
  python cws/cws_publish.py --item <slug> --cancel  [--apply]
  python cws/cws_publish.py --item <slug> --rollout N [--apply]

Credentials go under "cws" in config.json — see config.example.json. Two modes:
a service account (preferred) or an OAuth refresh token. Everything here is
stdlib except RS256 signing for the service account, which needs `cryptography`
and is imported only on that path.
"""

import argparse
import base64
import contextlib
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API_BASE = "https://chromewebstore.googleapis.com/v2"
# Media uploads go to a DIFFERENT host path than every other method: /upload/v2
# rather than /v2. Sending the package to the plain path silently does nothing
# useful. (If Google ever rejects this with a complaint about uploadType, adding
# "?uploadType=media" is the first thing to try.)
API_UPLOAD_BASE = "https://chromewebstore.googleapis.com/upload/v2"
TOKEN_URL = "https://oauth2.googleapis.com/token"
SCOPE = "https://www.googleapis.com/auth/chromewebstore"
SA_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer"

TOOL_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOL_DIR.parent
# Beside the add-on's manifest: an extension can only fetch resources from its own
# directory, so that is the one place both halves of this tool can read the same
# file. --config overrides it.
DEFAULT_CONFIG = REPO_ROOT / "extension" / "config.json"

UPLOAD_POLL_S = 5           # between fetchStatus polls while an upload processes
UPLOAD_TIMEOUT_S = 600      # a large package can take minutes to process
RETRY_STATUSES = (429, 500, 503)
MAX_RETRIES = 5


# ── configuration and path templates ──────────────────────────────────────────
#
# Deliberately duplicated from amo/amo_publish.py rather than shared: that script
# is in service and validated, and two stores is not enough to justify a package.
# tests/test_config_parity.py pins the two copies to the same behaviour, because
# the risk of duplication is drift, not size. A third store is the signal to
# extract.

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
    """Objects merge a key at a time so a local `cws: {refresh_token}` does not
    erase the project's `cws: {...}`; arrays replace wholesale."""
    out = dict(base)
    for key, value in over.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            out[key] = merge_config(base[key], value)
        else:
            out[key] = value
    return out


def resolve_template(template, variables):
    """Substitutes {placeholders}. An unresolved one is fatal: a template that
    drops {version} would upload whichever build happened to be lying around."""
    if not isinstance(template, str) or not template:
        sys.exit(f"Path template missing or not a string: {template!r}")
    out = template
    for key, value in variables.items():
        out = out.replace("{" + key + "}", str(value))
    if "{" in out or "}" in out:
        sys.exit(f'Template "{template}" did not fully resolve: "{out}"')
    return out


def assets_profile(config, name="chrome"):
    assets = config.get("assets") or {}
    root = assets.get("root")
    if not root:
        sys.exit('config "assets.root" is required — the absolute path the '
                 "templates hang off.")
    profile = assets.get(name)
    if not profile:
        sys.exit(f'config "assets.{name}" is missing — no path templates to work from.')
    return Path(root).expanduser(), profile


def read_json_value(path, key):
    """One string out of a JSON file, tolerating Chrome's {"key": {"message": …}}
    wrapper. Shared shape with amo's summarySource/nameSource."""
    if not path.is_file():
        sys.exit(f"Not found: {path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except ValueError as exc:
        sys.exit(f"{path} is not valid JSON: {exc}")
    value = data.get(key)
    if isinstance(value, dict):
        value = value.get("message")
    value = (value or "").strip()
    if not value:
        sys.exit(f'"{key}" missing or empty in {path}')
    return value


def package_version(root, profile, item):
    """The version of the built package, read from the build's own manifest.

    Reading it rather than accepting it as an argument is the point: the number
    cannot then disagree with the bytes being uploaded.
    """
    source = profile.get("versionSource")
    if not source:
        sys.exit(f'config "assets.{profile.get("_name", "chrome")}.versionSource" is '
                 "required to resolve {version} in the package template — or pass "
                 "--package to name the file directly.")
    template, key = source.get("path"), source.get("key")
    if not template or not key:
        sys.exit('versionSource needs both "path" and "key".')
    path = root / resolve_template(template, {"slug": item["slug"]})
    return read_json_value(path, key)


def package_path(root, profile, item):
    template = profile.get("package")
    if not template:
        sys.exit('config "assets.chrome.package" is required (or pass --package).')
    version = package_version(root, profile, item)
    return root / resolve_template(template, {"slug": item["slug"], "version": version})


# ── authentication ────────────────────────────────────────────────────────────

def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def sign_rs256(message: bytes, private_key_pem: str) -> bytes:
    """RSA-SHA256, the one thing here the standard library cannot do.

    Imported inside this function on purpose: the refresh-token path must keep
    working on a machine with no third-party packages at all.
    """
    try:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding
    except ImportError:
        sys.exit("Service-account auth signs its JWT with RS256, which the standard "
                 "library cannot do. Either:\n"
                 "  pip install cryptography\n"
                 'or drop "serviceAccountKey" and use the refresh-token mode '
                 "instead (no dependencies, but the token expires every 7 days "
                 'while the OAuth consent screen is in "Testing").')
    key = serialization.load_pem_private_key(private_key_pem.encode(), password=None)
    return key.sign(message, padding.PKCS1v15(), hashes.SHA256())


def post_form(url, fields):
    data = urllib.parse.urlencode(fields).encode()
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:1000]
        sys.exit(f"Token request failed: HTTP {exc.code}\n{detail}")


def token_from_service_account(key_path):
    path = Path(key_path).expanduser()
    if not path.is_file():
        sys.exit(f'cws.serviceAccountKey points at a file that does not exist: {path}')
    try:
        key = json.loads(path.read_text(encoding="utf-8-sig"))
    except ValueError as exc:
        sys.exit(f"{path} is not valid JSON: {exc}")
    for field in ("client_email", "private_key"):
        if not key.get(field):
            sys.exit(f'{path} has no "{field}" — is it a service-account key file?')

    now = int(time.time())
    header = b64url(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    claims = b64url(json.dumps({
        "iss": key["client_email"], "scope": SCOPE, "aud": TOKEN_URL,
        "iat": now, "exp": now + 3600,
    }).encode())
    signing_input = f"{header}.{claims}".encode()
    assertion = f"{header}.{claims}.{b64url(sign_rs256(signing_input, key['private_key']))}"

    body = post_form(TOKEN_URL, {"grant_type": SA_GRANT, "assertion": assertion})
    if not body.get("access_token"):
        sys.exit(f"Service-account token exchange returned no access_token: {body}")
    return body["access_token"], f"service account {key['client_email']}"


def token_from_refresh_token(cws_cfg):
    for field in ("client_id", "client_secret", "refresh_token"):
        if not cws_cfg.get(field):
            sys.exit(f'Refresh-token auth needs "cws.{field}" in the config.')
    body = post_form(TOKEN_URL, {
        "grant_type": "refresh_token",
        "client_id": cws_cfg["client_id"],
        "client_secret": cws_cfg["client_secret"],
        "refresh_token": cws_cfg["refresh_token"],
    })
    if not body.get("access_token"):
        sys.exit(f"Refresh-token exchange returned no access_token: {body}")
    return body["access_token"], "OAuth refresh token"


def auth_mode(cws_cfg):
    """Which credentials to use. Returns the mode name without contacting Google,
    so it can be asserted in tests."""
    if cws_cfg.get("serviceAccountKey"):
        return "service_account"
    if cws_cfg.get("refresh_token"):
        return "refresh_token"
    return None


def get_access_token(cws_cfg):
    mode = auth_mode(cws_cfg)
    if mode == "service_account":
        return token_from_service_account(cws_cfg["serviceAccountKey"])
    if mode == "refresh_token":
        return token_from_refresh_token(cws_cfg)
    sys.exit('No Chrome Web Store credentials. Add ONE of these under "cws" in '
             "your config.json:\n"
             '  "serviceAccountKey": "/path/to/key.json"   (preferred — no expiry)\n'
             '  "client_id" + "client_secret" + "refresh_token"\n'
             "See https://developer.chrome.com/docs/webstore/using-api")


# ── API client ────────────────────────────────────────────────────────────────

def api_request(token, method, url, json_body=None, raw_body=None,
                content_type=None, max_retries=MAX_RETRIES):
    """One authenticated call. Returns parsed JSON (or None for an empty body).
    Retries the transient statuses, honouring Retry-After when offered."""
    headers = {"Authorization": "Bearer " + token}
    data = None
    if json_body is not None:
        data = json.dumps(json_body).encode()
        headers["Content-Type"] = "application/json"
    elif raw_body is not None:
        data = raw_body
        headers["Content-Type"] = content_type or "application/octet-stream"
        headers["Content-Length"] = str(len(raw_body))

    for attempt in range(max_retries + 1):
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=600) as resp:
                body = resp.read()
                return json.loads(body) if body else None
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:2000]
            if exc.code in RETRY_STATUSES and attempt < max_retries:
                hint = exc.headers.get("Retry-After")
                wait = int(hint) if (hint or "").strip().isdigit() else 5 * (attempt + 1)
                print(f"  HTTP {exc.code}; retrying in {wait}s "
                      f"(attempt {attempt + 1}/{max_retries})")
                time.sleep(wait)
                continue
            sys.exit(f"API {method} {url} failed: HTTP {exc.code}\n{detail}")
        except urllib.error.URLError as exc:
            if attempt < max_retries:
                print(f"  network error ({exc.reason}); retrying in 5s")
                time.sleep(5)
                continue
            sys.exit(f"API {method} {url} failed: {exc.reason}")


def item_name(config, item):
    publisher = config.get("publisher_id")
    if not publisher:
        sys.exit('config "publisher_id" is required — it is the publisher half of '
                 "the item's API name.")
    if not item.get("id"):
        sys.exit(f'Item "{item["slug"]}" has no "id" (the Chrome Web Store '
                 "extension id).")
    return f"publishers/{publisher}/items/{item['id']}"


# ── request builders (pure — this is what the tests pin) ──────────────────────

def build_publish_body(staged=False, percentage=None, block_on_warnings=False):
    """The PublishItemRequest body.

    `skipReview` is deliberately never set. It exists in the schema but is for
    allowlisted publishers, and a flag that tries to bypass review in a tool you
    run by hand is a foot-gun with a permanent blast radius.

    There is no trusted-testers option in v2: PublishItemRequest carries only
    publishType, skipReview, deployInfos and blockOnWarnings. PUBLISHED_TO_TESTERS
    exists as a state you can READ from fetchStatus, not as one you can request.
    """
    body = {"publishType": "STAGED_PUBLISH" if staged else "DEFAULT_PUBLISH"}
    if percentage is not None:
        if not 0 <= percentage <= 100:
            sys.exit(f"--percentage must be between 0 and 100 (got {percentage})")
        body["deployInfos"] = [{"deployPercentage": percentage}]
    if block_on_warnings:
        body["blockOnWarnings"] = True
    return body


def upload_url(name):
    return f"{API_UPLOAD_BASE}/{name}:upload"


def action_url(name, action):
    return f"{API_BASE}/{name}:{action}"


# ── operations ────────────────────────────────────────────────────────────────

def describe_revision(label, revision):
    if not revision:
        print(f"  {label}: none")
        return
    print(f"  {label}: {revision.get('state', '?')}")
    for channel in revision.get("distributionChannels", []) or []:
        bits = []
        if channel.get("crxVersion"):
            bits.append(f"v{channel['crxVersion']}")
        if channel.get("deployPercentage") is not None:
            bits.append(f"{channel['deployPercentage']}% rollout")
        if bits:
            print(f"    - {', '.join(bits)}")


def show_status(token, name):
    status = api_request(token, "GET", action_url(name, "fetchStatus"))
    print(f"Item {status.get('itemId', '?')}")
    describe_revision("published", status.get("publishedItemRevisionStatus"))
    describe_revision("submitted", status.get("submittedItemRevisionStatus"))
    upload_state = status.get("lastAsyncUploadState")
    if upload_state and upload_state != "UPLOAD_STATE_UNSPECIFIED":
        print(f"  last upload: {upload_state}")
    # These two are the ones that matter and are easy to miss in the dashboard.
    if status.get("warned"):
        print("  ⚠ WARNED for a policy violation — will be taken down if unresolved.")
    if status.get("takenDown"):
        print("  ⚠ TAKEN DOWN for a policy violation.")
    return status


def wait_for_upload(token, name):
    """The upload is asynchronous: a SUCCEEDED response is not guaranteed, and an
    IN_PROGRESS one has no crxVersion yet. Poll fetchStatus until it settles."""
    deadline = time.time() + UPLOAD_TIMEOUT_S
    while time.time() < deadline:
        time.sleep(UPLOAD_POLL_S)
        status = api_request(token, "GET", action_url(name, "fetchStatus"))
        state = status.get("lastAsyncUploadState")
        if state == "SUCCEEDED":
            print("  upload processed ✓")
            return status
        if state == "FAILED":
            sys.exit("Upload processing FAILED. Check the developer dashboard for "
                     "the rejection detail.")
        print(f"  upload {state or 'IN_PROGRESS'}…")
    sys.exit(f"Upload did not finish processing within {UPLOAD_TIMEOUT_S}s. "
             "It may still complete — re-run with --status to check.")


def do_upload(token, name, zip_path, apply_changes):
    if not zip_path.is_file():
        sys.exit(f"Package not found: {zip_path}\nRun the build first, or pass --package.")
    size = zip_path.stat().st_size
    print(f"  package: {zip_path} ({size / 1024 / 1024:.1f} MB)")
    if not apply_changes:
        print(f"  would POST {upload_url(name)} (raw zip body)")
        return
    result = api_request(token, "POST", upload_url(name),
                         raw_body=zip_path.read_bytes(),
                         content_type="application/zip")
    state = (result or {}).get("uploadState")
    print(f"  uploadState: {state}")
    if state == "SUCCEEDED":
        print(f"  crxVersion: {result.get('crxVersion')} ✓")
        return
    if state == "FAILED":
        sys.exit(f"Upload failed: {result}")
    wait_for_upload(token, name)


def do_publish(token, name, body, apply_changes):
    print(f"  publishType: {body['publishType']}")
    if "deployInfos" in body:
        print(f"  rollout: {body['deployInfos'][0]['deployPercentage']}%")
    if not apply_changes:
        print(f"  would POST {action_url(name, 'publish')} {json.dumps(body)}")
        return
    result = api_request(token, "POST", action_url(name, "publish"), json_body=body)
    print(f"  state: {(result or {}).get('state', '?')} ✓")
    for warning in ((result or {}).get("warningInfo") or {}).get("warnings", []):
        print(f"  ⚠ {warning.get('reason')}: {warning.get('description')}")


def do_cancel(token, name, apply_changes):
    if not apply_changes:
        print(f"  would POST {action_url(name, 'cancelSubmission')}")
        return
    api_request(token, "POST", action_url(name, "cancelSubmission"), json_body={})
    print("  submission cancelled ✓")


def do_rollout(token, name, percentage, apply_changes):
    if not 0 <= percentage <= 100:
        sys.exit(f"--rollout must be between 0 and 100 (got {percentage})")
    body = {"deployPercentage": percentage}
    if not apply_changes:
        print(f"  would POST {action_url(name, 'setPublishedDeployPercentage')} "
              f"{json.dumps(body)}")
        return
    api_request(token, "POST", action_url(name, "setPublishedDeployPercentage"),
                json_body=body)
    print(f"  published rollout set to {percentage}% ✓")


# ── main ──────────────────────────────────────────────────────────────────────

def main():
    # Never let a non-ASCII status char (✓, ⚠) crash on a legacy code-page console.
    for stream in (sys.stdout, sys.stderr):
        with contextlib.suppress(AttributeError, ValueError):
            stream.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--item", required=True, help="item slug from the config")
    ap.add_argument("--config", default=str(DEFAULT_CONFIG),
                    help=f"path to config.json (default: {DEFAULT_CONFIG})")
    ap.add_argument("--status", action="store_true",
                    help="show the published and submitted revisions (read-only)")
    ap.add_argument("--upload", action="store_true", help="upload the built package")
    ap.add_argument("--package", help="package file to upload (overrides the template)")
    ap.add_argument("--publish", action="store_true", help="submit the item for publication")
    ap.add_argument("--staged", action="store_true",
                    help="with --publish: hold after approval instead of going live")
    ap.add_argument("--percentage", type=int,
                    help="with --publish: initial rollout percentage")
    ap.add_argument("--block-on-warnings", action="store_true",
                    help="with --publish: fail instead of publishing with warnings")
    ap.add_argument("--cancel", action="store_true", help="cancel the active submission")
    ap.add_argument("--rollout", type=int, metavar="N",
                    help="raise the published revision's rollout percentage")
    ap.add_argument("--apply", action="store_true",
                    help="actually write (default is dry-run)")
    args = ap.parse_args()

    actions = [args.status, args.upload, args.publish, args.cancel, args.rollout is not None]
    if not any(actions):
        ap.error("nothing to do — pass --status, --upload, --publish, --cancel or --rollout")

    config = load_config(args.config)
    item = next((i for i in config.get("items", []) if i["slug"] == args.item), None)
    if not item:
        sys.exit(f'Item "{args.item}" not in the configuration')
    name = item_name(config, item)

    # A dry-run of a write makes no API call, so it must not demand credentials:
    # you can check the resolved package path and the exact body that would be
    # sent before doing any OAuth setup at all. --status is read-only but is a
    # real call, so it always needs a token.
    needs_token = args.status or args.apply
    token, who = (get_access_token(config.get("cws") or {}) if needs_token
                  else (None, "not contacted — dry-run"))
    mode = "APPLY" if args.apply else "DRY-RUN"
    print(f'{mode} — {item["name"]} ({item["id"]})')
    print(f"Authenticated as: {who}")

    if args.status:
        show_status(token, name)

    if args.upload:
        print("Upload package…")
        if args.package:
            zip_path = Path(args.package).expanduser()
        else:
            root, profile = assets_profile(config, "chrome")
            zip_path = package_path(root, profile, item)
        do_upload(token, name, zip_path, args.apply)

    if args.publish:
        print("Publish…")
        # The listing draft is not this script's business and never can be — see
        # the module docstring. Say so once, where it is actionable.
        print("  (the localized listing draft comes from extension/, and must be "
              "saved in the dashboard before a first publish)")
        do_publish(token, name,
                   build_publish_body(args.staged, args.percentage, args.block_on_warnings),
                   args.apply)

    if args.cancel:
        print("Cancel submission…")
        do_cancel(token, name, args.apply)

    if args.rollout is not None:
        print("Set published rollout…")
        do_rollout(token, name, args.rollout, args.apply)

    print("Done." if args.apply else "Dry-run done — re-run with --apply to write.")


if __name__ == "__main__":
    main()

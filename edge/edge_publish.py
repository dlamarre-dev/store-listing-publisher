#!/usr/bin/env python3
"""
Microsoft Edge Add-ons publisher — the API half of the Edge side.

Uploads the built package and publishes the draft through the official Edge
Add-ons Update REST API v1.1 (`api.addons.microsoftedge.microsoft.com`).

What it CANNOT do, and why the Firefox add-on in extension/ exists: the API has
no listing metadata. Microsoft states it outright — "There aren't REST API
endpoints for: Creating a new product. Updating a product's metadata, such as
the description. To create a new product or update a product's metadata, you
must use Microsoft Partner Center." Same shape as the Chrome Web Store, and for
the same reason the release splits by what each mechanism can actually do:

    package + publication      ->  this script
    localized listing draft    ->  extension/ (Partner Center, by hand or driver)

Usage (dry-run by default; --apply writes):
  python edge/edge_publish.py --item <slug> --status
  python edge/edge_publish.py --item <slug> --upload  [--package PATH] [--apply]
  python edge/edge_publish.py --item <slug> --publish [--notes "..."] [--apply]

Credentials go under "edge" in config.json — see config.example.json. v1.1 needs
no token exchange at all: two request headers and nothing to sign, which makes
this the only one of the three stores that is pure stdlib with no caveat.
"""

import argparse
import contextlib
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# The version lives in the AUTH, not the path: v1.1 still addresses /v1/...
# endpoints. Rewriting these to /v1.1/ is the obvious wrong turn.
API_BASE = "https://api.addons.microsoftedge.microsoft.com/v1"

TOOL_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOL_DIR.parent
# Beside the add-on's manifest: an extension can only fetch resources from its own
# directory, so that is the one place every half of this tool reads the same
# file. --config overrides it.
DEFAULT_CONFIG = REPO_ROOT / "extension" / "config.json"

OPERATION_POLL_S = 5        # between polls while an operation runs
OPERATION_TIMEOUT_S = 900   # certification-side processing can be slow
RETRY_STATUSES = (429, 500, 503)
MAX_RETRIES = 5

# The state file records the last operation id per product, because the API has
# no "what is this product's state" endpoint — only "how is THIS operation
# going". Without this, --status has nothing to ask about after the shell exits.
STATE_FILE = REPO_ROOT / ".edge-operations-state.json"  # gitignored


# ── configuration and path templates ──────────────────────────────────────────
#
# Deliberately duplicated from amo/ and cws/ rather than shared. NOTE: this is
# the third copy, which is the threshold those two files name as the signal to
# extract a common module — see tests/test_config_parity.py, which now pins
# three implementations to the same behaviour.

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
    """Objects merge a key at a time so a local `edge: {api_key}` does not erase
    the project's `edge: {...}`; arrays replace wholesale."""
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


def assets_profile(config, name="edge"):
    assets = config.get("assets") or {}
    root = assets.get("root")
    if not root:
        sys.exit('config "assets.root" is required — the absolute path the '
                 "templates hang off.")
    profile = assets.get(name)
    if not profile:
        sys.exit(f'config "assets.{name}" is missing — no path templates to work from.')
    return Path(root).expanduser(), profile


def package_version(root, profile, item):
    """The version of the built package, read from the build's own manifest, so
    the number cannot disagree with the bytes being uploaded."""
    source = profile.get("versionSource")
    if not source:
        sys.exit('config "assets.edge.versionSource" is required to resolve '
                 "{version} in the package template — or pass --package.")
    template, key = source.get("path"), source.get("key")
    if not template or not key:
        sys.exit('versionSource needs both "path" and "key".')
    path = root / resolve_template(template, {"slug": item["slug"]})
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


def package_path(root, profile, item):
    template = profile.get("package")
    if not template:
        sys.exit('config "assets.edge.package" is required (or pass --package).')
    version = package_version(root, profile, item)
    return root / resolve_template(template, {"slug": item["slug"], "version": version})


# ── credentials and addressing ────────────────────────────────────────────────

def edge_headers(edge_cfg):
    """v1.1 auth: two headers, nothing to exchange and nothing to sign.

    That is the whole scheme. The v1 flow (a client_credentials token from
    login.microsoftonline.com) is not implemented: support for it ended
    31 December 2024.
    """
    for field in ("client_id", "api_key"):
        if not edge_cfg.get(field):
            sys.exit('Edge credentials missing. Add this to your config.json:\n'
                     '  "edge": {\n'
                     '    "client_id": "...",\n'
                     '    "api_key": "...",\n'
                     '    "productIds": { "<slug>": "<GUID>" }\n'
                     '  }\n'
                     "Both come from Partner Center > Publish API > Create API "
                     "credentials.")
    return {
        "Authorization": f"ApiKey {edge_cfg['api_key']}",
        "X-ClientID": edge_cfg["client_id"],
    }


GUID_SHAPE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}"
                        r"-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
# The public store id is 32 letters in a-p, exactly like a Chrome extension id —
# and it is the one you see while browsing the store, so it is the easy one to
# copy by mistake.
PUBLIC_ID_SHAPE = re.compile(r"^[a-p]{32}$")


def product_id(edge_cfg, item):
    """The product GUID, from the local config rather than the committed one.

    Unlike a Chrome extension id it is published nowhere — it lives in the
    Partner Center URL — so it belongs with the credentials, not in a config the
    project commits to a public repo.

    Two different identifiers exist for one add-on and only one of them works
    here, so the shape is checked: the API wants Partner Center's GUID, while
    the id in the public store URL is a 32-letter string. Getting them mixed up
    otherwise surfaces as a bare 404 on the first write, long after the config
    was written.
    """
    ids = edge_cfg.get("productIds") or {}
    pid = ids.get(item["slug"])
    if not pid:
        sys.exit(f'No Edge product id for "{item["slug"]}". Add it to your '
                 f'config.json under edge.productIds.\n'
                 f"It is the GUID in the Partner Center URL, between "
                 f"'microsoftedge/' and '/packages'.")
    if not GUID_SHAPE.match(pid):
        hint = ("That looks like the id from the PUBLIC store URL "
                "(microsoftedge.microsoft.com/addons/detail/.../<id>), which the "
                "API does not accept."
                if PUBLIC_ID_SHAPE.match(pid) else
                "The API expects a 128-bit GUID, e.g. "
                "d34f98f5-f9b7-42b1-bebb-98707202b21d.")
        print(f'⚠ edge.productIds["{item["slug"]}"] = {pid}')
        print(f"  {hint}")
        print("  Partner Center > Microsoft Edge > Overview > your extension: the "
              "GUID is in the address bar between 'microsoftedge/' and '/packages'.")
        print("  Continuing anyway — if Microsoft has changed the format, this "
              "warning is the thing that is wrong.")
    return pid


# ── API client ────────────────────────────────────────────────────────────────

def api_request(headers, method, path, json_body=None, raw_body=None,
                content_type=None, max_retries=MAX_RETRIES):
    """One authenticated call. Returns (parsed_json_or_None, response_headers).

    The response headers matter here in a way they do not for the other two
    stores: both write endpoints answer 202 Accepted and put the operation id in
    the `Location` header, not in the body.
    """
    url = path if path.startswith("http") else API_BASE + path
    request_headers = dict(headers)
    data = None
    if json_body is not None:
        data = json.dumps(json_body).encode()
        request_headers["Content-Type"] = "application/json"
    elif raw_body is not None:
        data = raw_body
        request_headers["Content-Type"] = content_type or "application/octet-stream"

    for attempt in range(max_retries + 1):
        req = urllib.request.Request(url, data=data, headers=request_headers,
                                     method=method)
        try:
            with urllib.request.urlopen(req, timeout=600) as resp:
                body = resp.read()
                parsed = None
                if body:
                    try:
                        parsed = json.loads(body)
                    except ValueError:
                        parsed = {"raw": body.decode("utf-8", "replace")[:2000]}
                return parsed, dict(resp.headers)
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


def operation_id_from(response_headers):
    """The operation id, which arrives as the `Location` header.

    Documented as "This location header contains the operationID". It is the
    bare id, not a URL, but strip any path just in case Microsoft ever returns
    one — a trailing id is what every status endpoint wants either way.
    """
    location = (response_headers.get("Location")
                or response_headers.get("location") or "").strip()
    return location.rstrip("/").split("/")[-1] if location else ""


# ── operation state (there is no product-state endpoint) ──────────────────────

def load_state():
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return {}


def remember_operation(pid, kind, operation):
    state = load_state()
    state[pid] = {"kind": kind, "operation": operation,
                  "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    STATE_FILE.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")


OPERATION_PATHS = {
    "upload": "/products/{pid}/submissions/draft/package/operations/{op}",
    "publish": "/products/{pid}/submissions/operations/{op}",
}


def poll_operation(headers, pid, kind, operation, timeout_s=OPERATION_TIMEOUT_S):
    """Waits for an operation to leave InProgress. Returns the final payload."""
    path = OPERATION_PATHS[kind].format(pid=pid, op=operation)
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        body, _ = api_request(headers, "GET", path)
        status = (body or {}).get("status", "")
        if status and status != "InProgress":
            return body
        print(f"  {kind} {status or 'InProgress'}…")
        time.sleep(OPERATION_POLL_S)
    sys.exit(f"{kind} did not finish within {timeout_s}s. It may still complete — "
             f"re-run with --status to check.")


def describe_operation(body, kind):
    status = (body or {}).get("status", "?")
    print(f"  {kind}: {status}")
    message = (body or {}).get("message")
    if message:
        print(f"    {message}")
    for err in (body or {}).get("errors") or []:
        print(f"    ⚠ {err.get('code', '?')}: {err.get('message', '')}")
    return status


# ── operations ────────────────────────────────────────────────────────────────

def do_status(headers, pid, apply_changes=True):
    """Reports the last operation this tool started.

    The API has no endpoint for "what state is this product in" — only "how is
    THIS operation going". So this says what it actually knows, instead of
    dressing an operation up as a product status.
    """
    record = load_state().get(pid)
    if not record:
        print("  no operation recorded for this product yet.")
        print("  (the Edge API has no product-state endpoint — this reports the "
              "last upload or publish started from this checkout.)")
        return
    print(f"  last {record['kind']} started {record['at']} "
          f"(operation {record['operation']})")
    body, _ = api_request(headers, "GET",
                          OPERATION_PATHS[record["kind"]].format(
                              pid=pid, op=record["operation"]))
    describe_operation(body, record["kind"])


def do_upload(headers, pid, zip_path, apply_changes):
    if not zip_path.is_file():
        sys.exit(f"Package not found: {zip_path}\nRun the build first, or pass --package.")
    size = zip_path.stat().st_size
    print(f"  package: {zip_path} ({size / 1024 / 1024:.1f} MB)")
    path = f"/products/{pid}/submissions/draft/package"
    if not apply_changes:
        print(f"  would POST {API_BASE}{path} (raw zip body)")
        return
    _, response_headers = api_request(headers, "POST", path,
                                      raw_body=zip_path.read_bytes(),
                                      content_type="application/zip")
    operation = operation_id_from(response_headers)
    if not operation:
        sys.exit("Upload accepted but no Location header came back, so there is "
                 "no operation to follow. Check Partner Center.")
    print(f"  operation {operation}")
    remember_operation(pid, "upload", operation)
    body = poll_operation(headers, pid, "upload", operation)
    if describe_operation(body, "upload") != "Succeeded":
        sys.exit("Upload did not succeed — see the message above.")
    print("  upload succeeded ✓")


def do_publish(headers, pid, notes, apply_changes):
    path = f"/products/{pid}/submissions"
    body = {"notes": notes}
    print(f"  notes: {notes!r}")
    if not apply_changes:
        print(f"  would POST {API_BASE}{path} {json.dumps(body)}")
        # Worth saying out loud rather than discovering as an opaque 4xx.
        print("  (a first publish needs the Store listing and Privacy tabs "
              "filled in Partner Center — the API cannot do that)")
        return
    _, response_headers = api_request(headers, "POST", path, json_body=body)
    operation = operation_id_from(response_headers)
    if not operation:
        sys.exit("Publish accepted but no Location header came back, so there is "
                 "no operation to follow. Check Partner Center.")
    print(f"  operation {operation}")
    remember_operation(pid, "publish", operation)
    result = poll_operation(headers, pid, "publish", operation)
    if describe_operation(result, "publish") != "Succeeded":
        sys.exit("Publish did not succeed. If this is the product's first "
                 "submission, fill the Store listing and Privacy tabs in Partner "
                 "Center — the API has no endpoint for them.")
    print("  submitted for certification ✓")


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
                    help="report the last operation started from this checkout")
    ap.add_argument("--upload", action="store_true", help="upload the built package")
    ap.add_argument("--package", help="package file to upload (overrides the template)")
    ap.add_argument("--publish", action="store_true",
                    help="submit the current draft for certification")
    ap.add_argument("--notes", default="Automated submission.",
                    help="certification notes sent with --publish")
    ap.add_argument("--apply", action="store_true",
                    help="actually write (default is dry-run)")
    args = ap.parse_args()

    if not (args.status or args.upload or args.publish):
        ap.error("nothing to do — pass --status, --upload and/or --publish")

    config = load_config(args.config)
    item = next((i for i in config.get("items", []) if i["slug"] == args.item), None)
    if not item:
        sys.exit(f'Item "{args.item}" not in the configuration')

    edge_cfg = config.get("edge") or {}
    # A dry-run of a write makes no API call, so it must not demand credentials:
    # the resolved package path and the exact request can be checked before any
    # Partner Center setup exists. --status is read-only but is a real call.
    needs_api = args.status or args.apply
    headers = edge_headers(edge_cfg) if needs_api else {}
    pid = product_id(edge_cfg, item) if needs_api else "<product id>"

    mode = "APPLY" if args.apply else "DRY-RUN"
    print(f'{mode} — {item["name"]}')
    print(f"Product: {pid}")

    if args.status:
        print("Status…")
        do_status(headers, pid)

    if args.upload:
        print("Upload package…")
        if args.package:
            zip_path = Path(args.package).expanduser()
        else:
            root, profile = assets_profile(config, "edge")
            zip_path = package_path(root, profile, item)
        do_upload(headers, pid, zip_path, args.apply)

    if args.publish:
        print("Publish…")
        print("  (the localized listing comes from Partner Center, and the API "
              "cannot touch it — see the module docstring)")
        do_publish(headers, pid, args.notes, args.apply)

    print("Done." if args.apply else "Dry-run done — re-run with --apply to write.")


if __name__ == "__main__":
    main()

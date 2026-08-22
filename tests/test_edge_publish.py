#!/usr/bin/env python3
"""Covers the pure logic of edge/edge_publish.py.

    python tests/test_edge_publish.py

Stdlib only, no test runner, exit code is the result. Nothing here touches the
network. What is worth pinning is the addressing and the operation plumbing,
because Edge's API differs from the other two in two ways that are silent when
you get them wrong: the endpoint paths stay /v1/ even under v1.1 auth, and the
operation id arrives in a response HEADER rather than the body.
"""
import contextlib
import io
import json
import sys
import tempfile
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    with contextlib.suppress(AttributeError, ValueError):
        _stream.reconfigure(encoding="utf-8", errors="replace")

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "edge"))

import edge_publish as E

failures = []


def check(label, condition, detail=""):
    print(("  PASS  " if condition else "  FAIL  ") + label + (f"  {detail}" if detail else ""))
    if not condition:
        failures.append(label)


def expect_exit(label, fn, needle=""):
    """Every refusal here is a sys.exit with an explanation. Assert both that it
    refuses and that the message names the way out."""
    try:
        fn()
    except SystemExit as exc:
        message = str(exc)
        check(label, needle.lower() in message.lower(),
              f"said: {message.splitlines()[0][:70]}")
        return
    check(label, False, "did not exit")


ITEM = {"slug": "app", "name": "App"}
# A real-shaped GUID, so the happy path stays silent: a placeholder like
# "GUID-1" would trip the shape warning and make every unrelated assertion below
# read against a noisy stdout.
GUID = "d34f98f5-f9b7-42b1-bebb-98707202b21d"
CFG = {"client_id": "cid", "api_key": "key", "productIds": {"app": GUID}}


# ── the version lives in the auth, not the path ───────────────────────────────

print("endpoint version")
# v1.1 is an AUTHENTICATION version. The paths stay /v1/... — "correcting" them
# to /v1.1/ is the obvious wrong turn and would 404 against a live product.
check("API base is /v1, not /v1.1",
      E.API_BASE.endswith("/v1") and "/v1.1" not in E.API_BASE, E.API_BASE)
check("and points at the Edge add-ons host",
      E.API_BASE.startswith("https://api.addons.microsoftedge.microsoft.com/"))

print("operation paths")
upload_path = E.OPERATION_PATHS["upload"].format(pid="P", op="O")
publish_path = E.OPERATION_PATHS["publish"].format(pid="P", op="O")
check("upload status hangs off the draft package",
      upload_path == "/products/P/submissions/draft/package/operations/O", upload_path)
check("publish status hangs off submissions",
      publish_path == "/products/P/submissions/operations/O", publish_path)
# The two are genuinely different endpoints; polling the wrong one for a publish
# returns a stale upload result that reads like success.
check("the two paths are not interchangeable", upload_path != publish_path)


# ── auth: two headers, nothing exchanged ──────────────────────────────────────

print("auth headers")
headers = E.edge_headers(CFG)
check("Authorization uses the ApiKey scheme, not Bearer",
      headers["Authorization"] == "ApiKey key", headers["Authorization"])
check("the client id rides in X-ClientID", headers["X-ClientID"] == "cid")
check("and nothing else is sent", set(headers) == {"Authorization", "X-ClientID"})

expect_exit("a missing api_key names the Partner Center page",
            lambda: E.edge_headers({"client_id": "cid"}), "Publish API")
expect_exit("a missing client_id refuses too",
            lambda: E.edge_headers({"api_key": "key"}), "client_id")


# ── product addressing ────────────────────────────────────────────────────────

print("product id")
check("read from the local config, keyed by slug", E.product_id(CFG, ITEM) == GUID)
# The GUID is not published anywhere, so it lives with the credentials rather
# than in the config the project commits to a public repo.
expect_exit("a missing product id says where to find it",
            lambda: E.product_id({"productIds": {}}, ITEM), "Partner Center URL")
expect_exit("and names the item that is missing one",
            lambda: E.product_id({}, ITEM), "app")

# One add-on has two identifiers and only one works here. The public store id is
# the one you can see while browsing, so it is the easy one to copy — and using
# it surfaces as a bare 404 on the first write, long after the config was
# written. The warning turns that into a sentence.
print("product id shape")
warned = io.StringIO()
with contextlib.redirect_stdout(warned):
    E.product_id({"productIds": {"app": "abcdefghijklmnopabcdefghijklmnop"}}, ITEM)
text = warned.getvalue()
check("a 32-letter public store id is called out", "PUBLIC store URL" in text)
check("and the message says where the right one lives", "Partner Center" in text)

warned = io.StringIO()
with contextlib.redirect_stdout(warned):
    E.product_id({"productIds": {"app": "not-an-id"}}, ITEM)
check("any non-GUID is called out, not just that one shape",
      "128-bit GUID" in warned.getvalue())

# A warning, never a refusal: if Microsoft changes the format, the check is what
# is wrong, and a hard failure would block a run for a cosmetic reason.
warned = io.StringIO()
with contextlib.redirect_stdout(warned):
    good = E.product_id({"productIds": {"app": GUID}}, ITEM)
check("a real GUID passes silently", warned.getvalue() == "", warned.getvalue()[:60])
check("and is returned unchanged", good == GUID)


# ── the operation id arrives in a header ──────────────────────────────────────

print("operation id extraction")
# Both write endpoints answer 202 Accepted and put the id in `Location`. Reading
# the body instead finds nothing, and the run then has no operation to follow.
check("plain Location value", E.operation_id_from({"Location": "abc-123"}) == "abc-123")
check("header lookup is case-insensitive",
      E.operation_id_from({"location": "abc-123"}) == "abc-123")
check("a URL-shaped Location yields its last segment",
      E.operation_id_from({"Location": "https://x/y/abc-123"}) == "abc-123")
check("a trailing slash does not produce an empty id",
      E.operation_id_from({"Location": "https://x/y/abc-123/"}) == "abc-123")
check("surrounding whitespace is tolerated",
      E.operation_id_from({"Location": "  abc-123  "}) == "abc-123")
check("no header means no id, not a crash", E.operation_id_from({}) == "")


# ── package resolution ────────────────────────────────────────────────────────

print("package resolution")
with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    (root / "dist" / "app" / "edge").mkdir(parents=True)
    (root / "dist" / "app" / "edge" / "manifest.json").write_text(
        json.dumps({"version": "1.7.0"}), encoding="utf-8")

    profile = {
        "package": "dist/{slug}-edge-v{version}.zip",
        "versionSource": {"path": "dist/{slug}/edge/manifest.json", "key": "version"},
    }
    # Reading the version from the BUILT manifest is what stops the number in the
    # filename from disagreeing with the bytes inside it.
    check("version comes from the built manifest",
          E.package_version(root, profile, ITEM) == "1.7.0")
    check("package path resolves {slug} and {version}",
          E.package_path(root, profile, ITEM) == root / "dist" / "app-edge-v1.7.0.zip")

    expect_exit("a missing versionSource says to pass --package",
                lambda: E.package_path(root, {"package": "x-{version}.zip"}, ITEM),
                "--package")
    expect_exit("a missing package template is named",
                lambda: E.package_path(root, {"versionSource": profile["versionSource"]},
                                       ITEM),
                "assets.edge.package")

print("template safety")
expect_exit("an unresolved placeholder is fatal, not left in the path",
            lambda: E.resolve_template("{slug}-{nope}.zip", {"slug": "app"}),
            "did not fully resolve")


# ── operation state ───────────────────────────────────────────────────────────

print("operation state")
# There is no product-state endpoint, only operation-state ones, so --status can
# only report an operation this checkout started. Recording it is what makes
# --status possible at all after the shell exits.
check("both operation kinds are addressable",
      set(E.OPERATION_PATHS) == {"upload", "publish"})
check("the state file is gitignored by name",
      ".edge-operations-state.json" in
      (REPO / ".gitignore").read_text(encoding="utf-8"),
      "add it to .gitignore")


print()
if failures:
    print(f"{len(failures)} failure(s): " + ", ".join(failures))
    sys.exit(1)
print("all edge_publish checks passed")

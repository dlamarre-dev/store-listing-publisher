#!/usr/bin/env python3
"""Covers the pure logic of cws/cws_publish.py.

    python tests/test_cws_publish.py

Stdlib only, no test runner, exit code is the result — matching the scripts it
tests. Nothing here touches the network: what is worth pinning is the request
bodies, the URLs and the auth-mode choice, because those are where a mistake is
silent (a body Google accepts but that does the wrong thing) rather than loud.
"""
import builtins
import importlib
import importlib.util
import json
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "cws"))
sys.path.insert(0, str(REPO / "amo"))

import cws_publish as C

failures = []


def check(label, condition, detail=""):
    print(("  PASS  " if condition else "  FAIL  ") + label + (f"  {detail}" if detail else ""))
    if not condition:
        failures.append(label)


def expect_exit(label, fn, needle=""):
    """Every refusal in these scripts is a sys.exit with an explanation. Assert
    both that it refuses and that the message names the way out."""
    try:
        fn()
    except SystemExit as exc:
        message = str(exc)
        check(label, needle.lower() in message.lower(),
              f"said: {message.splitlines()[0][:70]}")
        return
    check(label, False, "did not exit")


# ── publish body ──────────────────────────────────────────────────────────────

print("publish body")
body = C.build_publish_body()
check("defaults to publishing on approval", body == {"publishType": "DEFAULT_PUBLISH"},
      json.dumps(body))

body = C.build_publish_body(staged=True)
check("--staged holds after approval", body["publishType"] == "STAGED_PUBLISH")

body = C.build_publish_body(percentage=10)
check("a rollout goes in deployInfos, as a list",
      body["deployInfos"] == [{"deployPercentage": 10}], json.dumps(body))

body = C.build_publish_body(block_on_warnings=True)
check("--block-on-warnings is sent only when asked", body.get("blockOnWarnings") is True)
check("and is absent otherwise", "blockOnWarnings" not in C.build_publish_body())

check("0% is a legal rollout, not a falsy skip",
      C.build_publish_body(percentage=0)["deployInfos"] == [{"deployPercentage": 0}])
expect_exit("refuses a rollout above 100",
            lambda: C.build_publish_body(percentage=101), "between 0 and 100")
expect_exit("refuses a negative rollout",
            lambda: C.build_publish_body(percentage=-1), "between 0 and 100")

# skipReview exists in the schema but is for allowlisted publishers. A flag that
# tries to bypass review, in a tool run by hand, is a permanent-damage foot-gun.
print("skipReview is never sent")
for kwargs in ({}, {"staged": True}, {"percentage": 50},
               {"staged": True, "percentage": 100, "block_on_warnings": True}):
    if "skipReview" in C.build_publish_body(**kwargs):
        check(f"skipReview leaked with {kwargs}", False)
        break
else:
    check("absent from every combination of options", True)

# v2's PublishItemRequest has no trusted-testers field — PUBLISHED_TO_TESTERS is a
# state you can read from fetchStatus, not one you can request. Pin that we did
# not invent one.
check("no invented trusted-testers field",
      not any("tester" in k.lower() for k in C.build_publish_body(staged=True)))


# ── URLs ──────────────────────────────────────────────────────────────────────

print("URLs")
NAME = "publishers/pub-123/items/abcdefghijklmnopabcdefghijklmnop"
# The upload endpoint lives under /upload/v2, every other method under /v2.
# Sending the package to the plain path does nothing useful.
check("upload uses the /upload/ host path",
      C.upload_url(NAME) ==
      f"https://chromewebstore.googleapis.com/upload/v2/{NAME}:upload",
      C.upload_url(NAME))
check("other actions use the plain path",
      C.action_url(NAME, "fetchStatus") ==
      f"https://chromewebstore.googleapis.com/v2/{NAME}:fetchStatus")
check("the two bases really differ", "/upload/v2/" in C.upload_url(NAME)
      and "/upload/v2/" not in C.action_url(NAME, "publish"))

print("item name")
config = {"publisher_id": "pub-123"}
item = {"slug": "app", "id": "abcdefghijklmnopabcdefghijklmnop", "name": "App"}
check("name is publishers/<pub>/items/<id>",
      C.item_name(config, item) == NAME, C.item_name(config, item))
expect_exit("refuses a config with no publisher_id",
            lambda: C.item_name({}, item), "publisher_id")
expect_exit("refuses an item with no store id",
            lambda: C.item_name(config, {"slug": "app", "name": "App"}), "no \"id\"")


# ── auth mode selection ───────────────────────────────────────────────────────

print("auth mode")
check("a service-account key wins",
      C.auth_mode({"serviceAccountKey": "/k.json", "refresh_token": "r"}) == "service_account")
check("a refresh token is used when there is no key",
      C.auth_mode({"client_id": "c", "client_secret": "s", "refresh_token": "r"})
      == "refresh_token")
check("nothing configured is nothing, not a guess", C.auth_mode({}) is None)
expect_exit("with neither, the error names both ways in",
            lambda: C.get_access_token({}), "serviceAccountKey")
expect_exit("and mentions the refresh token too",
            lambda: C.get_access_token({}), "refresh_token")
# The refresh path must stay usable on a machine with no third-party packages, so
# a partial refresh config must fail on the missing FIELD, not on an import.
expect_exit("an incomplete refresh config names the missing field",
            lambda: C.token_from_refresh_token({"refresh_token": "r"}), "client_id")


# ── the optional dependency stays optional ────────────────────────────────────
#
# `cryptography` is imported inside sign_rs256, so the whole tool must load and
# the refresh-token mode must work without it. That is easy to break by hoisting
# the import to the top of the module, and nothing else would notice: it is
# installed on most machines, including the one this was written on.

print("cryptography is genuinely optional")


def without_cryptography(fn):
    real = builtins.__import__

    def blocked(name, *args, **kwargs):
        if name.startswith("cryptography"):
            raise ImportError("simulated: not installed")
        return real(name, *args, **kwargs)

    builtins.__import__ = blocked
    try:
        importlib.reload(C)
        return fn()
    finally:
        builtins.__import__ = real
        importlib.reload(C)


def reimport_and_use():
    mode = C.auth_mode({"refresh_token": "r"})
    try:
        C.sign_rs256(b"payload", "not-a-key")
    except SystemExit as exc:
        return mode, str(exc)
    return mode, ""


mode, message = without_cryptography(reimport_and_use)
check("the module still imports and the refresh mode still resolves",
      mode == "refresh_token")
check("the service-account path names the package to install",
      "pip install cryptography" in message)
check("and offers the no-dependency mode as the alternative",
      "refresh-token" in message)

# The signing itself: exercised for real, since a JWT Google rejects is a failure
# that only shows up against the live API otherwise.
print("RS256 signing")
if importlib.util.find_spec("cryptography") is None:
    print("  SKIP  cryptography not installed (CI proves the other half)")
else:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding, rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()

    signature = C.sign_rs256(b"the.signing.input", pem)
    try:
        key.public_key().verify(signature, b"the.signing.input",
                                padding.PKCS1v15(), hashes.SHA256())
        check("the signature verifies against the public key", True)
    except Exception as exc:  # noqa: BLE001 - any failure is the same verdict
        check("the signature verifies against the public key", False, str(exc))

    # b64url must be unpadded: a '=' in a JWT segment makes it malformed.
    check("b64url strips padding", "=" not in C.b64url(b"abcde"))
    check("and is URL-safe", not set(C.b64url(bytes(range(256)))) & {"+", "/"})


# ── package resolution ────────────────────────────────────────────────────────

print("package resolution")
with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    (root / "dist" / "app" / "chrome").mkdir(parents=True)
    (root / "dist" / "app" / "chrome" / "manifest.json").write_text(
        json.dumps({"version": "4.6.0", "name": "App"}), encoding="utf-8")

    profile = {
        "package": "dist/{slug}-chrome-v{version}.zip",
        "versionSource": {"path": "dist/{slug}/chrome/manifest.json", "key": "version"},
    }
    # Reading the version out of the BUILT manifest is the point: the number
    # cannot then disagree with the bytes being uploaded.
    check("version comes from the built manifest",
          C.package_version(root, profile, item) == "4.6.0")
    resolved = C.package_path(root, profile, item)
    check("package path resolves {slug} and {version}",
          resolved == root / "dist" / "app-chrome-v4.6.0.zip", str(resolved))

    expect_exit("a missing versionSource says to pass --package",
                lambda: C.package_path(root, {"package": "x-{version}.zip"}, item),
                "--package")
    expect_exit("a missing package template is named",
                lambda: C.package_path(root, {"versionSource": profile["versionSource"]}, item),
                "assets.chrome.package")
    expect_exit("a version key absent from the manifest is fatal",
                lambda: C.package_version(
                    root, {"versionSource": {"path": "dist/{slug}/chrome/manifest.json",
                                             "key": "nope"}}, item),
                "missing or empty")

# A template that forgot {version} would upload whichever build was lying around.
print("template safety")
expect_exit("an unresolved placeholder is fatal, not left in the path",
            lambda: C.resolve_template("{slug}-{nope}.zip", {"slug": "app"}),
            "did not fully resolve")


# ── the shipped examples carry package templates ──────────────────────────────

print("shipped examples")
for name in sorted(p.name for p in (REPO / "examples").iterdir()):
    cfg = json.loads((REPO / "examples" / name).read_text(encoding="utf-8"))
    for store in ("chrome", "firefox"):
        profile = cfg["assets"][store]
        ok = ("{version}" in profile.get("package", "")
              and profile.get("versionSource", {}).get("key"))
        check(f"{name}: {store} can locate its package", bool(ok))


print()
if failures:
    print(f"{len(failures)} failure(s): " + ", ".join(failures))
    sys.exit(1)
print("all cws_publish checks passed")

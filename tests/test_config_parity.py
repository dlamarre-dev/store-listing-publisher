#!/usr/bin/env python3
"""Pins amo_publish, cws_publish and edge_publish to the same config behaviour.

    python tests/test_config_parity.py

Each script carries its own copy of load_config / merge_config /
resolve_template. The risk of that is not the duplicated lines, it is DRIFT —
one copy learning a rule the others do not, so the same config file means
different things depending on which half reads it. This is the test that makes
drift loud.

THREE copies is the threshold the earlier version of this file named as the
signal to extract a shared module. That extraction is now owed: it was deferred
while amo_publish.py was the only one in live service, and the argument for
deferring it weakens with every store. Until then, this file is what keeps the
three honest — and it should be deleted by whoever does the extraction.
"""
import json
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
for module_dir in ("amo", "cws", "edge"):
    sys.path.insert(0, str(REPO / module_dir))

import amo_publish as A
import cws_publish as C
import edge_publish as E

# Every implementation that must agree. Adding a store means adding it here, and
# nothing else in this file.
IMPLEMENTATIONS = [("amo", A), ("cws", C), ("edge", E)]

failures = []


def check(label, condition, detail=""):
    print(("  PASS  " if condition else "  FAIL  ") + label + (f"  {detail}" if detail else ""))
    if not condition:
        failures.append(label)


def every(fn_name, *args):
    """Calls the same function on every implementation. Returns [(name, result)]."""
    return [(name, getattr(mod, fn_name)(*args)) for name, mod in IMPLEMENTATIONS]


def agree(fn_name, *args):
    """(all_equal, results) across every implementation."""
    results = every(fn_name, *args)
    first = results[0][1]
    return all(r == first for _, r in results), results


def describe(results):
    return " ".join(f"{name}={value}" for name, value in results)


print("merge_config agrees")
cases = [
    ({"a": 1, "b": 2}, {"b": 3}),
    # The whole point of the two layers: a local credential must not erase the
    # project's policy in the same object.
    ({"amo": {"previewSet": "en-only"}}, {"amo": {"jwt_secret": "s"}}),
    ({"cws": {"serviceAccountKey": "k"}}, {"cws": {"refresh_token": "r"}}),
    # Arrays replace wholesale — a half-overridden locale table is worse than
    # either version.
    ({"locales": [1, 2, 3]}, {"locales": [9]}),
    ({"assets": {"root": "/a", "chrome": {"package": "x"}}},
     {"assets": {"root": "/b"}}),
    ({}, {"only": "over"}),
    ({"only": "base"}, {}),
]
for base, over in cases:
    ok, results = agree("merge_config", base, over)
    check(f"merge {json.dumps(over)[:40]}", ok, "" if ok else describe(results))


print("resolve_template agrees")
template_cases = [
    ("{slug}/{lang}/{n}.png", {"slug": "app", "lang": "fr", "n": 3}),
    ("dist/{slug}-chrome-v{version}.zip", {"slug": "app", "version": "1.2.3"}),
    ("no/placeholders.txt", {}),
    # A numeric substitution must stringify the same way on both sides.
    ("{n}", {"n": 0}),
]
for template, variables in template_cases:
    ok, results = agree("resolve_template", template, variables)
    check(f"resolve {template}", ok, "" if ok else describe(results))

print("all refuse an unresolved placeholder")
for name, module in IMPLEMENTATIONS:
    try:
        module.resolve_template("{slug}-{nope}.zip", {"slug": "app"})
        check(f"{name} refuses", False, "did not exit")
    except SystemExit as exc:
        check(f"{name} refuses", "did not fully resolve" in str(exc))


print("load_config agrees, including extends")
with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    project = tmp / "project.config.json"
    project.write_text(json.dumps({
        "items": [{"slug": "app", "name": "App", "id": "a" * 32}],
        "assets": {"root": "/srv", "chrome": {"package": "p-{version}.zip"}},
        "amo": {"previewSet": "en-only"},
        "cws": {"note": "from the project"},
        "locales": [{"internal": "en", "cws": "en", "amo": "en-US", "name": "English"}],
    }), encoding="utf-8")

    local = tmp / "config.json"
    local.write_text(json.dumps({
        "extends": str(project),
        "publisher_id": "pub-1",
        "amo": {"jwt_secret": "s"},
        "cws": {"refresh_token": "r"},
    }), encoding="utf-8")
    ok, results = agree("load_config", str(local))
    check("absolute extends resolves identically", ok, "" if ok else "results diverged")
    a = results[0][1]
    check("the project layer survived", a.get("locales") and a["amo"]["previewSet"] == "en-only")
    check("the local layer won where it spoke", a["publisher_id"] == "pub-1")
    check("objects merged rather than replaced",
          a["amo"]["jwt_secret"] == "s" and a["cws"]["note"] == "from the project")
    check('"extends" is consumed, not left in the result', "extends" not in a)

    # A relative extends resolves against the file that declared it — the only
    # anchor that survives the checkout being moved.
    relative = tmp / "relative.json"
    relative.write_text(json.dumps({
        "extends": "./project.config.json", "publisher_id": "pub-2",
    }), encoding="utf-8")
    ok, results = agree("load_config", str(relative))
    check("relative extends resolves identically", ok)
    check("and found the project file", bool(results[0][1].get("items")))

    print("all refuse the same broken configs")
    for label, path, needle in (
        ("a missing config file", str(tmp / "nope.json"), "not found"),
        ("invalid JSON", None, "not valid JSON"),
    ):
        if path is None:
            path = str(tmp / "broken.json")
            Path(path).write_text("{ not json", encoding="utf-8")
        for name, module in IMPLEMENTATIONS:
            try:
                module.load_config(path)
                check(f"{name} refuses {label}", False, "did not exit")
            except SystemExit as exc:
                check(f"{name} refuses {label}", needle.lower() in str(exc).lower(),
                      str(exc).splitlines()[0][:60])

    dangling = tmp / "dangling.json"
    dangling.write_text(json.dumps({"extends": str(tmp / "gone.json")}),
                        encoding="utf-8")
    for name, module in IMPLEMENTATIONS:
        try:
            module.load_config(str(dangling))
            check(f"{name} refuses a dangling extends", False, "did not exit")
        except SystemExit as exc:
            check(f"{name} refuses a dangling extends", "does not exist" in str(exc))


print("the shipped examples read the same through every half")
for example in sorted((REPO / "examples").iterdir()):
    with tempfile.TemporaryDirectory() as tmp:
        local = Path(tmp) / "config.json"
        local.write_text(json.dumps({
            "extends": str(example), "publisher_id": "pub-1",
        }), encoding="utf-8")
        ok, results = agree("load_config", str(local))
        check(f"{example.name}", ok, "" if ok else describe(results))


print()
if failures:
    print(f"{len(failures)} failure(s): " + ", ".join(failures))
    sys.exit(1)
print(f"{', '.join(n for n, _ in IMPLEMENTATIONS)} agree on every config case")

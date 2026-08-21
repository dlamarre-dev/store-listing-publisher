#!/usr/bin/env python3
"""Pins amo_publish and cws_publish to the same config behaviour.

    python tests/test_config_parity.py

The two scripts each carry their own copy of load_config / merge_config /
resolve_template, deliberately: amo_publish.py is in service and validated, and
two stores is not enough to justify a shared package. The risk of that choice is
not the duplicated lines, it is DRIFT — one copy learning a rule the other does
not, so the same config file means two different things depending on which half
reads it. This is the test that makes drift loud.

If a third store ever appears, that is the signal to extract a shared module and
delete this file.
"""
import json
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "cws"))
sys.path.insert(0, str(REPO / "amo"))

import amo_publish as A
import cws_publish as C

failures = []


def check(label, condition, detail=""):
    print(("  PASS  " if condition else "  FAIL  ") + label + (f"  {detail}" if detail else ""))
    if not condition:
        failures.append(label)


def both(fn_name, *args):
    """Calls the same function on both modules and returns the two results."""
    return getattr(A, fn_name)(*args), getattr(C, fn_name)(*args)


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
    a, c = both("merge_config", base, over)
    check(f"merge {json.dumps(over)[:40]}", a == c, f"amo={a} cws={c}")


print("resolve_template agrees")
template_cases = [
    ("{slug}/{lang}/{n}.png", {"slug": "app", "lang": "fr", "n": 3}),
    ("dist/{slug}-chrome-v{version}.zip", {"slug": "app", "version": "1.2.3"}),
    ("no/placeholders.txt", {}),
    # A numeric substitution must stringify the same way on both sides.
    ("{n}", {"n": 0}),
]
for template, variables in template_cases:
    a, c = both("resolve_template", template, variables)
    check(f"resolve {template}", a == c, f"amo={a} cws={c}")

print("both refuse an unresolved placeholder")
for module, name in ((A, "amo"), (C, "cws")):
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
    a, c = both("load_config", str(local))
    check("absolute extends resolves identically", a == c)
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
    a, c = both("load_config", str(relative))
    check("relative extends resolves identically", a == c)
    check("and found the project file", bool(a.get("items")))

    print("both refuse the same broken configs")
    for label, path, needle in (
        ("a missing config file", str(tmp / "nope.json"), "not found"),
        ("invalid JSON", None, "not valid JSON"),
    ):
        if path is None:
            path = str(tmp / "broken.json")
            Path(path).write_text("{ not json", encoding="utf-8")
        for module, name in ((A, "amo"), (C, "cws")):
            try:
                module.load_config(path)
                check(f"{name} refuses {label}", False, "did not exit")
            except SystemExit as exc:
                check(f"{name} refuses {label}", needle.lower() in str(exc).lower(),
                      str(exc).splitlines()[0][:60])

    dangling = tmp / "dangling.json"
    dangling.write_text(json.dumps({"extends": str(tmp / "gone.json")}),
                        encoding="utf-8")
    for module, name in ((A, "amo"), (C, "cws")):
        try:
            module.load_config(str(dangling))
            check(f"{name} refuses a dangling extends", False, "did not exit")
        except SystemExit as exc:
            check(f"{name} refuses a dangling extends", "does not exist" in str(exc))


print("the shipped examples read the same through both halves")
for example in sorted((REPO / "examples").iterdir()):
    with tempfile.TemporaryDirectory() as tmp:
        local = Path(tmp) / "config.json"
        local.write_text(json.dumps({
            "extends": str(example), "publisher_id": "pub-1",
        }), encoding="utf-8")
        a, c = both("load_config", str(local))
        check(f"{example.name}", a == c)


print()
if failures:
    print(f"{len(failures)} failure(s): " + ", ".join(failures))
    sys.exit(1)
print("amo and cws agree on every config case")

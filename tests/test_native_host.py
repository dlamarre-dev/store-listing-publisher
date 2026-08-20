#!/usr/bin/env python3
"""Exercises native/filereader.py over its real stdio protocol.

    python tests/test_native_host.py

Stdlib only, no test runner, exit code is the result — matching the scripts it
tests. It runs against a COPY of native/ in a temp directory, so it never
touches the allowed-roots.json an operator has installed.

What is worth testing here is the confinement, because the interesting failures
are the ones that look like success: a traversal that resolves back inside, or a
sibling directory whose name merely starts with an allowed root.
"""
import base64
import json
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
failures = []


def check(label, condition, detail=""):
    print(("  PASS  " if condition else "  FAIL  ") + label + (f"  {detail}" if detail else ""))
    if not condition:
        failures.append(label)


class Host:
    """A throwaway copy of native/, so the real install is left alone."""

    def __init__(self, tmp):
        self.dir = Path(tmp) / "native"
        shutil.copytree(REPO / "native", self.dir)
        self.script = self.dir / "filereader.py"
        self.roots_file = self.dir / "allowed-roots.json"
        self.roots_file.unlink(missing_ok=True)

    def set_roots(self, roots):
        self.roots_file.write_text(json.dumps({"roots": [str(r) for r in roots]}), encoding="utf-8")

    def clear_roots(self):
        self.roots_file.unlink(missing_ok=True)

    def ask(self, *messages):
        payload = b""
        for message in messages:
            data = json.dumps(message).encode()
            payload += struct.pack("<I", len(data)) + data
        proc = subprocess.run([sys.executable, str(self.script)], input=payload,
                             capture_output=True, check=False)
        out, replies, i = proc.stdout, [], 0
        while i + 4 <= len(out):
            size = struct.unpack("<I", out[i:i + 4])[0]
            replies.append(json.loads(out[i + 4:i + 4 + size]))
            i += 4 + size
        return replies


def main():
    with tempfile.TemporaryDirectory() as tmp:
        host = Host(tmp)
        sandbox = Path(tmp) / "sandbox"
        allowed = sandbox / "assets"
        allowed.mkdir(parents=True)
        inside = allowed / "description.txt"
        inside.write_text("hello from inside\n", encoding="utf-8")
        outside = sandbox / "secret.txt"
        outside.write_text("should never be served\n", encoding="utf-8")

        print("no allowed-roots.json -> everything refused (fail closed)")
        replies = host.ask({"path": str(inside)})
        check("refuses even a legitimate read", not replies[0]["ok"])
        check("points at the installer", "install-native-host" in replies[0].get("error", ""))

        print("root configured -> inside served, outside refused")
        host.set_roots([allowed])
        replies = host.ask({"path": str(inside)}, {"path": str(outside)})
        check("serves the file inside the root",
              replies[0]["ok"] and "inside" in replies[0]["content"])
        check("refuses the file outside", not replies[1]["ok"])
        check("names the boundary",
              "outside every allowed root" in replies[1].get("error", ""))

        # Resolving before comparing is what makes this hold; a textual check
        # against the requested path would let it through.
        print("traversal out of the root is resolved away")
        replies = host.ask({"path": str(allowed / ".." / "secret.txt")})
        check("refuses ../secret.txt", not replies[0]["ok"])

        # The case a startswith() check gets wrong: "/x/assets-evil" starts with
        # "/x/assets" as a string but is not inside it as a directory.
        print("a sibling sharing a name prefix is not inside the root")
        sibling = sandbox / "assets-evil"
        sibling.mkdir()
        (sibling / "x.txt").write_text("nope\n", encoding="utf-8")
        replies = host.ask({"path": str(sibling / "x.txt")})
        check("refuses assets-evil/x.txt while assets/ is allowed", not replies[0]["ok"])

        print("the root itself is readable, not just its children")
        host.set_roots([inside])
        replies = host.ask({"path": str(inside)})
        check("an exact-match root is served", replies[0]["ok"])
        host.set_roots([allowed])

        # Firefox kills any native->extension message over 1 MB, and a
        # screenshot's base64 exceeds that, so chunking is load-bearing.
        print("binary reads are chunked and round-trip")
        blob = bytes(range(256)) * 3000  # ~768 KB -> over 1 MB of base64
        (allowed / "shot.bin").write_bytes(blob)
        replies = host.ask({"path": str(allowed / "shot.bin"), "binary": True})
        check("every chunk ok", all(r["ok"] for r in replies))
        check("split into several messages", len(replies) > 1, f"{len(replies)} chunks")
        check("only the last is marked done",
              replies[-1]["done"] and not any(r["done"] for r in replies[:-1]))
        joined = "".join(r["chunk"] for r in replies)
        check("bytes survive the round trip", base64.b64decode(joined) == blob)

        print("ping reports the configured roots")
        replies = host.ask({"cmd": "ping"})
        check("ping ok", replies[0]["ok"])
        check("lists the root", any("assets" in p for p in replies[0]["roots"]))

        print("a request with neither path nor cmd errors cleanly")
        replies = host.ask({"nonsense": True})
        check("no crash, a message instead",
              not replies[0]["ok"] and "path" in replies[0]["error"])

        print("a missing file is an error, not a silent empty read")
        replies = host.ask({"path": str(allowed / "nope.txt")})
        check("reports the failure", not replies[0]["ok"])

    print()
    if failures:
        print(f"{len(failures)} failure(s): " + ", ".join(failures))
        return 1
    print("all native-host checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
Native messaging host for the Store Listing Publisher.

The add-on has no filesystem of its own, so this is how it reads the marketing
assets: text by default, base64 when the request carries "binary": true (used
for PNG screenshots).

Protocol: each message is a 4-byte little-endian length prefix + UTF-8 JSON.
Binary responses are streamed as {"ok", "chunk", "done"} messages, because
Firefox kills the connection on any native->extension message over 1 MB and the
base64 of a screenshot exceeds that.

Requests:
    {"path": "...", "binary": false}   read a file
    {"cmd": "ping"}                    report the allowed roots (setup check)

CONFINEMENT. Every path is resolved and must land inside one of the roots listed
in allowed-roots.json, written by the installer. This matters: a native host is
addressed by name, and any add-on whose id the host manifest allows can ask it
for a file. Without the check, that is "read any file on this machine" — an
acceptable shortcut for a private tool, not for one anybody can install. The
file missing means no roots, which means every read is refused: fail closed, so
a botched install cannot quietly grant everything.
"""
import base64
import json
import struct
import sys
from pathlib import Path

BINARY_CHUNK = 256 * 1024  # base64 chars per message, well under the 1 MB cap
ROOTS_FILE = Path(__file__).resolve().parent / "allowed-roots.json"


def send(msg):
    data = json.dumps(msg).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
    sys.stdout.buffer.flush()


def recv():
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    msg_len = struct.unpack("<I", raw_len)[0]
    if msg_len == 0:
        return None
    return json.loads(sys.stdin.buffer.read(msg_len))


def load_roots():
    """Absolute, symlink-resolved roots this host may read under.

    Read fresh on every request rather than cached at start-up: the host process
    is spawned per connection anyway, and re-reading means editing the file takes
    effect without a browser restart.
    """
    if not ROOTS_FILE.is_file():
        return []
    try:
        data = json.loads(ROOTS_FILE.read_text(encoding="utf-8-sig"))
    except (ValueError, OSError):
        return []
    roots = []
    for entry in data.get("roots", []):
        try:
            roots.append(Path(entry).expanduser().resolve(strict=False))
        except (OSError, ValueError):
            continue
    return roots


def resolve_allowed(path_str, roots):
    """The resolved path, or a refusal message.

    Resolving first is the point: it collapses "..", follows symlinks, and
    normalises separators, so a path that merely *starts* with an allowed root
    textually cannot escape it.
    """
    if not roots:
        return None, (
            "No readable roots configured. Run native/install-native-host.ps1 "
            "(or .sh) with the asset directory, which writes allowed-roots.json."
        )
    try:
        target = Path(path_str).expanduser().resolve(strict=False)
    except (OSError, ValueError) as exc:
        return None, f"Unusable path: {exc}"
    for root in roots:
        if target == root or root in target.parents:
            return target, None
    return None, (
        f"Refused: {target} is outside every allowed root "
        f"({', '.join(str(r) for r in roots)})."
    )


def serve(msg):
    roots = load_roots()

    if msg.get("cmd") == "ping":
        send({"ok": True, "roots": [str(r) for r in roots]})
        return

    path_str = msg.get("path")
    if not path_str:
        send({"ok": False, "error": 'Request carried neither "path" nor a known "cmd".'})
        return

    target, refusal = resolve_allowed(path_str, roots)
    if refusal:
        send({"ok": False, "error": refusal})
        return

    if msg.get("binary"):
        content = base64.b64encode(target.read_bytes()).decode("ascii")
        chunks = [content[i:i + BINARY_CHUNK]
                  for i in range(0, len(content), BINARY_CHUNK)] or [""]
        for idx, chunk in enumerate(chunks):
            send({"ok": True, "chunk": chunk, "done": idx == len(chunks) - 1})
    else:
        # utf-8-sig strips the BOM that Windows apps sometimes write
        send({"ok": True, "content": target.read_text(encoding="utf-8-sig")})


def main():
    while True:
        msg = recv()
        if msg is None:
            break
        try:
            serve(msg)
        except Exception as exc:  # noqa: BLE001 - every failure must reach the add-on
            send({"ok": False, "error": str(exc)})


if __name__ == "__main__":
    main()

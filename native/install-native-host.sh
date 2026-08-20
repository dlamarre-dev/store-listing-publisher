#!/usr/bin/env bash
# Registers the Store Listing Publisher's native messaging host with Firefox on
# macOS and Linux, and declares which directories it is allowed to read.
#
#   ./install-native-host.sh /srv/marketing
#   ./install-native-host.sh /srv/marketing /home/me/my-project
#
# Pass every directory the tool must read: the assets root from your config, and
# — if you use "extends" — the directory holding the project config file.
#
# Re-run after moving this checkout: the generated manifest records an absolute
# path to the launcher, and nothing else notices that it moved.

set -euo pipefail

HOST_NAME='com.storelistingpublisher.filereader'
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$HERE/host-manifest.example.json"
MANIFEST="$HERE/$HOST_NAME.json"
ROOTS="$HERE/allowed-roots.json"
LAUNCHER="$HERE/filereader.py"

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <readable-root> [more-roots...]" >&2
  exit 64
fi

case "$(uname -s)" in
  Darwin) TARGET_DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts" ;;
  *)      TARGET_DIR="$HOME/.mozilla/native-messaging-hosts" ;;
esac

# Resolve the roots now, so a typo fails here instead of mid-run as a refusal.
resolved=()
for candidate in "$@"; do
  if [ ! -d "$candidate" ]; then
    echo "Root does not exist (or is not a directory): $candidate" >&2
    exit 1
  fi
  resolved+=("$(cd "$candidate" && pwd -P)")
done

python3 - "$ROOTS" "${resolved[@]}" <<'PY'
import json, sys
out, roots = sys.argv[1], sys.argv[2:]
with open(out, 'w', encoding='utf-8') as fh:
    json.dump({'roots': roots}, fh, indent=2)
    fh.write('\n')
PY

chmod +x "$LAUNCHER"

python3 - "$TEMPLATE" "$MANIFEST" "$LAUNCHER" <<'PY'
import json, sys
template, out, launcher = sys.argv[1:4]
with open(template, encoding='utf-8') as fh:
    manifest = json.load(fh)
manifest['path'] = launcher
with open(out, 'w', encoding='utf-8') as fh:
    json.dump(manifest, fh, indent=2)
    fh.write('\n')
PY

mkdir -p "$TARGET_DIR"
ln -sf "$MANIFEST" "$TARGET_DIR/$HOST_NAME.json"

echo 'Registered the native messaging host.'
echo "  Manifest: $MANIFEST"
echo "  Linked:   $TARGET_DIR/$HOST_NAME.json"
echo "  Launcher: $LAUNCHER"
echo '  Readable roots:'
for r in "${resolved[@]}"; do echo "    $r"; done

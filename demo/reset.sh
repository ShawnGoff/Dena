#!/usr/bin/env bash
# Deletes the Pantry demo completely (folder, its Dena data, its Claude Code
# conversations), then sets it up again from the starter. Your own Dena data
# and your other projects are not touched.
#
# Stop the demo Dena server (Ctrl-C in its terminal) before running this.
set -euo pipefail

DENA_REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEMO_ROOT="${DEMO_ROOT:-$HOME/Dena-demo}"
PROJECT="$DEMO_ROOT/pantry"
DENA_HOME_DEMO="$DEMO_ROOT/.dena-home"
CLAUDE_DIR="$HOME/.claude/projects/$(echo "$PROJECT" | sed 's#[/ ]#-#g')"

case "$PROJECT" in
  "$HOME"/Dena-demo/pantry) ;;
  *) echo "Refusing to delete unexpected path: $PROJECT" >&2; exit 1 ;;
esac

rm -rf "$PROJECT" "$DENA_HOME_DEMO" "$CLAUDE_DIR"
echo "Removed the old Pantry demo."

"$DENA_REPO/demo/setup.sh"

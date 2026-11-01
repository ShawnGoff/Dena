#!/usr/bin/env bash
# Creates the Pantry demo folder, registers it with a separate Dena data folder,
# and leaves the folder at the starter state. Run reset.sh to get back here.
set -euo pipefail

DENA_REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEMO_ROOT="${DEMO_ROOT:-$HOME/Dena-demo}"
PROJECT="$DEMO_ROOT/pantry"
export DENA_HOME="$DEMO_ROOT/.dena-home"

if [ -e "$PROJECT" ]; then
  echo "$PROJECT already exists. Run reset.sh to start over." >&2
  exit 1
fi

mkdir -p "$PROJECT"
cp "$DENA_REPO/demo/starter/README.md" "$DENA_REPO/demo/starter/.gitignore" "$PROJECT/"
git -C "$PROJECT" init -q
git -C "$PROJECT" add -A
git -C "$PROJECT" -c user.name="Pantry demo" -c user.email="demo@example.com" commit -q -m "Starter: Pantry brief"

(cd "$DENA_REPO" && npm run -s dena -- init "$PROJECT" --name Pantry)

echo "Pantry is ready at $PROJECT"
echo "Dena data for the demo is in $DENA_HOME (separate from your own Dena)."
echo "Start the demo Dena with: DENA_HOME=\"$DENA_HOME\" npm --prefix \"$DENA_REPO\" run -s dena -- serve --port 4577 --open"

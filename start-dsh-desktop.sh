#!/usr/bin/env bash
# start-dsh-desktop.sh — launcher invoked by the .desktop entry.
# Sets up PATH so the Electron process can find bun/node, then starts the app.
set -euo pipefail

export PATH="$HOME/.bun/bin:$HOME/.nvm/versions/node/$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin${PATH:+:$PATH}"

cd /home/jessen/projects/dsh-desktop
exec ./node_modules/.bin/electron --no-sandbox .

#!/bin/bash
# Double-click this to update Progress Tracker to the latest version.
# The first time, your Mac may say "cannot verify the developer". Right-click
# this file → Open → Open in the dialog. That happens once.

cd "$(dirname "$0")"

if ! command -v node &> /dev/null; then
  echo "Node.js is not installed. Install it from nodejs.org first."
  read -p "Press Enter to close..."
  exit 1
fi

node update.mjs

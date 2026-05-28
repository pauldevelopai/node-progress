#!/bin/bash
# Double-click this to launch Progress Tracker.
# The first time, your Mac may say "cannot verify the developer". Right-click
# this file → Open → Open in the dialog. That happens once.

cd "$(dirname "$0")"
( sleep 3 && open http://localhost:3000 ) &
npm start

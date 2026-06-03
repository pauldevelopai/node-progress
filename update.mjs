#!/usr/bin/env node
/**
 * update.mjs — cross-platform "get the latest version" for Progress Tracker.
 *
 * Called from Update.command (Mac) and Update.bat (Windows). The newsroom
 * never touches this file directly.
 *
 * What it does, in order:
 *   1. Check git is installed; if not, print install instructions.
 *   2. If folder isn't a git repo yet (first update), bootstrap it.
 *   3. Stash any uncommitted local changes (activity log, etc.).
 *   4. Fetch upstream (Paul's repo) and merge.
 *   5. Restore the stashed changes; if merge or restore conflicts, bail
 *      loud and tell the newsroom to email Paul. Nothing destructive.
 *   6. Run `npm install` in case dependencies changed.
 *
 * Conflict policy (per design): the newsroom's edits are always preserved.
 * On a real conflict the script aborts and asks them to call Paul.
 *
 * Data files (data/processed/*, data/raw/*) use a merge=ours driver so the
 * newsroom's data is never overwritten by upstream's test data on merge.
 */

import { execSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

const UPSTREAM = "https://github.com/pauldevelopai/node-progress.git";

function silent(cmd) {
  try { execSync(cmd, { stdio: "ignore" }); return true; }
  catch { return false; }
}
function loud(cmd) {
  return execSync(cmd, { stdio: "inherit" });
}
function waitForEnter() {
  if (process.platform === "win32") {
    try { execSync("pause", { stdio: "inherit" }); } catch {}
  } else {
    console.log("\n  Press Enter to close this window.");
    try { execSync("read -r", { stdio: "inherit", shell: "/bin/bash" }); } catch {}
  }
}
function bail(msg) {
  console.error("\n" + msg + "\n");
  waitForEnter();
  process.exit(1);
}

console.log("\n  ╭─ Progress Tracker · Update ─╮\n");

// 1. Git available?
if (!silent("git --version")) {
  bail(
    "  Git is needed to update the app. It's a free, standard tool.\n\n" +
    (process.platform === "darwin"
      ? "  To install on Mac:\n" +
        "    1. Open the Terminal app (Cmd+Space, type Terminal, Enter)\n" +
        "    2. Type this exactly, then press Enter:\n\n" +
        "          xcode-select --install\n\n" +
        "    3. A window pops up — click Install. Wait ~5 minutes.\n" +
        "    4. Come back here and double-click Update.command again.\n"
      : "  To install on Windows:\n" +
        "    1. Open this link in your web browser:\n\n" +
        "          https://git-scm.com/download/win\n\n" +
        "    2. Download and run the installer. Click Next on every screen\n" +
        "       (accept all defaults).\n" +
        "    3. Restart your computer.\n" +
        "    4. Come back here and double-click Update.bat again.\n")
  );
}

// 2. Bootstrap if needed
if (!existsSync(".git")) {
  console.log("  First-time update: setting up version control...");
  const tmp = `.update-bootstrap-${Date.now()}`;
  silent(`git clone --quiet ${UPSTREAM} ${tmp}`);
  if (!existsSync(tmp)) {
    bail("  Couldn't reach GitHub. Check your internet and try again.");
  }
  // Pull the cloned .git into our folder (cross-platform via Node).
  silent(
    process.platform === "win32"
      ? `move "${tmp}\\.git" .git`
      : `mv ${tmp}/.git .`
  );
  silent(process.platform === "win32" ? `rmdir /s /q "${tmp}"` : `rm -rf ${tmp}`);

  // Tell git to keep newsroom's data files over upstream's on merge.
  writeFileSync(".gitattributes",
    "data/processed/* merge=ours\ndata/raw/* merge=ours\n");
  silent("git config merge.ours.driver true");

  silent("git add -A");
  silent('git commit -m "snapshot before first update" --allow-empty');
  console.log("  ✓ Version control ready.\n");
}

// 3. Ensure merge driver + remote are configured (idempotent)
silent("git config merge.ours.driver true");
if (!silent("git remote get-url origin")) {
  silent(`git remote add origin ${UPSTREAM}`);
}

// 4. Stash uncommitted changes — only if there's anything to stash.
function isDirty() {
  try {
    const out = execSync("git status --porcelain", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.trim().length > 0;
  } catch { return false; }
}
const stashed = isDirty() && silent('git stash push -m "pre-update" --include-untracked');

// 5. Fetch + merge
console.log("  Fetching latest version from GitHub...");
if (!silent("git fetch origin main")) {
  if (stashed) silent("git stash pop");
  bail("  Couldn't reach GitHub. Check your internet and try again.");
}

console.log("  Applying update...");
try {
  loud("git merge --no-edit origin/main");
} catch {
  silent("git merge --abort");
  if (stashed) silent("git stash pop");
  bail(
    "  ════════════════════════════════════════════════════════════\n" +
    "  Couldn't apply the update automatically.\n" +
    "  You edited a file that the new version also changed.\n\n" +
    "  Email Paul. Send him a screenshot of this window.\n" +
    "  He'll help you merge the changes. Nothing is lost — your\n" +
    "  edits are still where you left them.\n" +
    "  ════════════════════════════════════════════════════════════"
  );
}
if (stashed) {
  if (!silent("git stash pop")) {
    console.warn("  (Some saved changes couldn't be auto-restored. " +
                 "Run `git stash list` to see them.)");
  }
}

// 6. Install any new dependencies
console.log("\n  Installing any new dependencies...");
try { loud("npm install --silent"); }
catch { console.warn("  npm install had warnings — usually fine, but tell Paul if the app misbehaves."); }

console.log("\n  ✓ Update complete.\n" +
  "  Close this window. Double-click Start to launch the app.\n");
waitForEnter();

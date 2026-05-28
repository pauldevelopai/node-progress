// public/app.js — Progress Tracker dashboard.
// Relative paths only (fetch("api/…"), assets without a leading slash) so it
// works at / locally and under /nodes/progress-tracker/app/ when hosted.

const $ = (s) => document.querySelector(s);
const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(Math.round(n)));
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const today = () => new Date().toISOString().slice(0, 10);
const CHANNELS = ["facebook", "website", "tiktok", "whatsapp", "other"];
const CH_LABEL = { facebook: "FB", website: "Web", tiktok: "TikTok", whatsapp: "WA", other: "Other" };

let REPORT = null;
let chosenProvider = "anthropic";

// ── Branding (newsroom name + product) from /api/setup ────────────────────────
function applyBrand(setup) {
  const product = setup.productName || "Progress Tracker";
  const nr = setup.newsroom;
  const full = nr ? `${nr} ${product}` : product;
  document.title = full;
  const k = $("#brand-kicker"); if (k) k.textContent = `${nr ? nr + " · " : ""}${product} Node${setup.serverManaged ? "" : " · running locally"}`;
  const h = $("#brand-h1"); if (h) h.innerHTML = `${nr ? esc(nr) + " " : ""}<span>${esc(product)}</span>`;
  const f = $("#brand-foot"); if (f) f.textContent = `${full} — a Node on GROUNDED`;
}

async function boot() {
  const setup = await fetch("api/setup").then((r) => r.json()).catch(() => ({ configured: false }));
  applyBrand(setup);
  if (!setup.configured && !setup.serverManaged) { showSetup(); return; }
  if (!setup.serverManaged) $("#open-setup").style.display = "inline-block";
  await loadDashboard();
}

function showSetup() { $("#setup").style.display = "block"; $("#dash").style.display = "none"; }
function showDash() { $("#setup").style.display = "none"; $("#dash").style.display = "block"; }

// ── Setup form ────────────────────────────────────────────────────────────────
document.querySelectorAll(".setup-opt").forEach((el) => {
  el.addEventListener("click", () => {
    document.querySelectorAll(".setup-opt").forEach((x) => x.classList.remove("on"));
    el.classList.add("on");
    chosenProvider = el.dataset.provider;
  });
});
$("#open-setup")?.addEventListener("click", (e) => { e.preventDefault(); $("#setup-err").classList.remove("on"); $("#setup-key-input").value = ""; showSetup(); });
$("#setup-save")?.addEventListener("click", async () => {
  const errBox = $("#setup-err"); errBox.classList.remove("on");
  const apiKey = $("#setup-key-input").value.trim();
  if (!apiKey) { errBox.textContent = "Paste your API key first."; errBox.classList.add("on"); return; }
  const btn = $("#setup-save"); btn.disabled = true; btn.textContent = "Saving…";
  try {
    const res = await fetch("api/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: chosenProvider, apiKey }) });
    const data = await res.json();
    if (!res.ok || data.error || data.ok === false) throw new Error(data.error || data.message || "Save failed");
    await boot();
  } catch (e) { errBox.textContent = e.message; errBox.classList.add("on"); }
  finally { btn.disabled = false; btn.textContent = "Save and continue"; }
});

// ── Load + render the dashboard ───────────────────────────────────────────────
async function loadDashboard() {
  REPORT = await fetch("api/report").then((r) => r.json()).catch(() => ({ empty: true }));
  showDash();
  populateReporterSelects();
  renderTopline();
  renderCards();
  renderFeed();
  renderPerf();
  renderTimeline();
  // Reset brief
  $("#ai-out").className = "placeholder"; $("#ai-out").textContent = "No brief yet. Press “Generate brief”.";
  $("#gen").textContent = "Generate brief";
}

function renderTopline() {
  const t = REPORT.topline || {};
  $("#m-reporters").textContent = t.reporters ?? 0;
  $("#m-week").textContent = t.itemsThisWeek ?? 0;
  $("#meta-date").textContent = REPORT.today ? `today ${REPORT.today}` : "";
  const cells = [
    ["Reporters", t.reporters ?? 0, ""],
    ["Active this week", t.activeThisWeek ?? 0, ""],
    ["Items today", t.itemsToday ?? 0, ""],
    ["Items this week", t.itemsThisWeek ?? 0, ""],
    ["Total reach", fmt(t.totalReach || 0), t.trackedPosts ? ` · ${t.trackedPosts} posts` : ""],
  ];
  $("#topline").innerHTML = cells.map((c) => `<div class="stat"><div class="l">${c[0]}</div><div class="v">${c[1]}<small>${c[2]}</small></div></div>`).join("");
}

function chips(byChannel) {
  return `<div class="chips">${CHANNELS.map((c) => {
    const n = byChannel[c] || 0;
    return `<span class="chip ${c}${n ? "" : " zero"}">${CH_LABEL[c]} ${n}</span>`;
  }).join("")}</div>`;
}

function renderCards() {
  const rs = REPORT.reporters || [];
  if (!rs.length) {
    $("#cards").innerHTML = `<div class="empty-hint"><h2>No reporters yet</h2><p>Press <b>+ Add reporter</b> to build your roster, then log output or paste a daily report.</p></div>`;
    return;
  }
  $("#cards").innerHTML = rs.map((r) => {
    const tgt = r.daily_target != null
      ? `<span class="target ${r.targetStatus}">${r.today}/${r.daily_target} today</span>`
      : "";
    const off = r.onRoster ? "" : `<span class="offroster">not on roster</span> `;
    const stale = r.lastActive ? "" : "stale";
    const perf = r.posts
      ? `<div class="perf">${r.posts} tracked posts · reach <b>${fmt(r.reach)}</b> · eng-rate <b>${r.engagementRate ?? "—"}%</b>${r.topPost ? ` · top: ${esc(r.topPost.title)}` : ""}</div>`
      : "";
    const link = r.submitToken
      ? `<div class="cardlink"><button class="linkbtn" data-token="${esc(r.submitToken)}">Copy submit link</button><span class="linkmsg dim"></span></div>`
      : "";
    return `<div class="card">
      <div class="top">
        <div><div class="nm">${off}${esc(r.name)}</div><div class="beat">${esc(r.beat || "—")}</div></div>
        ${tgt}
      </div>
      <div class="nums">
        <div class="b"><b>${r.week}</b> this week</div>
        <div class="b"><b>${r.items}</b> all-time</div>
        <div class="b"><b class="${stale}">${r.lastActive || "never"}</b> last active</div>
      </div>
      ${chips(r.byChannel)}
      ${perf}
      ${link}
    </div>`;
  }).join("");
}

// Copy a reporter's personal self-serve submit link (resolved to an absolute URL
// relative to wherever the dashboard is served — works locally and hosted).
document.querySelector("#cards")?.addEventListener("click", (e) => {
  const b = e.target.closest(".linkbtn"); if (!b) return;
  const url = new URL("submit.html?t=" + encodeURIComponent(b.dataset.token), location.href).href;
  const msg = b.parentElement.querySelector(".linkmsg");
  const done = (t) => { if (msg) { msg.textContent = t; setTimeout(() => (msg.textContent = ""), 2500); } };
  navigator.clipboard?.writeText(url).then(() => done("Copied — send it to them"), () => {
    window.prompt("Copy this submit link for the reporter:", url);
  });
});

function renderFeed() {
  const feed = REPORT.feed || [];
  if (!feed.length) { $("#feed-tb").innerHTML = `<tr><td colspan="6" class="dim">No output logged yet.</td></tr>`; return; }
  $("#feed-tb").innerHTML = feed.map((e) => `<tr>
    <td class="mono dim" style="white-space:nowrap">${esc(e.entry_date || "—")}</td>
    <td>${esc(e.reporter_name)}</td>
    <td><span class="pill">${CH_LABEL[e.channel] || e.channel}</span></td>
    <td class="mono dim">${esc(e.item_type)}</td>
    <td class="tt">${e.url ? `<a class="lnk" href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title || e.url)}</a>` : esc(e.title || "—")}</td>
    <td class="r mono">${e.qty}</td></tr>`).join("");
}

function renderPerf() {
  const rows = REPORT.standouts || [];
  if (!rows.length) { $("#perf-tb").innerHTML = `<tr><td colspan="6" class="dim">No performance numbers yet — add some with “Add performance”.</td></tr>`; return; }
  $("#perf-tb").innerHTML = rows.map((s) => `<tr>
    <td class="tt">${s.url ? `<a class="lnk" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>` : esc(s.title)}</td>
    <td>${esc(s.reporter_name)}</td>
    <td><span class="pill">${CH_LABEL[s.channel] || s.channel}</span></td>
    <td class="r mono">${s.reach.toLocaleString()}</td>
    <td class="r mono">${s.engagement.toLocaleString()}</td>
    <td class="r mono">${s.rate}%</td></tr>`).join("");
}

function renderTimeline() {
  const tl = REPORT.timeline || [];
  const max = Math.max(...tl.map((t) => t.items), 1);
  $("#timeline").innerHTML = tl.map((t) => `<div class="barrow">
    <div class="barlbl">${t.date.slice(5)}</div>
    <div class="track"><div class="fill" style="width:${(t.items / max * 100).toFixed(1)}%"></div></div>
    <div class="barval">${t.items}</div></div>`).join("");
}

// ── Reporter dropdowns ────────────────────────────────────────────────────────
function populateReporterSelects() {
  const names = (REPORT.reporters || []).map((r) => r.name);
  const opts = names.length
    ? names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("")
    : `<option value="">— add a reporter first —</option>`;
  ["#e-reporter", "#dr-reporter", "#m-reporter"].forEach((sel) => { const el = $(sel); if (el) el.innerHTML = opts; });
  // default dates
  ["#e-date", "#dr-date", "#m-date"].forEach((sel) => { const el = $(sel); if (el && !el.value) el.value = today(); });
}

// ── Action panels ─────────────────────────────────────────────────────────────
document.querySelector(".actions")?.addEventListener("click", (e) => {
  const b = e.target.closest(".act[data-panel]"); if (!b) return;
  const id = b.dataset.panel;
  const wasOn = b.classList.contains("on");
  document.querySelectorAll(".act").forEach((x) => x.classList.remove("on"));
  document.querySelectorAll(".panel").forEach((x) => x.classList.remove("on"));
  if (!wasOn) { b.classList.add("on"); $("#p-" + id).classList.add("on"); }
});

function setMsg(sel, text, ok) { const el = $(sel); el.textContent = text; el.className = "form-msg " + (ok ? "ok" : "bad"); }

async function postJson(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error || data.ok === false) throw new Error(data.error || data.message || "Request failed");
  return data;
}

// Add reporter
$("#r-save")?.addEventListener("click", async () => {
  const name = $("#r-name").value.trim();
  if (!name) return setMsg("#r-msg", "Enter a name.", false);
  const btn = $("#r-save"); btn.disabled = true;
  try {
    const data = await postJson("api/reporters", {
      name, beat: $("#r-beat").value.trim(), daily_target: $("#r-target").value,
      whatsapp: $("#r-whatsapp").value.trim(), email: $("#r-email").value.trim(),
    });
    setMsg("#r-msg", data.existed ? "Already on the roster." : "Added.", true);
    ["#r-name", "#r-beat", "#r-target", "#r-whatsapp", "#r-email"].forEach((s) => ($(s).value = ""));
    await loadDashboard(); $("#p-reporter").classList.add("on"); $('.act[data-panel="reporter"]').classList.add("on");
  } catch (e) { setMsg("#r-msg", e.message, false); }
  finally { btn.disabled = false; }
});

// Log a single entry
$("#e-save")?.addEventListener("click", async () => {
  const reporter_name = $("#e-reporter").value;
  if (!reporter_name) return setMsg("#e-msg", "Add a reporter first.", false);
  const btn = $("#e-save"); btn.disabled = true;
  try {
    await postJson("api/entries", {
      reporter_name, channel: $("#e-channel").value, item_type: $("#e-type").value.trim() || "post",
      entry_date: $("#e-date").value || today(), qty: $("#e-qty").value || 1,
      title: $("#e-title").value.trim(), url: $("#e-url").value.trim(),
    });
    setMsg("#e-msg", "Logged.", true);
    ["#e-title", "#e-url"].forEach((s) => ($(s).value = "")); $("#e-qty").value = 1;
    await loadDashboard(); $("#p-entry").classList.add("on"); $('.act[data-panel="entry"]').classList.add("on");
  } catch (e) { setMsg("#e-msg", e.message, false); }
  finally { btn.disabled = false; }
});

// Parse a daily report (preview, then save)
let PARSED = null;
$("#dr-parse")?.addEventListener("click", async () => {
  const text = $("#dr-text").value.trim();
  if (!text) return setMsg("#dr-msg", "Paste the message first.", false);
  const btn = $("#dr-parse"); btn.disabled = true; setMsg("#dr-msg", "Reading with AI…", true);
  try {
    const data = await postJson("api/daily-report", {
      text, reporterName: $("#dr-reporter").value || null, entryDate: $("#dr-date").value || null, save: false,
    });
    PARSED = data;
    const items = data.items || [];
    $("#dr-parsed-tb").innerHTML = items.length
      ? items.map((it) => `<tr><td><span class="pill">${CH_LABEL[it.channel] || it.channel}</span></td><td class="mono dim">${esc(it.item_type)}</td><td class="tt">${esc(it.title || "—")}</td><td class="r mono">${it.qty}</td></tr>`).join("")
      : `<tr><td colspan="4" class="dim">No published work found in that message.</td></tr>`;
    $("#dr-parsed").style.display = "block";
    $("#dr-save").style.display = items.length ? "inline-block" : "none";
    setMsg("#dr-msg", items.length ? `Found ${items.length} item(s) for ${esc(data.reporter || "this reporter")}.` : "Nothing to save.", true);
  } catch (e) { setMsg("#dr-msg", e.message, false); }
  finally { btn.disabled = false; }
});
$("#dr-save")?.addEventListener("click", async () => {
  const text = $("#dr-text").value.trim();
  if (!text) return;
  const btn = $("#dr-save"); btn.disabled = true;
  try {
    const data = await postJson("api/daily-report", {
      text, reporterName: $("#dr-reporter").value || null, entryDate: $("#dr-date").value || null, save: true,
    });
    setMsg("#dr-msg", `Saved ${data.added} entr${data.added === 1 ? "y" : "ies"}.`, true);
    $("#dr-text").value = ""; $("#dr-parsed").style.display = "none"; $("#dr-save").style.display = "none"; PARSED = null;
    await loadDashboard(); $("#p-report").classList.add("on"); $('.act[data-panel="report"]').classList.add("on");
  } catch (e) { setMsg("#dr-msg", e.message, false); }
  finally { btn.disabled = false; }
});

// Add performance numbers
$("#m-save")?.addEventListener("click", async () => {
  const reporter_name = $("#m-reporter").value;
  if (!reporter_name) return setMsg("#m-msg", "Add a reporter first.", false);
  const btn = $("#m-save"); btn.disabled = true;
  try {
    await postJson("api/metrics", {
      reporter_name, channel: $("#m-channel").value, post_title: $("#m-title").value.trim(), post_url: $("#m-url").value.trim(),
      reach: $("#m-reach").value, engagement: $("#m-eng").value, views: $("#m-views").value, measured_on: $("#m-date").value || today(),
    });
    setMsg("#m-msg", "Saved.", true);
    ["#m-title", "#m-url", "#m-reach", "#m-eng", "#m-views"].forEach((s) => ($(s).value = ""));
    await loadDashboard(); $("#p-metric").classList.add("on"); $('.act[data-panel="metric"]').classList.add("on");
  } catch (e) { setMsg("#m-msg", e.message, false); }
  finally { btn.disabled = false; }
});

// ── Tabs ──────────────────────────────────────────────────────────────────────
document.querySelector(".tabs")?.addEventListener("click", (e) => {
  const t = e.target.closest(".tab[data-v]"); if (!t) return;
  document.querySelectorAll(".tab[data-v]").forEach((x) => x.classList.remove("on"));
  document.querySelectorAll(".view").forEach((x) => x.classList.remove("on"));
  t.classList.add("on"); $("#v-" + t.dataset.v).classList.add("on");
});

// ── AI brief ────────────────────────────────────────────────────────────────
$("#gen")?.addEventListener("click", async function () {
  const btn = this, out = $("#ai-out");
  btn.disabled = true; btn.textContent = "Thinking…";
  out.className = ""; out.innerHTML = '<span class="spin"></span><span class="placeholder">Reading the week…</span>';
  try {
    const data = await fetch("api/brief", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then((r) => r.json());
    if (data.error) throw new Error(data.error);
    let html = (data.brief || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/^## (.+)$/gm, "<h3>$1</h3>").replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    const lines = html.split("\n"); let buf = "", inList = false;
    for (let ln of lines) {
      ln = ln.trim();
      if (ln.startsWith("- ")) { if (!inList) { buf += "<ul>"; inList = true; } buf += "<li>" + ln.slice(2) + "</li>"; continue; }
      if (inList) { buf += "</ul>"; inList = false; }
      if (ln.startsWith("<h3>")) buf += ln; else if (ln) buf += "<p>" + ln + "</p>";
    }
    if (inList) buf += "</ul>";
    out.innerHTML = buf; btn.textContent = "Regenerate";
  } catch (e) {
    out.innerHTML = `<p style="color:var(--alert)"><strong>Brief unavailable.</strong> ${esc(e.message)}.</p>`;
    btn.textContent = "Retry";
  }
  btn.disabled = false;
});

boot();

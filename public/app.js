// public/app.js — Progress Tracker dashboard.
// Relative paths only (fetch("api/…"), assets without a leading slash) so it
// works at / locally and under /nodes/progress/app/ when hosted.

const $ = (s) => document.querySelector(s);
const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(Math.round(n)));
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const today = () => new Date().toISOString().slice(0, 10);
const CHANNELS = ["facebook", "website", "tiktok", "whatsapp", "other"];
const CH_LABEL = { facebook: "FB", website: "Web", tiktok: "TikTok", whatsapp: "WA", other: "Other" };

let ALLP = null;          // the whole multi-period response from /api/report
let CURRENT = "week";     // the period the editor is looking at
let REPORT = null;        // ALLP.periods[CURRENT] — what every render reads
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
  ALLP = await fetch("api/report").then((r) => r.json()).catch(() => ({ empty: true, periods: {} }));
  // Honour the server's default period, but keep the editor's current choice if still valid.
  if (!ALLP.periods?.[CURRENT]) CURRENT = ALLP.defaultPeriod || "week";
  showDash();
  renderPeriods();
  renderCurrentPeriod();
  loadConnectors();
  loadInbound();
  // Reset brief
  $("#ai-out").className = "placeholder"; $("#ai-out").textContent = "No brief yet. Press “Generate brief”.";
  $("#gen").textContent = "Generate brief";
}

// The period switcher (Today / This week / This month / This year / All time).
function renderPeriods() {
  const el = $("#periods"); if (!el) return;
  const keys = ALLP.periodKeys || [{ key: "week", label: "This week" }];
  el.innerHTML = keys.map((p) =>
    `<button class="period${p.key === CURRENT ? " on" : ""}" data-period="${p.key}">${esc(p.label)}</button>`).join("");
}

function setPeriod(key) {
  if (!ALLP.periods?.[key]) return;
  CURRENT = key;
  renderPeriods();
  renderCurrentPeriod();
}

// Point REPORT at the chosen period and (re-)render everything that depends on it.
function renderCurrentPeriod() {
  REPORT = ALLP.periods?.[CURRENT] || { empty: true };
  populateReporterSelects();
  renderTopline();
  renderCards();
  renderFeed();
  renderPerf();
  renderTimeline();
}

document.querySelector("#periods")?.addEventListener("click", (e) => {
  const b = e.target.closest(".period[data-period]"); if (!b) return;
  setPeriod(b.dataset.period);
});

function renderTopline() {
  const t = REPORT.topline || {};
  const label = REPORT.periodLabel || "This week";
  const low = label.toLowerCase();
  $("#m-reporters").textContent = t.reporters ?? 0;
  $("#m-week").textContent = t.itemsThisPeriod ?? 0;
  $("#m-week-lbl").textContent = `items ${low}`;
  $("#meta-date").textContent = REPORT.today ? `today ${REPORT.today}` : "";
  const cells = [
    ["Reporters", t.reporters ?? 0, ""],
    [`Active ${low}`, t.activeThisPeriod ?? 0, ""],
    ["Items today", t.itemsToday ?? 0, ""],
    [`Items ${low}`, t.itemsThisPeriod ?? 0, ""],
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
  const low = (REPORT.periodLabel || "this week").toLowerCase();
  if (!rs.length) {
    $("#cards").innerHTML = `<div class="empty-hint"><h2>No reporters yet</h2><p>Press <b>+ Add reporter</b> to build your roster, then hit <b>Copy submit link</b> on each card and send it to them — they report their own day, and it lands here. (You can also log output yourself.)</p></div>`;
    return;
  }
  $("#cards").innerHTML = rs.map((r) => {
    const tgt = r.periodTarget != null
      ? `<span class="target ${r.targetStatus}">${r.periodItems}/${r.periodTarget} ${low}</span>`
      : "";
    const off = r.onRoster ? "" : `<span class="offroster">not on roster</span> `;
    const stale = r.lastActive ? "" : "stale";
    const perf = r.posts
      ? `<div class="perf">${r.posts} tracked posts · reach <b>${fmt(r.reach)}</b> · eng-rate <b>${r.engagementRate ?? "—"}%</b>${r.topPost ? ` · top: ${esc(r.topPost.title)}` : ""}</div>`
      : "";
    const link = r.submitToken
      ? `<div class="cardlink"><button class="linkbtn" data-token="${esc(r.submitToken)}">Copy submit link</button><span class="linkmsg dim"></span></div>`
      : "";
    return `<div class="card" data-reporter="${esc(r.name)}">
      <div class="top">
        <div><div class="nm">${off}${esc(r.name)}</div><div class="beat">${esc(r.beat || "—")}</div></div>
        ${tgt}
      </div>
      <div class="nums">
        <div class="b"><b>${r.periodItems}</b> ${low}</div>
        <div class="b"><b>${r.allItems}</b> all-time</div>
        <div class="b"><b class="${stale}">${r.lastActive || "never"}</b> last active</div>
      </div>
      ${chips(r.byChannel)}
      ${perf}
      <div class="drill" hidden></div>
      <div class="cardexpand dim">View ${low}'s output ▾</div>
      ${link}
    </div>`;
  }).join("");
}

// Render a reporter's per-period output (filtered from the period feed) into the drill-down.
function renderDrill(card, name) {
  const rows = (REPORT.feed || []).filter((e) => e.reporter_name === name);
  const box = card.querySelector(".drill");
  if (!box) return;
  box.innerHTML = rows.length
    ? `<table class="drilltbl"><thead><tr><th>Date</th><th>Channel</th><th>Type</th><th>Title</th><th class="r">Qty</th><th>Via</th></tr></thead><tbody>${
        rows.map((e) => `<tr>
          <td class="mono dim" style="white-space:nowrap">${esc(e.entry_date || "—")}</td>
          <td><span class="pill">${CH_LABEL[e.channel] || e.channel}</span></td>
          <td class="mono dim">${esc(e.item_type)}</td>
          <td class="tt">${e.url ? `<a class="lnk" href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title || e.url)}</a>` : esc(e.title || "—")}</td>
          <td class="r mono">${e.qty}</td>
          <td class="mono dim">${esc(e.source || "manual")}</td></tr>`).join("")
      }</tbody></table>`
    : `<div class="dim" style="padding:8px 0">No output in this period.</div>`;
}

// Card clicks: copy a submit link, or expand the per-reporter drill-down.
document.querySelector("#cards")?.addEventListener("click", (e) => {
  // 1) Copy the reporter's personal submit link (absolute URL, works locally + hosted).
  const b = e.target.closest(".linkbtn");
  if (b) {
    const url = new URL("submit.html?t=" + encodeURIComponent(b.dataset.token), location.href).href;
    const msg = b.parentElement.querySelector(".linkmsg");
    const done = (t) => { if (msg) { msg.textContent = t; setTimeout(() => (msg.textContent = ""), 2500); } };
    navigator.clipboard?.writeText(url).then(() => done("Copied — send it to them"), () => {
      window.prompt("Copy this submit link for the reporter:", url);
    });
    return;
  }
  // 2) Toggle the drill-down (anywhere else on the card, or the expand hint).
  if (e.target.closest(".linkmsg")) return;
  const card = e.target.closest(".card[data-reporter]"); if (!card) return;
  const drill = card.querySelector(".drill"); const hint = card.querySelector(".cardexpand");
  if (!drill) return;
  const opening = drill.hasAttribute("hidden");
  if (opening) { renderDrill(card, card.dataset.reporter); drill.removeAttribute("hidden"); if (hint) hint.textContent = "Hide output ▴"; }
  else { drill.setAttribute("hidden", ""); if (hint) hint.textContent = `View ${(REPORT.periodLabel || "this week").toLowerCase()}'s output ▾`; }
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function renderTimeline() {
  const tl = REPORT.timeline || { granularity: "day", bars: [] };
  const bars = tl.bars || [];
  const monthly = tl.granularity === "month";
  const max = Math.max(...bars.map((t) => t.items), 1);
  const label = (d) => monthly
    ? `${MONTHS[Number(d.slice(5, 7)) - 1] || ""} ${d.slice(0, 4)}`   // "YYYY-MM" → "Jun 2026"
    : d.slice(5);                                                     // "YYYY-MM-DD" → "MM-DD"
  $("#timeline-sub").textContent = monthly ? "By month, last 12 months" : `By day, last ${bars.length} days`;
  $("#timeline").innerHTML = bars.map((t) => `<div class="barrow">
    <div class="barlbl">${label(t.date)}</div>
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

// ── Performance connectors ────────────────────────────────────────────────────
function openPanel(id) {
  $("#p-" + id)?.classList.add("on");
  document.querySelector(`.act[data-panel="${id}"]`)?.classList.add("on");
}

async function loadConnectors() {
  const box = $("#connectors-body"); if (!box) return;
  const data = await fetch("api/connectors").then((r) => r.json()).catch(() => ({ connectors: [] }));
  renderConnectors(data.connectors || []);
}

function renderConnectors(list) {
  const box = $("#connectors-body"); if (!box) return;
  if (!list.length) { box.innerHTML = `<div class="dim">No connectors available yet.</div>`; return; }
  box.innerHTML = list.map((c) => {
    const fields = c.configFields.map((f) => `
      <div class="fld${f.type === "text" && f.key !== "apiVersion" ? " wide" : ""}">
        <label>${esc(f.label)}</label>
        <input data-conn="${esc(c.id)}" data-key="${esc(f.key)}" type="${f.type === "password" ? "password" : "text"}"
               autocomplete="off" placeholder="${esc(f.placeholder)}" value="${esc(f.value)}">
        ${f.hint ? `<span class="dim" style="font-size:12px">${esc(f.hint)}</span>` : ""}
      </div>`).join("");
    const ls = c.last_sync;
    const status = ls
      ? (ls.error
          ? `Last sync failed: <span style="color:var(--alert)">${esc(ls.error)}</span>`
          : `Last sync ${esc((ls.at || "").slice(0, 16).replace("T", " "))} — fetched ${ls.fetched ?? 0}, matched to reporters ${ls.matched ?? 0}, saved ${ls.written ?? 0}.`)
      : "Never synced.";
    const badge = c.configured
      ? `<span class="target met" style="font-size:11px">configured</span>`
      : `<span class="target under" style="font-size:11px">needs setup</span>`;
    return `<div class="conn" style="border:1px solid var(--line);border-radius:8px;padding:16px 18px;margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap">
        <div><b>${esc(c.label)}</b> <span class="pill">${esc(c.channel)}</span> ${badge}</div>
        ${c.docsUrl ? `<a class="lnk" href="${esc(c.docsUrl)}" target="_blank" rel="noopener" style="font-size:12.5px">setup guide ↗</a>` : ""}
      </div>
      <div class="dim" style="font-size:13px;margin:6px 0 14px;max-width:720px">${esc(c.description)}</div>
      <div class="form-grid">${fields}</div>
      <div class="form-actions">
        <button class="btn ghost conn-save" data-conn="${esc(c.id)}">Save settings</button>
        <button class="btn conn-sync" data-conn="${esc(c.id)}"${c.configured ? "" : " disabled"}>Sync now</button>
        <span class="form-msg conn-msg" data-conn="${esc(c.id)}"></span>
      </div>
      <div class="dim" style="font-size:12.5px;margin-top:12px;padding-top:12px;border-top:1px solid var(--line)">${status}</div>
    </div>`;
  }).join("");
}

function connMsg(id, text, ok) {
  const el = document.querySelector(`.conn-msg[data-conn="${id}"]`);
  if (el) { el.textContent = text; el.className = "form-msg conn-msg " + (ok ? "ok" : "bad"); }
}

document.querySelector("#connectors-body")?.addEventListener("click", async (e) => {
  const save = e.target.closest(".conn-save");
  const sync = e.target.closest(".conn-sync");
  if (save) {
    const id = save.dataset.conn;
    const config = {};
    document.querySelectorAll(`#connectors-body input[data-conn="${id}"]`).forEach((i) => { config[i.dataset.key] = i.value.trim(); });
    save.disabled = true;
    try { await postJson(`api/connectors/${id}/config`, { config }); connMsg(id, "Settings saved.", true); await loadConnectors(); openPanel("connectors"); }
    catch (err) { connMsg(id, err.message, false); }
    finally { save.disabled = false; }
  }
  if (sync) {
    const id = sync.dataset.conn;
    sync.disabled = true; const t = sync.textContent; sync.textContent = "Syncing…";
    try {
      const d = await postJson(`api/connectors/${id}/sync`, {});
      const ls = d.last_sync || {};
      connMsg(id, `Fetched ${ls.fetched ?? 0}, matched ${ls.matched ?? 0}, saved ${ls.written ?? 0}.`, true);
      await loadDashboard(); openPanel("connectors");
    } catch (err) { connMsg(id, err.message, false); }
    finally { sync.disabled = false; sync.textContent = t; }
  }
});

// ── Email intake (reporters self-report by email) ─────────────────────────────
async function loadInbound() {
  const box = $("#inbound-body"); if (!box) return;
  const d = await fetch("api/inbound").then((r) => r.json()).catch(() => null);
  renderInbound(d);
}

function renderInbound(d) {
  const box = $("#inbound-body"); if (!box) return;
  if (!d || d.ok === false) { box.innerHTML = `<div class="dim">Couldn’t load email-intake settings.</div>`; return; }
  const reporters = d.reporters || [];
  const withEmail = reporters.filter((r) => r.email);
  const without = reporters.filter((r) => !r.email);

  const addressBlock = d.enabled && d.address
    ? `<div class="fld wide"><label>Your newsroom’s reporting address</label>
         <div class="copyrow"><code class="addr" id="inbound-addr">${esc(d.address)}</code>
           <button class="btn ghost" id="inbound-copy">Copy</button><span class="form-msg" id="inbound-copymsg"></span></div>
         <span class="dim" style="font-size:12.5px">Reporters email their day to this address. We match the sender to a reporter by their email and parse the message into entries automatically.</span>
       </div>`
    : `<div class="notice">Email intake isn’t switched on for this server yet. To enable it, set <code>INBOUND_EMAIL_SECRET</code> (and <code>INBOUND_EMAIL_DOMAIN</code>) in the server’s environment and point a mail route at <code>POST /inbound/email</code>. Your newsroom token is <code>${esc(d.token || "")}</code> — the address will be <code>reports+&lt;token&gt;@&lt;your-domain&gt;</code>.</div>`;

  const coverage = reporters.length
    ? `<div class="fld wide"><label>Reporter email coverage</label>
         <div class="dim" style="font-size:13px">${withEmail.length} of ${reporters.length} reporters have an email set${without.length ? ` — these won’t be matched until you add one: <b>${without.map((r) => esc(r.name)).join(", ")}</b>` : " ✓"}.</div>
         <span class="dim" style="font-size:12px">Add or change a reporter’s email with <b>+ Add reporter</b> (re-adding the same name is fine).</span>
       </div>`
    : `<div class="dim">Add reporters (with their email) first — that’s how inbound mail is matched to a person.</div>`;

  box.innerHTML = `<div class="form-grid">${addressBlock}${coverage}</div>`;
}

document.querySelector("#inbound-body")?.addEventListener("click", (e) => {
  if (!e.target.closest("#inbound-copy")) return;
  const addr = $("#inbound-addr")?.textContent || "";
  const msg = $("#inbound-copymsg");
  const done = (t) => { if (msg) { msg.textContent = t; msg.className = "form-msg ok"; setTimeout(() => (msg.textContent = ""), 2500); } };
  navigator.clipboard?.writeText(addr).then(() => done("Copied."), () => window.prompt("Copy this address:", addr));
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

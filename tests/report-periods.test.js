/**
 * tests/report-periods.test.js — the period-aware dashboard aggregation.
 * Pure function, fixed `now`, so the windows are deterministic.
 *
 *   node --test tests/report-periods.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAllPeriods, buildDashboard, PERIODS } from "../lib/report.js";

// Anchor "now" to a known Wednesday well into the month, so the week window
// (from Mon 15 Jun) and the month window (from 1 Jun) are genuinely different.
const NOW = new Date("2026-06-17T12:00:00Z"); // Wed 17 Jun 2026 → week starts Mon 15 Jun (3 days in)

const reporters = [
  { name: "Thandi Banda", reporter_key: "thandi banda", daily_target: 2, beat: "Politics", email: "thandi@news.co" },
  { name: "Sipho Dube", reporter_key: "sipho dube", beat: "Sport" },
];
const entries = [
  { reporter_name: "Thandi Banda", reporter_key: "thandi banda", entry_date: "2026-06-17", channel: "facebook", qty: 1, title: "today A", source: "email" },
  { reporter_name: "Thandi Banda", reporter_key: "thandi banda", entry_date: "2026-06-17", channel: "website", qty: 1, title: "today B" },
  { reporter_name: "Thandi Banda", reporter_key: "thandi banda", entry_date: "2026-06-15", channel: "tiktok", qty: 1, title: "mon (this week)" },
  { reporter_name: "Sipho Dube", reporter_key: "sipho dube", entry_date: "2026-06-05", channel: "facebook", qty: 3, title: "early jun (this month, not week)" },
  { reporter_name: "Sipho Dube", reporter_key: "sipho dube", entry_date: "2026-01-10", channel: "website", qty: 1, title: "jan (this year, not month)" },
  { reporter_name: "Sipho Dube", reporter_key: "sipho dube", entry_date: "2025-12-31", channel: "website", qty: 1, title: "last year (all-time only)" },
];

test("buildAllPeriods: returns one dashboard per PERIODS key", () => {
  const r = buildAllPeriods({ reporters, entries }, NOW, "local");
  assert.deepEqual(Object.keys(r.periods).sort(), PERIODS.map((p) => p.key).sort());
  assert.equal(r.defaultPeriod, "week");
  assert.equal(r.empty, false);
});

test("period windows scope item counts correctly", () => {
  const r = buildAllPeriods({ reporters, entries }, NOW, "local");
  const items = (k) => r.periods[k].topline.itemsThisPeriod;
  assert.equal(items("today"), 2);            // two entries dated 2026-06-03
  assert.equal(items("week"), 3);             // + the Mon 2026-06-01 tiktok
  assert.equal(items("month"), 6);            // + Sipho's 3 on 2026-05-20
  assert.equal(items("year"), 7);             // + Sipho's 1 on 2026-01-10
  assert.equal(items("all"), 8);              // + the 2025-12-31 entry
});

test("itemsToday is the same regardless of selected period", () => {
  const r = buildAllPeriods({ reporters, entries }, NOW, "local");
  for (const p of PERIODS) assert.equal(r.periods[p.key].topline.itemsToday, 2);
});

test("daily target scales into a period target; today uses the raw daily target", () => {
  const r = buildAllPeriods({ reporters, entries }, NOW, "local");
  const thandiToday = r.periods.today.reporters.find((x) => x.name === "Thandi Banda");
  assert.equal(thandiToday.periodTarget, 2);                 // raw daily target
  assert.equal(thandiToday.targetStatus, "met");             // 2 today >= 2

  const thandiWeek = r.periods.week.reporters.find((x) => x.name === "Thandi Banda");
  // Wed = day 3 of the week → target 2 * 3 = 6; she has 3 → under.
  assert.equal(thandiWeek.periodTarget, 6);
  assert.equal(thandiWeek.targetStatus, "under");

  // All-time has no target.
  const thandiAll = r.periods.all.reporters.find((x) => x.name === "Thandi Banda");
  assert.equal(thandiAll.periodTarget, null);
  assert.equal(thandiAll.targetStatus, "none");
});

test("timeline granularity switches to monthly for year / all", () => {
  const r = buildAllPeriods({ reporters, entries }, NOW, "local");
  assert.equal(r.periods.week.timeline.granularity, "day");
  assert.equal(r.periods.month.timeline.granularity, "day");
  assert.equal(r.periods.month.timeline.bars.length, 30);
  assert.equal(r.periods.year.timeline.granularity, "month");
  assert.equal(r.periods.year.timeline.bars.length, 12);
});

test("feed is period-scoped and carries the source (for the drill-down)", () => {
  const r = buildAllPeriods({ reporters, entries }, NOW, "local");
  const todayFeed = r.periods.today.feed;
  assert.equal(todayFeed.length, 2);
  assert.ok(todayFeed.some((e) => e.source === "email"));
  // The week feed includes Monday's tiktok but not May's entry.
  assert.equal(r.periods.week.feed.length, 3);
});

test("buildDashboard defaults to the week period (keeps postBrief working)", () => {
  const d = buildDashboard({ reporters, entries }, NOW, "local");
  assert.equal(d.period, "week");
  assert.equal(d.topline.itemsThisPeriod, 3);
});

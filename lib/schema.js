/**
 * lib/schema.js — Progress Tracker's own Postgres tables (hosted mode).
 *
 * Passed to createHostedServer({ ensureSchema }). The generic activity log
 * (node_progress_tracker_activity) + key/value store are created by the runtime;
 * these are this Node's data tables. They mirror the rows the handlers write.
 *
 * Design note — these tables are intentionally FLAT and denormalised
 * (reporter_name lives on entries and metrics, not just an FK). That's because
 * the same handler code runs on a laptop against the runtime's tiny JSON "SQL"
 * engine, which only understands `WHERE newsroom_id = $1 [AND source_label = $2]`
 * — no JOINs, no GROUP BY reporter. So every read is a simple per-newsroom
 * SELECT and ALL aggregation happens in JS (see lib/report.js). Keep it that way.
 *
 * `id` is left to bigserial; the timestamp column is `ingested_at` so it lines up
 * with the field the lite host stamps onto every inserted row.
 */
export async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS node_progress_tracker_reporters (
      id            bigserial PRIMARY KEY,
      newsroom_id   text NOT NULL,
      reporter_key  text NOT NULL,
      name          text NOT NULL,
      email         text,
      whatsapp      text,
      beat          text,
      daily_target  integer,
      active        boolean DEFAULT true,
      ingested_at   timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS node_progress_tracker_reporters_nr
      ON node_progress_tracker_reporters (newsroom_id, reporter_key);

    CREATE TABLE IF NOT EXISTS node_progress_tracker_entries (
      id            bigserial PRIMARY KEY,
      newsroom_id   text NOT NULL,
      reporter_key  text,
      reporter_name text,
      entry_date    text,          -- YYYY-MM-DD
      channel       text,          -- facebook | website | tiktok | whatsapp | other
      item_type     text,          -- story | post | video | update | …
      title         text,
      url           text,
      qty           integer DEFAULT 1,
      notes         text,
      source        text,          -- manual | paste | whatsapp | email
      raw_text      text,
      ingested_at   timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS node_progress_tracker_entries_nr
      ON node_progress_tracker_entries (newsroom_id, reporter_key);

    CREATE TABLE IF NOT EXISTS node_progress_tracker_metrics (
      id            bigserial PRIMARY KEY,
      newsroom_id   text NOT NULL,
      reporter_name text,
      channel       text,
      post_url      text,
      post_title    text,
      reach         integer,
      engagement    integer,
      likes         integer,
      comments      integer,
      shares        integer,
      views         integer,
      measured_on   text,          -- YYYY-MM-DD
      source        text,          -- manual (later: a connector name)
      ingested_at   timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS node_progress_tracker_metrics_nr
      ON node_progress_tracker_metrics (newsroom_id);
  `);
}

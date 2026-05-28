/**
 * lib/parse-report.js — read a reporter's free-text end-of-day report and
 * structure it into entries, using host.ai.
 *
 * This is the bridge for "reporters WhatsApp / email their stats at the end of
 * each day": the manager (or, later, an inbound WhatsApp/email webhook) drops the
 * raw message in, and the AI turns prose like
 *
 *   "Today I put up 2 Facebook posts on the budget protest, filed one website
 *    story (link below) and a TikTok explainer."
 *
 * into a list of {channel, item_type, title, url, qty}. host.ai is the user's own
 * key on a laptop and the server's key online — same call either way.
 */

const CHANNELS = ["facebook", "website", "tiktok", "whatsapp", "other"];

/** Pull the first JSON object/array out of a model reply (handles ``` fences + prose). */
function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.search(/[\[{]/);
  if (start === -1) return null;
  // Walk to the matching close so trailing prose can't break the parse.
  const open = t[start], close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) { end = i; break; } }
  }
  const slice = end === -1 ? t.slice(start) : t.slice(start, end + 1);
  try { return JSON.parse(slice); } catch { return null; }
}

const PROMPT = (text, reporterHint, dateHint) =>
`You are reading a journalist's end-of-day work report from a newsroom and turning it into structured data for an editor's accountability dashboard.

Extract EVERY distinct piece of content the journalist says they published or produced. For each, identify:
- "channel": one of ${CHANNELS.join(", ")} (facebook = Facebook post; website = a story/article on the news site; tiktok = TikTok video; whatsapp = WhatsApp channel/broadcast update; other = anything else).
- "item_type": a short word like story, post, video, reel, update, photo, thread.
- "title": a short description or headline if given (else null).
- "url": a link if one is present (else null).
- "qty": how many of this exact item (default 1; if they say "3 Facebook posts" use 3 with one entry).

Also return "reporter" (the person's name if the report names them, else null) and "date" (YYYY-MM-DD if a date is stated, else null).
${reporterHint ? `The report is from reporter: "${reporterHint}".` : ""}
${dateHint ? `Assume the date is ${dateHint} unless the text says otherwise.` : ""}

Return ONLY JSON, no prose:
{"reporter": string|null, "date": "YYYY-MM-DD"|null, "items": [{"channel": string, "item_type": string, "title": string|null, "url": string|null, "qty": number}]}

If the message describes no published work, return {"reporter": null, "date": null, "items": []}.

REPORT:
"""
${String(text).slice(0, 6000)}
"""`;

export async function parseDailyReport(host, { text, reporterName, entryDate } = {}) {
  const body = String(text || "").trim();
  if (!body) return { ok: false, error: "empty", message: "Paste the reporter's message first." };

  const { text: reply, provider, model } = await host.ai.chat(
    PROMPT(body, reporterName, entryDate),
    { maxTokens: 1200 }
  );
  const parsed = extractJson(reply);
  if (!parsed || !Array.isArray(parsed.items)) {
    return { ok: false, error: "unparseable", message: "Couldn't read that report — try rephrasing or log the items by hand.", provider, model };
  }

  const items = parsed.items
    .filter((it) => it && (it.title || it.url || it.channel))
    .map((it) => ({
      channel: it.channel,
      item_type: it.item_type || "post",
      title: it.title || null,
      url: it.url || null,
      qty: Number.isFinite(parseInt(it.qty, 10)) ? parseInt(it.qty, 10) : 1,
    }));

  return {
    ok: true,
    reporter: reporterName || parsed.reporter || null,
    date: entryDate || parsed.date || null,
    items,
    provider, model,
  };
}

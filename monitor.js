/**
 * MSBTE Summer 2026 Result Monitor — Table-diff edition
 *
 * How it works
 * ────────────
 * 1. Fetch all configured MSBTE pages.
 * 2. Scrape every result entry (tables, lists, links) into structured rows.
 * 3. Load the entries-snapshot.json written by the previous run.
 * 4. Diff: find entries that are (a) new and (b) match Summer 2026 patterns.
 * 5. Send one email listing every new entry.
 * 6. Only mark those entries as "seen" in the snapshot AFTER the email succeeds,
 *    so a transient mail failure automatically retries on the next run.
 *
 * Snapshot layout
 * ───────────────
 * {
 *   "lastRun": "<ISO timestamp>",
 *   "seenIds": ["<sha1-16>", ...],          ← every entry ever seen (never emailed twice)
 *   "latestSummer2026": [{ id, title, href }] ← last-seen S26 rows (debug aid)
 * }
 */

"use strict";
require("dotenv").config();
const axios        = require("axios");
const cheerio      = require("cheerio");
const { Resend }   = require("resend");
const fs           = require("fs");
const path         = require("path");
const crypto       = require("crypto");

// ─── Configuration ────────────────────────────────────────────────────────────

const CONFIG = {
  targetUrl: "https://result.msbte.ac.in/",

  extraUrls: [
    "https://msbte.org.in/",
    "https://msbte.org.in/notices",
    "https://msbte.org.in/results",
  ],

  // Case-insensitive regex patterns — tested against each entry's title + href.
  // Covers "Summer 2026", "Summer-2026", "S-2026", "S2026", "Sum 26", etc.
  summer2026Patterns: [
    /summer[\s\-_]?2026/i,
    /\bs[\s\-]?2026\b/i,
    /\b2026\b.*\bsummer\b/i,
    /\bsum[\s\-]?26\b/i,
  ],

  snapshotFile: path.join(process.cwd(), "entries-snapshot.json"),
  isDryRun:     process.argv.includes("--dry-run"),
  timeoutMs:    30_000,
};

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(level, message, data) {
  const icons = { INFO: "ℹ️ ", SUCCESS: "✅", WARN: "⚠️ ", ERROR: "❌" };
  console.log(`[${new Date().toISOString()}] ${icons[level] ?? "📋"} ${message}`);
  if (data !== undefined) console.log(JSON.stringify(data, null, 2));
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

async function fetchPage(url) {
  try {
    log("INFO", `Fetching ${url}`);
    const res = await axios.get(url, {
      timeout: CONFIG.timeoutMs,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/124.0.0.0 Safari/537.36",
        "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-IN,en;q=0.9,hi;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control":   "no-cache",
      },
      maxRedirects: 8,
    });
    log("INFO", `  → HTTP ${res.status}, ${String(res.data).length} bytes`);
    return res.data;
  } catch (err) {
    log("WARN", `  → Failed (${err.response?.status ?? "network-error"}): ${err.message}`);
    return null;
  }
}

// ─── Scraping ─────────────────────────────────────────────────────────────────

/**
 * Stable, deterministic entry ID derived from normalised title + href.
 * Same row on two different runs always gets the same ID → reliable diffing.
 */
function makeEntryId(title, href) {
  const raw = `${title.trim().toLowerCase()}|${(href || "").trim().toLowerCase()}`;
  return crypto.createHash("sha1").update(raw).digest("hex").slice(0, 16);
}

/**
 * Resolve a potentially relative href against the page's base URL.
 */
function resolveHref(href, base) {
  if (!href) return base;
  try {
    return new URL(href, base).href;
  } catch {
    return base;
  }
}

/**
 * Extract every plausible result entry from a page.
 *
 * Covers the full range of MSBTE page layouts:
 *   • <table> rows (most common — Sr.No | Exam Name | Link)
 *   • <ul>/<ol> notice lists
 *   • Standalone <a> tags in result/notice panels
 *
 * Returns: Array<{ id, title, href, sourceUrl }>
 */
function scrapeEntries(html, sourceUrl) {
  if (!html) return [];

  const $       = cheerio.load(html);
  const entries = [];
  const seen    = new Set();

  function add(titleRaw, rawHref) {
    const title = titleRaw.replace(/\s+/g, " ").trim();
    if (!title || title.length < 4) return;

    const href = resolveHref(rawHref, sourceUrl);
    const id   = makeEntryId(title, href);
    if (seen.has(id)) return;
    seen.add(id);
    entries.push({ id, title, href, sourceUrl });
  }

  // Strategy 1 — <table> rows: join all cell text, attach row's first link
  $("table tr").each((_, row) => {
    const $row    = $(row);
    const rowText = $row.find("td, th")
      .map((_, td) => $(td).text().trim())
      .get()
      .filter(Boolean)
      .join(" | ");
    const href = $row.find("a[href]").first().attr("href") || "";
    add(rowText, href);
  });

  // Strategy 2 — <li> items (notice lists, announcement boards)
  $("li").each((_, el) => {
    const $el  = $(el);
    const text = $el.text();
    const href = $el.find("a[href]").first().attr("href") || "";
    add(text, href);
  });

  // Strategy 3 — every <a> with meaningful text (catches standalone notice links)
  $("a[href]").each((_, el) => {
    const $el = $(el);
    add($el.text(), $el.attr("href") || "");
  });

  log("INFO", `  → ${entries.length} candidate entries from ${sourceUrl}`);
  return entries;
}

// ─── Summer 2026 filter ───────────────────────────────────────────────────────

function isSummer2026(entry) {
  return CONFIG.summer2026Patterns.some(
    (rx) => rx.test(entry.title) || rx.test(entry.href)
  );
}

// ─── Snapshot ─────────────────────────────────────────────────────────────────

function loadSnapshot() {
  try {
    if (!fs.existsSync(CONFIG.snapshotFile)) {
      log("INFO", "No snapshot found — treating this as the first run.");
      return { seenIds: [], latestSummer2026: [] };
    }
    const snap = JSON.parse(fs.readFileSync(CONFIG.snapshotFile, "utf8"));
    log("INFO", `Snapshot loaded — ${snap.seenIds.length} known IDs, last run: ${snap.lastRun}`);
    return snap;
  } catch (err) {
    log("WARN", `Snapshot unreadable (${err.message}) — starting fresh.`);
    return { seenIds: [], latestSummer2026: [] };
  }
}

/**
 * Write the snapshot to disk.
 *
 * Two-phase save strategy (called once each):
 *   Phase A — "base" snapshot: marks all non-Summer-2026 entries as seen.
 *             Written BEFORE the email attempt so background page changes
 *             are never re-alerted even if the email fails.
 *   Phase B — "full" snapshot: also marks the newly-notified Summer-2026
 *             entries as seen. Written ONLY AFTER the email succeeds,
 *             so a transient Resend failure causes an automatic retry
 *             on the next run rather than silently swallowing the alert.
 */
function saveSnapshot(seenIds, latestSummer2026) {
  const snap = {
    lastRun:          new Date().toISOString(),
    seenIds:          [...seenIds],
    latestSummer2026: latestSummer2026.map(({ id, title, href }) => ({ id, title, href })),
  };
  fs.writeFileSync(CONFIG.snapshotFile, JSON.stringify(snap, null, 2), "utf8");
  log("INFO", `Snapshot saved — ${snap.seenIds.length} known IDs`);
}

// ─── Email ────────────────────────────────────────────────────────────────────

function buildEmailHtml(newEntries) {
  const now = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

  const tableRows = newEntries.map((e) => `
    <tr>
      <td style="padding:11px 14px;border-bottom:1px solid #e2e8f0;
                 font-size:13px;color:#1e293b;line-height:1.45;">
        <a href="${e.href}" style="color:#2563eb;text-decoration:none;font-weight:600;">
          ${e.title.replace(/</g, "&lt;")}
        </a>
      </td>
      <td style="padding:11px 14px;border-bottom:1px solid #e2e8f0;
                 font-size:12px;color:#64748b;white-space:nowrap;vertical-align:top;">
        ${new URL(e.sourceUrl).hostname}
      </td>
    </tr>`).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>MSBTE Summer 2026 Results Alert</title>
</head>
<body style="font-family:'Segoe UI',Tahoma,Arial,sans-serif;background:#f1f5f9;
             margin:0;padding:28px 16px;">

  <div style="background:#fff;border-radius:14px;max-width:620px;margin:0 auto;
              box-shadow:0 4px 28px rgba(0,0,0,0.09);overflow:hidden;">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#1e3a5f 0%,#2563eb 100%);
                padding:40px 32px;text-align:center;">
      <div style="font-size:44px;margin-bottom:12px;">🎓</div>
      <h1 style="color:#fff;font-size:23px;margin:0 0 8px;
                 font-weight:700;letter-spacing:-0.3px;">
        MSBTE Summer 2026 Results Are Live!
      </h1>
      <p style="color:#bfdbfe;margin:0;font-size:13px;">
        Automated Result Monitor &nbsp;·&nbsp; ${now} IST
      </p>
    </div>

    <!-- Alert banner -->
    <div style="background:#ecfdf5;border-left:5px solid #10b981;
                margin:26px 28px 0;border-radius:8px;padding:14px 18px;">
      <p style="margin:0;color:#065f46;font-size:14px;font-weight:600;">
        ✅&nbsp; ${newEntries.length} new Summer&nbsp;2026 result
        ${newEntries.length === 1 ? "entry" : "entries"} detected —
        not present in the previous check.
      </p>
    </div>

    <!-- Entries table -->
    <div style="padding:22px 28px 8px;">
      <p style="color:#475569;font-size:14px;margin:0 0 14px;">
        The following new entries appeared in the MSBTE results table:
      </p>
      <table style="width:100%;border-collapse:collapse;
                    border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
        <thead>
          <tr style="background:#f8fafc;">
            <th style="padding:10px 14px;text-align:left;font-size:11px;
                       color:#64748b;font-weight:700;text-transform:uppercase;
                       letter-spacing:0.5px;border-bottom:2px solid #e2e8f0;">
              Result Entry
            </th>
            <th style="padding:10px 14px;text-align:left;font-size:11px;
                       color:#64748b;font-weight:700;text-transform:uppercase;
                       letter-spacing:0.5px;border-bottom:2px solid #e2e8f0;
                       white-space:nowrap;">
              Source
            </th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>

    <!-- CTA -->
    <div style="text-align:center;padding:26px 28px 28px;">
      <a href="https://result.msbte.ac.in/"
         style="display:inline-block;background:#2563eb;color:#fff;
                text-decoration:none;padding:14px 38px;border-radius:8px;
                font-weight:700;font-size:15px;letter-spacing:0.3px;
                box-shadow:0 4px 14px rgba(37,99,235,0.32);">
        Check My Result &rarr;
      </a>
      <p style="color:#94a3b8;font-size:12px;margin:14px 0 0;">
        Link not working? Visit
        <a href="https://result.msbte.ac.in/" style="color:#2563eb;">
          result.msbte.ac.in
        </a> directly.
      </p>
    </div>

    <!-- Footer -->
    <div style="border-top:1px solid #f1f5f9;padding:16px 28px;text-align:center;">
      <p style="color:#94a3b8;font-size:11px;margin:0;line-height:1.6;">
        You will be notified again only if additional new result entries appear.<br/>
        This email was generated automatically by your MSBTE Result Monitor.
      </p>
    </div>

  </div>
</body>
</html>`;
}

async function sendNotification(newEntries) {
  const apiKey    = process.env.RESEND_API_KEY;
  const emailTo   = process.env.EMAIL_TO;
  const emailFrom = process.env.EMAIL_FROM;

  if (!apiKey || !emailTo || !emailFrom) {
    throw new Error(
      "Missing required env vars: RESEND_API_KEY, EMAIL_TO, EMAIL_FROM"
    );
  }

  const count   = newEntries.length;
  const subject =
    `🎓 MSBTE Summer 2026 — ${count} new result ` +
    `${count === 1 ? "entry" : "entries"} detected!`;

  log("INFO", `Sending email to ${emailTo} — subject: "${subject}"`);

  if (CONFIG.isDryRun) {
    log("SUCCESS", "[DRY RUN] Email skipped. Entries that would have been sent:");
    newEntries.forEach((e, i) => log("INFO", `  ${i + 1}. ${e.title}`));
    return;
  }

  const resend = new Resend(apiKey);
  const { data, error } = await resend.emails.send({
    from:    emailFrom,
    to:      [emailTo],
    subject,
    html:    buildEmailHtml(newEntries),
  });

  if (error) throw new Error(`Resend API error: ${JSON.stringify(error)}`);
  log("SUCCESS", `Email sent — Resend message ID: ${data.id}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log("INFO", "=== MSBTE Result Monitor starting (table-diff mode) ===");
  log("INFO", `Mode: ${CONFIG.isDryRun ? "dry-run (no email, no snapshot write)" : "live"}`);

  // ── 1. Load snapshot ───────────────────────────────────────────────────────
  const snapshot = loadSnapshot();
  const knownIds = new Set(snapshot.seenIds ?? []);

  // ── 2. Scrape all pages ────────────────────────────────────────────────────
  const allEntries = [];
  for (const url of [CONFIG.targetUrl, ...CONFIG.extraUrls]) {
    const html = await fetchPage(url);
    allEntries.push(...scrapeEntries(html, url));
  }
  log("INFO", `Total entries scraped across all pages: ${allEntries.length}`);

  // ── 3. Identify Summer 2026 entries ────────────────────────────────────────
  const summer2026All = allEntries.filter(isSummer2026);
  log("INFO", `Summer 2026 entries found this run: ${summer2026All.length}`);
  summer2026All.forEach((e) => log("INFO", `  [S26] ${e.title.slice(0, 90)}`));

  // ── 4. Diff against snapshot ───────────────────────────────────────────────
  const newEntries = summer2026All.filter((e) => !knownIds.has(e.id));
  log("INFO", `New (previously unseen) Summer 2026 entries: ${newEntries.length}`);

  // ── 5. Phase-A snapshot save ───────────────────────────────────────────────
  // Mark all NON-Summer-2026 entries as seen right now.
  // Summer 2026 IDs are only added after a successful email (Phase B),
  // so a transient mail failure triggers a retry on the next run.
  const nonSummer2026Ids = allEntries
    .filter((e) => !summer2026All.find((s) => s.id === e.id))
    .map((e) => e.id);

  const phaseASeenIds = new Set([...knownIds, ...nonSummer2026Ids]);

  if (!CONFIG.isDryRun) {
    saveSnapshot(phaseASeenIds, summer2026All);
    log("INFO", "Phase-A snapshot saved (non-S26 entries marked seen).");
  }

  // ── 6. Nothing new → done ─────────────────────────────────────────────────
  if (newEntries.length === 0) {
    log("INFO", "No new Summer 2026 entries. Will check again next run.");
    process.exit(0);
  }

  // ── 7. Send email ──────────────────────────────────────────────────────────
  try {
    await sendNotification(newEntries);
  } catch (err) {
    log("ERROR", `Email failed: ${err.message}`);
    log("WARN",  "Phase-B snapshot NOT saved — next run will retry the email.");
    process.exit(1); // GHA marks run as failed; phase-A snapshot already on disk
  }

  // ── 8. Phase-B snapshot save (email confirmed sent) ───────────────────────
  const phaseBSeenIds = new Set([...phaseASeenIds, ...newEntries.map((e) => e.id)]);

  if (!CONFIG.isDryRun) {
    saveSnapshot(phaseBSeenIds, summer2026All);
    log("INFO", "Phase-B snapshot saved (S26 entries now marked seen — no duplicate emails).");
  }

  log("SUCCESS", "=== Monitor finished successfully ===");
  process.exit(0);
}

main();

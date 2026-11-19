// HAIC H3d (docs/design/HAIC-H3.md §6.1, §11 step 4; owner 2026-11-19, "Setuju semua rekomendasi"): the teaching record,
// the owner-judgement side of reputation. Pure and deterministic: rows of the corrections ledger in, one record per
// subject (agent, model or seat) and window (7 and 30 days) out. No storage, no network, no clock but `now`.
//
//   up_w   = Σ weight over the newest row per (actor, target) with rating up (a rating-less good_call counts as up)
//   down_w = Σ weight over the same, with rating down, plus owner_correction rows without a rating
//   score  = (up_w + P/2) / (up_w + down_w + P), P = 10 (REPUTATION_PRIOR in xauusd src/reputation.mjs:20)
//   n      = the rows counted in the score; by_category = counts; last_at = the newest row's time
//
// - Shrunk toward 0.5, so a few judgements cannot floor or max a subject: one weight-3 down on a new subject is 5/13.
// - Newest per target: an actor's newest row on a target (by created_at; on a tie the later row given) is the only one
//   of theirs that counts there, and it counts in a window when its own time is in that window. Up, down, up is one up.
// - A window with nothing counted has score null (shown "—"), never 0.5: the Console truthfulness rule.
// - Context only. It gates nothing: no consensus vote, no council seat, no autonomy-dial level, no Policy Engine check.

import type { CorrectionCategory, CorrectionLabel } from "./correction.ts";

/** The prior's weight (P): REPUTATION_PRIOR of the xauusd outcome reputation (src/reputation.mjs:20). */
export const TEACHING_PRIOR = 10;
export const TEACHING_WINDOWS = [{ id: "7d", days: 7 }, { id: "30d", days: 30 }] as const;
export type TeachingWindowId = (typeof TEACHING_WINDOWS)[number]["id"];
const DAY_MS = 86_400_000;

/** The ledger columns a teaching record reads (the corrections table, migration 0084). Never the text. */
export interface TeachingRow {
  actor: string;
  target_ref: string;
  subject: string;
  label: CorrectionLabel | string;
  rating: "up" | "down" | null;
  category: CorrectionCategory | string | null;
  weight: number;
  created_at: string;
}
export interface TeachingWindow {
  up_w: number;
  down_w: number;
  /** Null when nothing was counted: the Console shows "—". */
  score: number | null;
  n: number;
  by_category: Record<string, number>;
  last_at: string | null;
}
export interface TeachingRecord { subject: string; windows: Record<TeachingWindowId, TeachingWindow> }

/** Which side of the score a row counts on, or null when it counts on neither (an owner_decision reason, for one). */
export function teachingSide(row: Pick<TeachingRow, "label" | "rating" | "category">): "up" | "down" | null {
  if (row.rating === "up") return "up";
  if (row.rating === "down") return "down";
  if (row.category === "good_call") return "up";
  if (row.label === "owner_correction") return "down";
  return null;
}

/** The shrunk score: (up_w + P/2) / (up_w + down_w + P), at four decimals. */
export function teachingScore(upW: number, downW: number, prior = TEACHING_PRIOR): number {
  return Math.round(((upW + prior / 2) / (upW + downW + prior)) * 10_000) / 10_000;
}

/** Each actor's newest row per target at or before `now`. On the same time, the later row in `rows` wins. */
export function newestPerTarget<T extends Pick<TeachingRow, "actor" | "target_ref" | "created_at">>(rows: readonly T[], now: number): T[] {
  const newest = new Map<string, T>();
  for (const r of rows) {
    const t = Date.parse(r.created_at);
    if (!Number.isFinite(t) || t > now) continue;
    const key = JSON.stringify([r.actor, r.target_ref]);
    const prev = newest.get(key);
    if (!prev || Date.parse(prev.created_at) <= t) newest.set(key, r);
  }
  return [...newest.values()];
}

const emptyWindow = (): TeachingWindow => ({ up_w: 0, down_w: 0, score: null, n: 0, by_category: {}, last_at: null });

/**
 * The teaching record of every subject with at least one row in the last 30 days, sorted by subject. A subject with no
 * row has no record (the reader shows "—"); a window with rows but nothing counted has score null.
 */
export function teachingRecord(rows: readonly TeachingRow[], now: number): TeachingRecord[] {
  const bySubject = new Map<string, Record<TeachingWindowId, TeachingWindow>>();
  for (const r of newestPerTarget(rows, now)) {
    const age = now - Date.parse(r.created_at);
    const side = teachingSide(r);
    const weight = Number.isFinite(r.weight) && r.weight > 0 ? r.weight : 0;
    for (const w of TEACHING_WINDOWS) {
      if (age > w.days * DAY_MS) continue;
      let rec = bySubject.get(r.subject);
      if (!rec) { rec = { "7d": emptyWindow(), "30d": emptyWindow() }; bySubject.set(r.subject, rec); }
      const win = rec[w.id];
      if (side === "up") { win.up_w += weight; win.n += 1; }
      if (side === "down") { win.down_w += weight; win.n += 1; }
      if (r.category) win.by_category[r.category] = (win.by_category[r.category] ?? 0) + 1;
      if (!win.last_at || Date.parse(win.last_at) < Date.parse(r.created_at)) win.last_at = r.created_at;
    }
  }
  return [...bySubject.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([subject, windows]) => {
    for (const w of Object.values(windows)) {
      w.score = w.n > 0 ? teachingScore(w.up_w, w.down_w) : null;
      w.by_category = Object.fromEntries(Object.entries(w.by_category).sort(([a], [b]) => (a < b ? -1 : 1)));
    }
    return { subject, windows };
  });
}

// ── Date helpers for injury-thread date math and DB read normalization ──
//
// The neon driver returns DATE columns (injury_date, surgery_date,
// actual_return_date) as JS Date objects, not 'YYYY-MM-DD' strings, while tool
// params arrive as strings. Every date value is normalized to a plain
// 'YYYY-MM-DD' string at the boundary so arithmetic and lexical comparison stay
// correct and timezone-stable. Surfaced by commit 15bb517 (closeThread accuracy
// math produced NaN / mis-compared a Date against date strings).

import type { InjuryEntity, ThreadListItem } from "./client.js";
import type { InjuryPost } from "../../shared/types.js";

// Normalize a 'YYYY-MM-DD' string OR a JS Date to a plain 'YYYY-MM-DD' string.
// Date inputs are read via UTC getters so a DATE that came back as UTC-midnight
// never shifts a day under a non-UTC runtime TZ; string inputs are re-parsed as
// UTC midnight to strip any time component.
export function toIsoDate(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(`${value.slice(0, 10)}T00:00:00Z`);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function daysBetween(from: string | Date, to: string | Date): number {
  const f = new Date(`${toIsoDate(from)}T00:00:00Z`).getTime();
  const t = new Date(`${toIsoDate(to)}T00:00:00Z`).getTime();
  return Math.round((t - f) / 86_400_000);
}

export function addWeeks(base: string | Date, weeks: number): string {
  const b = new Date(`${toIsoDate(base)}T00:00:00Z`).getTime();
  return new Date(b + weeks * 7 * 86_400_000).toISOString().slice(0, 10);
}

// Null-safe date normalization: DATE columns come back as Date objects, so run
// each through toIsoDate to keep the declared `string | null` contract.
function normalizeDateFields<T extends Record<string, unknown>>(
  row: T,
  fields: readonly string[],
): T {
  const out = { ...row } as Record<string, unknown>;
  for (const f of fields) {
    const v = out[f];
    if (v != null) out[f] = toIsoDate(v as string | Date);
  }
  return out as T;
}

const ENTITY_DATE_FIELDS = ["injury_date", "surgery_date", "actual_return_date"] as const;

// injury_entities read normalization (getEntity/getThread/closeThread/etc).
export function normalizeEntityDates(row: InjuryEntity): InjuryEntity {
  return normalizeDateFields(row as unknown as Record<string, unknown>, ENTITY_DATE_FIELDS) as unknown as InjuryEntity;
}

// listThreads joins the same DATE columns onto display fields.
export function normalizeThreadListItem(row: ThreadListItem): ThreadListItem {
  return normalizeDateFields(row as unknown as Record<string, unknown>, ENTITY_DATE_FIELDS) as unknown as ThreadListItem;
}

// injury_posts carries a single DATE column.
export function normalizePostDates(row: InjuryPost): InjuryPost {
  return normalizeDateFields(row as unknown as Record<string, unknown>, ["injury_date"]) as unknown as InjuryPost;
}

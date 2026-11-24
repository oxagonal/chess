/**
 * Settings sync field by field: the settings are one row, and a whole-row "newer wins" let any setting
 * changed on one device (a toggle, a puzzle option) wipe out a plan written on another. Each setting
 * now carries when it last changed on its device (under FIELD_TIMES); the merge keeps, per setting, the
 * later change. Settings never changed since this began share the time the row had then ("*"). Pure.
 */
export const FIELD_TIMES = '_at';

type Value = Record<string, unknown>;
type Times = Record<string, number>;

/** The settings after `patch`, with when each patched setting changed (`rowAt`: the row's modifiedAt). */
export function patchSettings(value: Value | undefined, rowAt: number | undefined, patch: Value, now: number): Value {
  const prev = (value ?? {}) as Value;
  const times: Times = { '*': rowAt ?? 0, ...((prev[FIELD_TIMES] as Times | undefined) ?? {}) };
  for (const k of Object.keys(patch)) times[k] = now;
  return { ...prev, ...patch, [FIELD_TIMES]: times };
}

function timesOf(value: Value, rowAt: number): { base: number; fields: Times } {
  const t = value[FIELD_TIMES] as Times | undefined;
  return t && typeof t === 'object' ? { base: t['*'] ?? 0, fields: t } : { base: rowAt, fields: {} };
}

/** Plan slots neither device has a time for (written before this): both devices' slots, not one's. */
function unionById(a: unknown, b: unknown): unknown {
  if (!Array.isArray(a) || !Array.isArray(b)) return b;
  const seen = new Set(b.map((x: { id?: string }) => x?.id));
  return [...b, ...a.filter((x: { id?: string }) => !seen.has(x?.id))];
}

/** Two devices' settings (`at`: each row's modifiedAt), merged setting by setting. Ties go to `b`. */
export function mergeSettings(a: Value, aAt: number, b: Value, bAt: number): Value {
  const ta = timesOf(a, aAt);
  const tb = timesOf(b, bAt);
  const out: Value = {};
  const times: Times = { '*': Math.max(ta.base, tb.base) };
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (k === FIELD_TIMES) continue;
    const known = ta.fields[k] !== undefined || tb.fields[k] !== undefined;
    const at = ta.fields[k] ?? ta.base;
    const bt = tb.fields[k] ?? tb.base;
    if (!(k in b)) out[k] = a[k];
    else if (!(k in a)) out[k] = b[k];
    else if (k === 'planSlots' && !known) out[k] = unionById(a[k], b[k]);
    else out[k] = at > bt ? a[k] : b[k];
    if (known) times[k] = Math.max(at, bt);
  }
  out[FIELD_TIMES] = times;
  return out;
}

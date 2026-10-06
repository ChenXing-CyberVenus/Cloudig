import { isJsonObject, type JsonObject } from '../../core/contracts/types.mts';

export const CHATGPT_DIL_SOURCE = 'chatgpt.com_dil';
const string = (v: unknown): string => typeof v === 'string' ? v : '';
export type SavedDil = Readonly<{
  kind: 'automation' | 'clock'; label: string; location: string; offset: string;
  submitted: boolean; angles: readonly (number | undefined)[];
}>;

/** Read saved literals only. DIL expressions, callbacks, URLs and timers are
 * source evidence, never executable instructions for the archive reader. */
export function savedDil(ref: JsonObject): SavedDil | undefined {
  const dil = isJsonObject(ref['dil']) ? ref['dil'] : undefined;
  const state = dil && isJsonObject(dil['initialState']) ? dil['initialState'] : {};
  const common = { submitted: state['submitted'] === true, location: '', offset: '', angles: [] };
  if (ref['name'] === 'suggest_automation' && string(state['label'])) {
    return { ...common, kind: 'automation', label: string(state['label']) };
  }
  if (ref['name'] === 'clock_widget') {
    const minutes = state['tz_offset_minutes'];
    const offset = typeof minutes === 'number' && Number.isInteger(minutes) && Math.abs(minutes) <= 14 * 60
      ? `UTC${minutes < 0 ? '−' : '+'}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0')}:${String(Math.abs(minutes) % 60).padStart(2, '0')}` : '';
    const angles = ['hour_angle', 'minute_angle', 'second_angle'].map(key => {
      const value = state[key]; return typeof value === 'number' && Number.isFinite(value) ? ((value % 360) + 360) % 360 : undefined;
    });
    return { ...common, kind: 'clock', label: string(state['time_label']), location: string(state['location']), offset, angles };
  }
  return;
}

/** The first importer saved DIL in unknown.text; keep those archives readable
 * without requiring a reparse or mutating the stored Conversation. */
export function dilReference(block: JsonObject): JsonObject | undefined {
  if (block['type'] === 'interactive' && block['source'] === CHATGPT_DIL_SOURCE && isJsonObject(block['data'])) return block['data'];
  if (block['type'] === 'unknown' && block['kind'] === 'chatgpt-dil' && typeof block['text'] === 'string') {
    try { const value: unknown = JSON.parse(block['text']); if (isJsonObject(value)) return value; } catch { /* retain the normal unknown fallback */ }
  }
  return;
}

export function dilText(value: SavedDil): string {
  return [value.label, value.location, value.offset].filter(Boolean).join(' · ');
}

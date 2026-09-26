import {
  formatDateAddedForDisplay,
  formatDateAddedForInput,
  normalizeDateAdded,
  parseDateAddedInput,
} from './date-added';
import type { ParsedLocalDateTime } from './date-added';

/** Zero is the persisted "never played" value, not a date in January 1970. */
export function normalizeLastPlayed(value: unknown): number | undefined {
  const timestamp = normalizeDateAdded(value);
  return timestamp !== undefined && timestamp > 0 ? timestamp : undefined;
}

export function formatLastPlayedForInput(value: unknown): string {
  return formatDateAddedForInput(normalizeLastPlayed(value));
}

export function formatLastPlayedForDisplay(value: unknown): string {
  const timestamp = normalizeLastPlayed(value);
  return timestamp === undefined ? 'Never played' : formatDateAddedForDisplay(timestamp);
}

/** Blank clears the metric; actual play times must be positive timestamps. */
export function parseLastPlayedInput(value: string): ParsedLocalDateTime {
  const timestamp = parseDateAddedInput(value);
  return timestamp === 0 ? null : timestamp;
}

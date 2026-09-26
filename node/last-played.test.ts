import { strict as assert } from 'assert';
import { test } from 'node:test';
import {
  formatLastPlayedForDisplay,
  formatLastPlayedForInput,
  normalizeLastPlayed,
  parseLastPlayedInput,
} from '../interfaces/last-played';

test('Last Played accepts only real positive timestamps and treats zero as Never played', () => {
  const timestamp = new Date(2026, 8, 26, 13, 15, 42, 123).getTime();
  assert.equal(normalizeLastPlayed(timestamp), timestamp);
  assert.equal(normalizeLastPlayed(1), 1);
  for (const invalid of [undefined, null, '', '100', 0, -1, 1.5, NaN, Infinity, 8_640_000_000_000_001]) {
    assert.equal(normalizeLastPlayed(invalid), undefined);
    assert.equal(formatLastPlayedForInput(invalid), '');
    assert.equal(formatLastPlayedForDisplay(invalid), 'Never played');
  }
});

test('Last Played controls round-trip local dates and distinguish clear from invalid input', () => {
  const timestamp = new Date(2026, 8, 26, 13, 15).getTime();
  assert.equal(formatLastPlayedForInput(timestamp), '2026-09-26T13:15');
  assert.equal(parseLastPlayedInput('2026-09-26T13:15'), timestamp);
  assert.match(formatLastPlayedForDisplay(timestamp), /2026/);
  assert.equal(parseLastPlayedInput(''), undefined);
  assert.equal(parseLastPlayedInput('  '), undefined);
  for (const invalid of ['yesterday', '2026-02-30T12:00', '1969-12-31T12:00', '2026-09-26T25:00']) {
    assert.equal(parseLastPlayedInput(invalid), null);
  }
});

test('Last Played input does not turn the zero timestamp into a playback date', () => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = 'UTC';
  try {
    assert.equal(parseLastPlayedInput('1970-01-01T00:00'), null);
    assert.equal(parseLastPlayedInput('1970-01-01T00:00:01'), 1000);
  } finally {
    if (previousTimezone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previousTimezone;
    }
  }
});

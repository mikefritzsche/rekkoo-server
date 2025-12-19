const { normalizeTimestampToIso, normalizeTimestampFields } = require('../timestampUtils');

describe('timestampUtils', () => {
  test('normalizeTimestampToIso handles epoch millis numbers', () => {
    expect(normalizeTimestampToIso(1700000000000)).toBe(new Date(1700000000000).toISOString());
  });

  test('normalizeTimestampToIso handles epoch millis strings', () => {
    expect(normalizeTimestampToIso('1700000000000')).toBe(new Date(1700000000000).toISOString());
  });

  test('normalizeTimestampToIso handles epoch seconds strings', () => {
    expect(normalizeTimestampToIso('1700000000')).toBe(new Date(1700000000 * 1000).toISOString());
  });

  test('normalizeTimestampToIso handles postgres timestamptz strings', () => {
    expect(normalizeTimestampToIso('2025-11-29 20:13:55.482+00')).toBe('2025-11-29T20:13:55.482Z');
  });

  test('normalizeTimestampFields normalizes only provided fields', () => {
    const record = {
      created_at: '2025-11-29 20:13:55.482+00',
      updated_at: '1700000000000',
      ignored: '1700000000000',
    };

    normalizeTimestampFields(record, ['created_at', 'updated_at']);

    expect(record.created_at).toBe('2025-11-29T20:13:55.482Z');
    expect(record.updated_at).toBe(new Date(1700000000000).toISOString());
    expect(record.ignored).toBe('1700000000000');
  });
});

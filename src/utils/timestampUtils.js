function normalizeTimestampToIso(value) {
  if (value == null) return undefined;

  if (value instanceof Date) {
    const time = value.getTime();
    if (Number.isNaN(time)) return undefined;
    return value.toISOString();
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return undefined;
    return date.toISOString();
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;

    // Epoch timestamps provided as a string (seconds or milliseconds)
    if (/^\d{10,}$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (!Number.isFinite(numeric)) return undefined;
      const millis = trimmed.length === 10 ? numeric * 1000 : numeric;
      const date = new Date(millis);
      if (Number.isNaN(date.getTime())) return undefined;
      return date.toISOString();
    }

    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) return undefined;
    return parsed.toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

function normalizeTimestampFields(record, fields) {
  if (!record || typeof record !== 'object' || !Array.isArray(fields)) return record;
  for (const field of fields) {
    if (!field) continue;
    if (record[field] == null) continue;
    const normalized = normalizeTimestampToIso(record[field]);
    if (normalized) {
      record[field] = normalized;
    }
  }
  return record;
}

module.exports = {
  normalizeTimestampToIso,
  normalizeTimestampFields,
};

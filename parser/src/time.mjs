export function normalizeParserTimestamp(value, label = "Parser clock") {
  const instant = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(instant.getTime())) throw new TypeError(`${label} must resolve to a valid date-time`);
  return instant.toISOString();
}

export function parserTimestamp({ parsedAt = null, clock = () => new Date() } = {}) {
  if (parsedAt !== null && parsedAt !== undefined) return normalizeParserTimestamp(parsedAt, "parsedAt");
  if (typeof clock !== "function") throw new TypeError("Parser clock must be a function");
  return normalizeParserTimestamp(clock(), "Parser clock");
}

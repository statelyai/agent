const UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

export function parseDuration(text) {
  const match = /^(\d+)(ms|s|m|h)$/.exec(text);
  if (!match) throw new TypeError(`not a duration: ${JSON.stringify(text)}`);
  return Number(match[1]) * UNITS[match[2]];
}

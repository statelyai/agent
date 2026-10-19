const UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

export function parseDuration(text) {
  if (!/^(\d+(ms|s|m|h))+$/.test(text))
    throw new TypeError(`not a duration: ${JSON.stringify(text)}`);
  let total = 0;
  for (const [, amount, unit] of text.matchAll(/(\d+)(ms|s|m|h)/g))
    total += Number(amount) * UNITS[unit];
  return total;
}

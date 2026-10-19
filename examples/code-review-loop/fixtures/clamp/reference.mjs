export function clamp(value, min, max) {
  if (min > max) throw new RangeError(`min (${min}) is greater than max (${max})`);
  if (Number.isNaN(value)) return value;
  return Math.min(Math.max(value, min), max);
}

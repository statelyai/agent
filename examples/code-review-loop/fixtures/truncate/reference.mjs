export function truncate(text, max) {
  if (max < 1) throw new RangeError(`max must be at least 1, got ${max}`);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

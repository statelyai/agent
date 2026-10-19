export function chunk(array, size) {
  if (!Number.isInteger(size) || size < 1)
    throw new RangeError(`size must be a positive integer, got ${size}`);
  const chunks = [];
  for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
  return chunks;
}

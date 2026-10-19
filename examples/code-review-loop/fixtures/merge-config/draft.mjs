const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function mergeConfig(base, override) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] =
      isPlainObject(value) && isPlainObject(base[key]) ? mergeConfig(base[key], value) : value;
  }
  return merged;
}

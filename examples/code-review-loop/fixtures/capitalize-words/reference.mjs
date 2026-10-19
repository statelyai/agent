export function capitalizeWords(text) {
  return text.replace(/(^|\s)(\S)/g, (_, space, first) => space + first.toUpperCase());
}

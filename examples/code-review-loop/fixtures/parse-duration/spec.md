Implement `parseDuration(text)` in `parse-duration.mjs`, returning milliseconds.

- A duration is one or more `<integer><unit>` parts with no spaces, units `ms`, `s`, `m`, `h`.
- Parts add up: `"1h30m"` is `5400000`.
- Throw a `TypeError` for anything else, including an empty string.

Implement `mergeConfig(base, override)` in `merge-config.mjs`.

- Return a new object; never mutate either argument.
- Keys in `override` win over keys in `base`.
- Nested plain objects merge recursively.
- Arrays are concatenated, `base` items first.

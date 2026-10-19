import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeConfig } from "./merge-config.mjs";

test("concatenates arrays, base first", () =>
  assert.deepEqual(mergeConfig({ tags: ["a"] }, { tags: ["b"] }), { tags: ["a", "b"] }));
test("does not mutate its arguments", () => {
  const base = { db: { port: 1 } };
  mergeConfig(base, { db: { port: 2 } });
  assert.deepEqual(base, { db: { port: 1 } });
});

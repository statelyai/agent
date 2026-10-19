import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeConfig } from "./merge-config.mjs";

test("override wins for scalars", () =>
  assert.deepEqual(mergeConfig({ a: 1 }, { a: 2 }), { a: 2 }));
test("merges nested objects", () =>
  assert.deepEqual(mergeConfig({ db: { host: "x", port: 1 } }, { db: { port: 2 } }), {
    db: { host: "x", port: 2 },
  }));
test("replaces arrays", () =>
  assert.deepEqual(mergeConfig({ tags: ["a"] }, { tags: ["b"] }), { tags: ["b"] }));

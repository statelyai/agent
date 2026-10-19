import { test } from "node:test";
import assert from "node:assert/strict";
import { truncate } from "./truncate.mjs";

test("returns short text unchanged", () => assert.equal(truncate("hi", 5), "hi"));
test("truncates to exactly max characters with an ellipsis", () =>
  assert.equal(truncate("hello world", 8), "hello w…"));
test("keeps text of exactly max characters", () => assert.equal(truncate("hello", 5), "hello"));

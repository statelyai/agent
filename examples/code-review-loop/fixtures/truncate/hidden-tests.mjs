import { test } from "node:test";
import assert from "node:assert/strict";
import { truncate } from "./truncate.mjs";

test("a max of 1 returns just the ellipsis", () => assert.equal(truncate("hello", 1), "…"));
test("throws a RangeError for max 0", () => assert.throws(() => truncate("hello", 0), RangeError));
test("the result is never longer than max", () =>
  assert.equal(truncate("abcdefghij", 4).length, 4));

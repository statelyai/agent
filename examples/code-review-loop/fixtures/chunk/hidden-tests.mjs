import { test } from "node:test";
import assert from "node:assert/strict";
import { chunk } from "./chunk.mjs";

test("throws a RangeError for size 0", () => assert.throws(() => chunk([1], 0), RangeError));
test("throws a RangeError for a fractional size", () =>
  assert.throws(() => chunk([1], 1.5), RangeError));
test("does not mutate the input", () => {
  const input = [1, 2, 3];
  chunk(input, 2);
  assert.deepEqual(input, [1, 2, 3]);
});
test("a size larger than the array gives one chunk", () =>
  assert.deepEqual(chunk([1, 2], 5), [[1, 2]]));

import { test } from "node:test";
import assert from "node:assert/strict";
import { chunk } from "./chunk.mjs";

test("splits evenly", () =>
  assert.deepEqual(chunk([1, 2, 3, 4], 2), [
    [1, 2],
    [3, 4],
  ]));
test("keeps the partial last chunk", () => assert.deepEqual(chunk([1, 2, 3], 2), [[1, 2], [3]]));
test("returns [] for an empty array", () => assert.deepEqual(chunk([], 3), []));

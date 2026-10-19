import { test } from "node:test";
import assert from "node:assert/strict";
import { clamp } from "./clamp.mjs";

test("throws a RangeError when min > max", () => assert.throws(() => clamp(1, 5, 0), RangeError));
test("NaN stays NaN", () => assert.ok(Number.isNaN(clamp(Number.NaN, 0, 1))));
test("works with negative ranges", () => assert.equal(clamp(-20, -10, -5), -10));
test("keeps the bounds themselves", () => assert.equal(clamp(10, 0, 10), 10));

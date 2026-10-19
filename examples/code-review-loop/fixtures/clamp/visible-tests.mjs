import { test } from "node:test";
import assert from "node:assert/strict";
import { clamp } from "./clamp.mjs";

test("keeps a value inside the range", () => assert.equal(clamp(5, 0, 10), 5));
test("raises a value below min to min", () => assert.equal(clamp(-3, 0, 10), 0));
test("lowers a value above max to max", () => assert.equal(clamp(42, 0, 10), 10));

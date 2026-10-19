import { test } from "node:test";
import assert from "node:assert/strict";
import { roundHalf } from "./round-half.mjs";

test("rounds 2.5 up to 3", () => assert.equal(roundHalf(2.5), 3));
test("rounds -2.5 to -2", () => assert.equal(roundHalf(-2.5), -2));
test("rounds 1.2 down to 1", () => assert.equal(roundHalf(1.2), 1));

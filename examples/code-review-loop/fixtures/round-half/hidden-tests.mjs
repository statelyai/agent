import { test } from "node:test";
import assert from "node:assert/strict";
import { roundHalf } from "./round-half.mjs";

test("rounds -2.5 away from zero", () => assert.equal(roundHalf(-2.5), -3));
test("rounds -0.5 away from zero", () => assert.equal(roundHalf(-0.5), -1));
test("rounds 2.4 down", () => assert.equal(roundHalf(2.4), 2));

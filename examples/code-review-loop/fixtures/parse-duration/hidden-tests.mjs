import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDuration } from "./parse-duration.mjs";

test("parses compound durations", () => assert.equal(parseDuration("1h30m"), 5_400_000));
test("parses hours", () => assert.equal(parseDuration("2h"), 7_200_000));
test("parses a three-part duration", () => assert.equal(parseDuration("1m1s1ms"), 61_001));
test("throws on garbage", () => assert.throws(() => parseDuration("soon"), TypeError));
test("throws on an empty string", () => assert.throws(() => parseDuration(""), TypeError));

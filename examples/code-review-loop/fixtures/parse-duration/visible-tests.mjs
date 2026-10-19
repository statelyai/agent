import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDuration } from "./parse-duration.mjs";

test("parses seconds", () => assert.equal(parseDuration("90s"), 90_000));
test("parses minutes", () => assert.equal(parseDuration("5m"), 300_000));
test("parses milliseconds", () => assert.equal(parseDuration("250ms"), 250));

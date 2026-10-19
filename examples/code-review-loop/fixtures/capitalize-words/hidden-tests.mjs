import { test } from "node:test";
import assert from "node:assert/strict";
import { capitalizeWords } from "./capitalize-words.mjs";

test("an empty string stays empty", () => assert.equal(capitalizeWords(""), ""));
test("leaves words that start with a non-letter", () =>
  assert.equal(capitalizeWords("2nd place"), "2nd Place"));
test("preserves tabs and newlines", () =>
  assert.equal(capitalizeWords("one\ttwo\nthree"), "One\tTwo\nThree"));

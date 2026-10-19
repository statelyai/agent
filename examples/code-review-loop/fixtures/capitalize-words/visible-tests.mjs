import { test } from "node:test";
import assert from "node:assert/strict";
import { capitalizeWords } from "./capitalize-words.mjs";

test("capitalizes each word", () =>
  assert.equal(capitalizeWords("hello big world"), "Hello Big World"));
test("keeps existing capitals", () => assert.equal(capitalizeWords("say NASA"), "Say NASA"));
test("preserves spacing", () => assert.equal(capitalizeWords("a  b"), "A  B"));

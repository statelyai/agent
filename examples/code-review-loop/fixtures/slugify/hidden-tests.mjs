import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "./slugify.mjs";

test("strips diacritics", () => assert.equal(slugify("Crème Brûlée"), "creme-brulee"));
test("empty string stays empty", () => assert.equal(slugify(""), ""));
test("keeps digits", () => assert.equal(slugify("Top 10 Tips"), "top-10-tips"));
test("all separators becomes empty", () => assert.equal(slugify("!!!"), ""));

/**
 * Loads `@statelyai/agent/testing` the way the Cloudflare pool does: every
 * dependency goes through Vite, including Vitest's mock hoisting. Vitest 4
 * hoists the imports of any module whose text matches the pattern below, even
 * inside a comment, and the hoisted module's re-exports read `undefined`.
 */
import * as testing from "@statelyai/agent/testing";
import { expect, it } from "vitest";

// Vite's `import.meta.glob`; this package does not depend on `vite` for its types.
declare global {
  interface ImportMeta {
    glob<T>(
      pattern: string,
      options: { query: string; import: string; eager: true },
    ): Record<string, T>;
  }
}

// Vitest 4.1's hoisting pattern, with its unescaped `.`.
const VITEST_4_HOISTABLE = /\b(?:vi|vitest)\s*.\s*(?:mock|unmock|hoisted|doMock|doUnmock)\s*\(/;

it("defines every @statelyai/agent/testing export under workerd", () => {
  const missing = Object.entries(testing)
    .filter(([, value]) => value === undefined)
    .map(([name]) => name);
  expect(missing).toEqual([]);
});

it("ships no built module that Vitest 4 would hoist as a mock file", () => {
  const built = import.meta.glob<string>("../../../dist/*.{mjs,cjs}", {
    query: "?raw",
    import: "default",
    eager: true,
  });
  expect(Object.keys(built).length).toBeGreaterThan(0);
  const hoistable = Object.entries(built)
    .filter(([, source]) => VITEST_4_HOISTABLE.test(source))
    .map(([file]) => file);
  expect(hoistable).toEqual([]);
});

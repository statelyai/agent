import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const hasDist = existsSync(join(root, "dist/index.d.mts"));

// TS2742 ("cannot be named without a reference to '.../dist/types-<hash>.mjs'")
// only fires when the package resolves from a real node_modules directory: from
// `src/` (tsconfig paths) or the repo's own dist (self-reference), TS falls back
// to a relative import path and stays silent. So this copies the BUILT package
// into a temp node_modules and compiles fixtures/dts-composite as a consumer.
describe.skipIf(!hasDist)("declaration emit (composite consumer of dist)", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-dts-composite-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test.each(["tsc", "tsc6"])(
    "%s emits portable declarations",
    (bin) => {
      const pkg = join(dir, "node_modules/@statelyai/agent");
      if (!existsSync(pkg)) {
        mkdirSync(pkg, { recursive: true });
        cpSync(join(root, "package.json"), join(pkg, "package.json"));
        cpSync(join(root, "dist"), join(pkg, "dist"), { recursive: true });
        for (const dep of ["xstate", "zod"]) {
          symlinkSync(join(root, "node_modules", dep), join(dir, "node_modules", dep), "dir");
        }
        for (const file of ["index.ts", "tsconfig.json"]) {
          cpSync(join(root, "fixtures/dts-composite", file), join(dir, file));
        }
      }

      const result = spawnSync(join(root, "node_modules/.bin", bin), ["-p", dir], {
        encoding: "utf8",
      });
      expect(result.stdout + result.stderr).toBe("");
      expect(result.status).toBe(0);
    },
    60_000,
  );
});

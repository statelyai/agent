/**
 * Writes `.dev.vars` (gitignored) from the repo root `.env`, so `wrangler dev`
 * can hand the Durable Object a real key without one being committed anywhere.
 */
import { readFileSync, writeFileSync } from "node:fs";

const KEYS = ["OPENAI_API_KEY"];
const envPath = new URL("../../.env", import.meta.url);

let source = "";
try {
  source = readFileSync(envPath, "utf8");
} catch {
  console.error(`No .env at ${envPath.pathname} — starting keyless (scripted executors).`);
}

const lines = KEYS.map((key) => {
  const match = source.match(new RegExp(`^${key}=(.*)$`, "m"));
  const value = match?.[1]?.trim().replace(/^['"]|['"]$/g, "");
  return value ? `${key}=${value}` : "";
}).filter(Boolean);

writeFileSync(new URL("./.dev.vars", import.meta.url), `${lines.join("\n")}\n`);
console.log(lines.length ? `.dev.vars written (${KEYS.join(", ")})` : ".dev.vars written (empty)");

#!/usr/bin/env node
/**
 * `statelyai-agent lint <workflow.json>` — keyless static verification for an
 * agent machine authored as data (an {@link AgentWorkflowConfig} JSON file).
 *
 * The library bundles no JSON Schema engine, so the CLI lints STRUCTURE ONLY:
 * it compiles the config with a permissive pass-through schema compiler (each
 * JSON Schema is kept as-is for structural checks, validation is a no-op) and
 * runs {@link lintAgentMachine}. Exits `1` on any error-severity finding.
 *
 * For full schema-aware linting, import the API and compile with a real engine:
 * `lintAgentMachine(setupAgent.fromConfig(config, { compileSchema }))`.
 *
 * @module
 */
import { readFileSync } from "node:fs";
import { lintAgentMachine, setupAgent, type StandardSchemaV1 } from "./index.js";

// A pass-through StandardSchema: validation is a no-op, but the original JSON
// Schema is exposed via the `~standard.jsonSchema` extension so structural
// checks (unserializable-context, final-without-output) still read real shape.
function stubCompileSchema(jsonSchema: Record<string, unknown>): StandardSchemaV1 {
  return {
    "~standard": {
      version: 1,
      vendor: "statelyai-agent-cli",
      validate: (value: unknown) => ({ value }),
      jsonSchema: { input: () => jsonSchema },
    },
  } as StandardSchemaV1;
}

function printUsage(): void {
  process.stderr.write(
    "Usage: statelyai-agent lint <workflow.json> [--no-schemas]\n\n" +
      "  Statically verifies an agent-machine JSON config (structure-only).\n" +
      "  Exits 1 on any error-severity finding.\n",
  );
}

function main(argv: string[]): number {
  const args = argv.slice(2);
  const command = args[0];
  const file = args.find((arg, index) => index > 0 && !arg.startsWith("-"));

  if (command !== "lint" || !file) {
    printUsage();
    return 2;
  }

  let config: unknown;
  try {
    config = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    process.stderr.write(
      `statelyai-agent: could not read/parse '${file}': ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 2;
  }

  let machine;
  try {
    machine = setupAgent.fromConfig(config as never, { compileSchema: stubCompileSchema });
  } catch (error) {
    process.stderr.write(
      `statelyai-agent: '${file}' is not a valid agent-machine config: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 2;
  }

  const diagnostics = lintAgentMachine(machine);
  const errors = diagnostics.filter((d) => d.severity === "error");
  const warnings = diagnostics.filter((d) => d.severity === "warning");

  for (const d of diagnostics) {
    const label = d.severity === "error" ? "error" : "warn ";
    process.stdout.write(`  ${label}  ${d.code}  ${d.path}\n         ${d.message}\n`);
  }

  process.stdout.write(
    `\n${file}: ${errors.length} error(s), ${warnings.length} warning(s) ` +
      `(structure-only; schemas not compiled).\n`,
  );

  return errors.length > 0 ? 1 : 0;
}

process.exit(main(process.argv));

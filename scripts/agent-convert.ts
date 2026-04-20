import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toMermaid } from '../src/graph/index.js';
import type { AgentMachine } from '../src/index.js';
import { toXStateMachine } from '../src/xstate/index.js';

type Format = 'mermaid' | 'xstate';

interface CliOptions {
  file?: string;
  format: Format;
  exportName?: string;
  factoryName?: string;
  outFile?: string;
  help: boolean;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help || !options.file) {
    printHelp();
    process.exit(options.help ? 0 : 1);
  }

  const machine = await loadMachine(options);
  const output =
    options.format === 'mermaid'
      ? toMermaid(machine)
      : `${JSON.stringify(toXStateMachine(machine), null, 2)}\n`;

  if (options.outFile) {
    await writeFile(resolve(options.outFile), output);
    return;
  }

  process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    format: 'mermaid',
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    if (arg === '--format' || arg === '-f') {
      options.format = parseFormat(requiredValue(args, index, arg));
      index += 1;
      continue;
    }

    if (arg.startsWith('--format=')) {
      options.format = parseFormat(arg.slice('--format='.length));
      continue;
    }

    if (arg === '--export' || arg === '-e') {
      options.exportName = requiredValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith('--export=')) {
      options.exportName = arg.slice('--export='.length);
      continue;
    }

    if (arg === '--factory') {
      options.factoryName = requiredValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith('--factory=')) {
      options.factoryName = arg.slice('--factory='.length);
      continue;
    }

    if (arg === '--out' || arg === '-o') {
      options.outFile = requiredValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith('--out=')) {
      options.outFile = arg.slice('--out='.length);
      continue;
    }

    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (options.file) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }

    options.file = arg;
  }

  return options;
}

function parseFormat(value: string): Format {
  if (value === 'mermaid' || value === 'xstate') {
    return value;
  }

  throw new Error(`Unsupported format '${value}'. Use 'mermaid' or 'xstate'.`);
}

function requiredValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('-')) {
    throw new Error(`Missing value for ${option}`);
  }

  return value;
}

async function loadMachine(options: CliOptions): Promise<AgentMachine> {
  const fileUrl = pathToFileURL(resolve(options.file!)).href;
  const mod = await import(fileUrl) as Record<string, unknown>;

  if (options.factoryName) {
    const factory = mod[options.factoryName];
    if (typeof factory !== 'function') {
      throw new Error(`Export '${options.factoryName}' is not a function.`);
    }

    const machine = await factory();
    return assertAgentMachine(machine, `factory '${options.factoryName}'`);
  }

  if (options.exportName) {
    return assertAgentMachine(
      mod[options.exportName],
      `export '${options.exportName}'`
    );
  }

  for (const candidate of [mod.default, mod.machine]) {
    if (isAgentMachine(candidate)) {
      return candidate;
    }
  }

  const namedMachines = Object.entries(mod).filter(([, value]) =>
    isAgentMachine(value)
  );
  if (namedMachines.length === 1) {
    return namedMachines[0]![1] as AgentMachine;
  }

  throw new Error(
    [
      'Could not find an agent machine export.',
      'Export a machine as default or named `machine`, or pass `--export <name>`.',
      'For zero-arg factory exports, pass `--factory <name>`.',
    ].join(' ')
  );
}

function assertAgentMachine(value: unknown, label: string): AgentMachine {
  if (!isAgentMachine(value)) {
    throw new Error(`${label} did not return an agent machine.`);
  }

  return value;
}

function isAgentMachine(value: unknown): value is AgentMachine {
  return (
    !!value
    && typeof value === 'object'
    && typeof (value as AgentMachine).id === 'string'
    && typeof (value as AgentMachine).getInitialState === 'function'
    && typeof (value as AgentMachine).transition === 'function'
    && typeof (value as AgentMachine).execute === 'function'
  );
}

function printHelp() {
  process.stdout.write(`Usage:
  pnpm agent:convert <file> [--format mermaid|xstate]

Options:
  -f, --format <format>   Output format. Defaults to mermaid.
  -e, --export <name>     Named export containing an agent machine.
      --factory <name>    Named zero-arg factory that returns an agent machine.
  -o, --out <file>        Write output to a file instead of stdout.
  -h, --help              Show this help.

Examples:
  pnpm agent:convert ./examples/simple.ts --factory createSimpleExample
  pnpm agent:convert ./examples/simple.ts --factory createSimpleExample --format xstate
`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

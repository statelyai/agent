/**
 * Typechecks fenced ```ts / ```typescript blocks in docs/*.md and readme.md
 * using twoslash. Blocks fenced as ```ts no-check are skipped.
 *
 * Usage: pnpm docs:check
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createTwoslasher } from 'twoslash';

const root = fileURLToPath(new URL('..', import.meta.url));

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  esModuleInterop: true,
  skipLibCheck: true,
  noEmit: true,
  types: ['node'],
  baseUrl: root,
  paths: {
    '@statelyai/agent': ['./src/index.ts'],
    '@statelyai/agent/ai-sdk': ['./src/ai-sdk/index.ts'],
    '@statelyai/agent/machines': ['./src/machines/index.ts'],
    '@statelyai/agent/otel': ['./src/otel/index.ts'],
    '@statelyai/agent/sqlite': ['./src/sqlite/index.ts'],
  },
};

// Ambient declarations injected only when a block references the name but
// doesn't declare/import it itself.
const globalsFile = join(root, 'docs/snippet-globals.ts');
const globalsSource = readFileSync(globalsFile, 'utf8');

type Global = { name: string; text: string };

function parseGlobals(source: string): Global[] {
  const globals: Global[] = [];
  // Blocks are separated by blank lines; each block declares exactly one name
  // via `declare const X`, `declare function X`, `type X`, or `interface X`.
  for (const block of source.split(/\n{2,}/)) {
    const text = block.trim();
    if (!text || text.startsWith('//')) continue;
    const match = text.match(
      /^import\s+(?:type\s+)?\{\s*([A-Za-z_$][\w$]*)\s*\}/m,
    ) ??
      text.match(
        /(?:declare (?:const|let|function|class)|type|interface)\s+([A-Za-z_$][\w$]*)/,
      );
    if (!match) continue;
    globals.push({ name: match[1]!, text });
  }
  return globals;
}

const GLOBALS = parseGlobals(globalsSource);

/**
 * Every export of the package's public entry points, mapped to the specifier it
 * should be imported from. Auto-derived so snippets stay in sync with the API.
 */
const PACKAGE_ENTRIES: Record<string, string> = {
  '@statelyai/agent': 'src/index.ts',
  '@statelyai/agent/ai-sdk': 'src/ai-sdk/index.ts',
  '@statelyai/agent/machines': 'src/machines/index.ts',
  '@statelyai/agent/otel': 'src/otel/index.ts',
  '@statelyai/agent/sqlite': 'src/sqlite/index.ts',
};

function collectPackageExports(): Map<string, string> {
  const exports = new Map<string, string>();
  const program = ts.createProgram(
    Object.values(PACKAGE_ENTRIES).map((f) => join(root, f)),
    { ...COMPILER_OPTIONS, noEmit: true },
  );
  const checker = program.getTypeChecker();
  for (const [specifier, file] of Object.entries(PACKAGE_ENTRIES)) {
    const source = program.getSourceFile(join(root, file));
    if (!source) continue;
    const symbol = checker.getSymbolAtLocation(source);
    if (!symbol) continue;
    for (const exported of checker.getExportsOfModule(symbol)) {
      const name = exported.getName();
      if (!exports.has(name)) exports.set(name, specifier);
    }
  }
  return exports;
}

/** Names bound by the snippet itself: declarations, imports, destructuring. */
function collectDeclaredNames(code: string): Set<string> {
  const names = new Set<string>();
  const add = (n: string | undefined) => {
    if (n) names.add(n);
  };

  // import { a, b as c }, import d, import * as e -- may span lines
  for (const m of code.matchAll(/import\s+([\s\S]*?)\s+from\s*['"]/g)) {
    const clause = m[1]!;
    for (const named of clause.matchAll(/([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?/g)) {
      add(named[2] ?? named[1]);
    }
  }
  // declarations
  for (const m of code.matchAll(
    /(?:^|\n)\s*(?:export\s+)?(?:declare\s+)?(?:async\s+)?(?:const|let|var|function|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    add(m[1]);
  }
  // destructuring / array binding patterns
  for (const m of code.matchAll(/(?:const|let|var)\s*([{[][\s\S]*?[}\]])\s*=/g)) {
    for (const named of m[1]!.matchAll(/([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?/g)) {
      add(named[2] ?? named[1]);
    }
  }
  // function/arrow parameters are out of scope: an undeclared global that
  // shadows a parameter name would be injected harmlessly at top level.
  return names;
}

function referencesName(code: string, name: string): boolean {
  return new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\b`).test(code);
}

const PACKAGE_EXPORTS = collectPackageExports();

function buildPreamble(code: string): string {
  const declared = collectDeclaredNames(code);
  const lines: string[] = [];
  for (const [name, specifier] of PACKAGE_EXPORTS) {
    if (GLOBALS.some((g) => g.name === name)) continue;
    if (referencesName(code, name) && !declared.has(name)) {
      lines.push(`import { ${name} } from '${specifier}';`);
    }
  }
  for (const g of GLOBALS) {
    if (referencesName(code, g.name) && !declared.has(g.name)) {
      lines.push(g.text);
    }
  }
  if (!lines.length) return '';
  return lines.join('\n') + '\n// ---cut---\n';
}

type Block = {
  file: string;
  /** 1-based line of the opening fence */
  line: number;
  code: string;
  skip: boolean;
};

function extractBlocks(file: string, source: string): Block[] {
  const lines = source.split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = lines[i]!.match(/^(\s*)(`{3,})\s*(\S.*)?$/);
    if (!open) {
      i++;
      continue;
    }
    const [, indent, ticks, infoRaw] = open;
    const info = (infoRaw ?? '').trim();
    const closer = new RegExp(`^${indent}\`{${ticks!.length},}\\s*$`);
    let j = i + 1;
    while (j < lines.length && !closer.test(lines[j]!)) j++;
    const lang = info.split(/\s+/)[0] ?? '';
    if (lang === 'ts' || lang === 'typescript') {
      blocks.push({
        file,
        line: i + 1,
        code: lines
          .slice(i + 1, j)
          .map((l) => (indent ? l.slice(indent.length) : l))
          .join('\n'),
        skip: /\bno-check\b/.test(info),
      });
    }
    i = j + 1;
  }
  return blocks;
}

// Optional CLI args filter which markdown files are checked, by substring.
const filters = process.argv.slice(2);
const files = [
  join(root, 'readme.md'),
  ...readdirSync(join(root, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => join(root, 'docs', f)),
].filter((f) => !filters.length || filters.some((arg) => f.includes(arg)));

const twoslasher = createTwoslasher({ compilerOptions: COMPILER_OPTIONS });

let checked = 0;
let skipped = 0;
const failures: string[] = [];

for (const file of files) {
  const rel = relative(root, file);
  const source = readFileSync(file, 'utf8');
  for (const block of extractBlocks(rel, source)) {
    if (block.skip) {
      skipped++;
      continue;
    }
    checked++;
    const preamble = buildPreamble(block.code);
    let errors: { line: number; text: string; code: number }[] = [];
    try {
      const result = twoslasher(preamble + block.code, 'ts', {
        handbookOptions: { noErrorValidation: true },
      });
      // `result.code` is the snippet with the preamble cut away, and error
      // `start` offsets index into it — so line numbers map straight back to
      // the markdown block.
      errors = result.errors.map((e) => ({
        line: result.code.slice(0, Math.max(0, e.start ?? 0)).split('\n').length - 1,
        text: e.text,
        code: e.code,
      }));
    } catch (error) {
      errors = [
        { line: 0, text: error instanceof Error ? error.message : String(error), code: 0 },
      ];
    }
    if (!errors.length) continue;
    const detail = errors
      .map((e) => `      ${rel}:${block.line + 1 + e.line}  TS${e.code}: ${e.text}`)
      .join('\n');
    failures.push(`${rel}:${block.line} (fenced block)\n${detail}`);
  }
}

if (failures.length) {
  console.error('\nFailing snippets:\n');
  for (const f of failures) console.error(f + '\n');
}

console.log(
  `docs:check — ${checked} block(s) checked, ${skipped} skipped, ${failures.length} failed`,
);

process.exit(failures.length ? 1 : 0);

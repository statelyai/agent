import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

const execFileAsync = promisify(execFile);

test('agent:convert writes Mermaid and XState output from machine files', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'agent-convert-'));
  const fixture = resolve('src/fixtures/converter-machine.ts');

  const mermaidFile = join(tmp, 'default.mmd');
  await runConvert([fixture, '--format', 'mermaid', '--out', mermaidFile]);
  await expect(readFile(mermaidFile, 'utf8')).resolves.toBe(`stateDiagram-v2
    [*] --> idle
    idle --> done : submit [event.ok]
    idle --> rejected : submit [!(event.ok)]
    rejected --> [*]
    done --> [*]`);

  const namedXStateFile = join(tmp, 'named.json');
  await runConvert([
    fixture,
    '--export',
    'namedMachine',
    '--format',
    'xstate',
    '--out',
    namedXStateFile,
  ]);
  const namedXState = JSON.parse(await readFile(namedXStateFile, 'utf8')) as {
    id: string;
    initial: string;
    states: Record<string, unknown>;
  };
  expect(namedXState.id).toBe('named-converter-machine');
  expect(namedXState.initial).toBe('idle');
  expect(Object.keys(namedXState.states)).toEqual(['idle', 'rejected', 'done']);

  const factoryXStateFile = join(tmp, 'factory.json');
  await runConvert([
    fixture,
    '--factory',
    'createFixtureMachine',
    '--format',
    'xstate',
    '--out',
    factoryXStateFile,
  ]);
  const factoryXState = JSON.parse(await readFile(factoryXStateFile, 'utf8')) as {
    id: string;
  };
  expect(factoryXState.id).toBe('factory-converter-machine');
});

async function runConvert(args: string[]) {
  await execFileAsync('pnpm', ['agent:convert', ...args], {
    cwd: resolve('.'),
  });
}

/**
 * The task set: tiny, self-contained coding tasks, one directory each under
 * `fixtures/<id>/`.
 *
 *   spec.md            what to build (the author and reviewer read it)
 *   starter.mjs        the file as it is before the change
 *   visible-tests.mjs  the tests `runChecks` runs every round (the author and reviewer read them)
 *   hidden-tests.mjs   tests only the objective runs, after a task ships
 *   reference.mjs      a known-good solution, when one exists (test doubles only)
 *   draft.mjs          a plausible flawed first attempt (test doubles only)
 *
 * Each task carries a label people wrote: `resolvable` (a correct patch
 * exists and a retry can find it) or `novel-expected` (the spec contradicts
 * its own visible tests, so the right move is to escalate to a person).
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type TaskLabel = "resolvable" | "novel-expected";
export type Split = "train" | "held-out";

/** What the environment needs to run a task: its spec, the target file, and the visible tests. */
export type TaskBrief = {
  id: string;
  /** The file the author writes, next to the tests (`slugify.mjs`). */
  file: string;
  spec: string;
  starter: string;
  /** The visible test file's source. */
  visibleTests: string;
  /** The test names declared in the visible test file, in order. */
  visibleTestNames: string[];
};

export type Task = TaskBrief & { label: TaskLabel; split: Split };

const TASK_LABELS: Array<{ id: string; label: TaskLabel; split: Split }> = [
  { id: "clamp", label: "resolvable", split: "train" },
  { id: "slugify", label: "resolvable", split: "train" },
  { id: "chunk", label: "resolvable", split: "train" },
  { id: "parse-duration", label: "resolvable", split: "train" },
  { id: "round-half", label: "novel-expected", split: "train" },
  { id: "truncate", label: "resolvable", split: "held-out" },
  { id: "capitalize-words", label: "resolvable", split: "held-out" },
  { id: "merge-config", label: "novel-expected", split: "held-out" },
];

/** Absolute path of a fixture file. */
export function fixturePath(id: string, name: string): string {
  return fileURLToPath(new URL(`./fixtures/${id}/${name}`, import.meta.url));
}

/** A fixture file's contents, or undefined when the task has none (`reference.mjs`, `draft.mjs`). */
export function readFixture(id: string, name: string): string | undefined {
  const path = fixturePath(id, name);
  return existsSync(path) ? readFileSync(path, "utf-8") : undefined;
}

/** The names a test file declares with `test("...")`. */
export function testNamesOf(source: string): string[] {
  return [...source.matchAll(/\btest\(\s*"([^"]+)"/g)].map((match) => match[1]!);
}

function loadTask(entry: (typeof TASK_LABELS)[number]): Task {
  const read = (name: string) => {
    const text = readFixture(entry.id, name);
    if (text === undefined)
      throw new Error(`task ${entry.id}: missing fixtures/${entry.id}/${name}`);
    return text;
  };
  const visibleTests = read("visible-tests.mjs");
  return {
    ...entry,
    file: `${entry.id}.mjs`,
    spec: read("spec.md").trim(),
    starter: read("starter.mjs"),
    visibleTests,
    visibleTestNames: testNamesOf(visibleTests),
  };
}

export const ALL_TASKS: Task[] = TASK_LABELS.map(loadTask);
/** The TRAIN split: the improvement loop reads these traces. */
export const TRAIN_TASKS = ALL_TASKS.filter((task) => task.split === "train");
/** The HELD-OUT split: promotion needs these too, and their traces never reach the reflection prompt. */
export const HELD_OUT_TASKS = ALL_TASKS.filter((task) => task.split === "held-out");
export const TASK_IDS = ALL_TASKS.map((task) => task.id);

export function getTask(id: string): Task {
  const task = ALL_TASKS.find((candidate) => candidate.id === id);
  if (!task) throw new Error(`unknown task '${id}' (known: ${TASK_IDS.join(", ")})`);
  return task;
}

/** The brief the environment carries in context: everything but the label and split. */
export function briefOf(task: Task): TaskBrief {
  const { label: _label, split: _split, ...brief } = task;
  return brief;
}

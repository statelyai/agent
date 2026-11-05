/**
 * Reads a transition function's source (`String(fn)`, already JavaScript) with
 * a real parser, so what it returns is read from its syntax tree: every path
 * through ternaries, `&&`/`||`, early returns and local constants.
 *
 * @module
 */
import { parse, type Node } from "acorn";

/** What a transition function's own return paths say. */
export interface TransitionSource {
  /** Every literal target it can return, as written (`"review"`, `"#done"`, `".child"`). */
  targets: string[];
  /** Some path returns a target the source does not spell out: a variable, a call's result. */
  unknown: boolean;
  /** Some path returns a transition without a target. */
  stays: boolean;
  /** Some path returns nothing, so the transition may not be taken. */
  declines: boolean;
  /** The context keys it sets; `…name` for a spread whose keys cannot be read. */
  context: string[];
}

type AnyNode = Node & Record<string, any>;

const isNode = (value: unknown): value is AnyNode =>
  typeof value === "object" && value !== null && typeof (value as Node).type === "string";

const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
  "FunctionDeclaration",
]);

/** The function in `code`: an arrow, a function expression, or a method (`GO({ context }) { … }`). */
function parseFunction(code: string): { fn: AnyNode; text: string } | undefined {
  for (const text of [`(${code})`, `({${code}})`]) {
    let program: AnyNode;
    try {
      program = parse(text, { ecmaVersion: "latest" }) as AnyNode;
    } catch {
      continue;
    }
    let expression: AnyNode | undefined = program.body?.[0]?.expression;
    if (expression?.type === "ObjectExpression") expression = expression.properties?.[0]?.value;
    if (expression && FUNCTION_TYPES.has(expression.type)) return { fn: expression, text };
  }
  return undefined;
}

/** Calls `visit` on every node under `node`, without entering nested functions unless `deep`. */
function walk(node: AnyNode, visit: (node: AnyNode) => void, deep = false): void {
  for (const [key, value] of Object.entries(node)) {
    if (key === "start" || key === "end") continue;
    for (const child of Array.isArray(value) ? value : [value]) {
      if (!isNode(child)) continue;
      visit(child);
      if (deep || !FUNCTION_TYPES.has(child.type)) walk(child, visit, deep);
    }
  }
}

const DECLINE: unique symbol = Symbol("decline");
const UNKNOWN: unique symbol = Symbol("unknown");
type Value = AnyNode | typeof DECLINE | typeof UNKNOWN;

interface Scope {
  text: string;
  /** Local bindings declared once and never reassigned, by name. */
  constants: Map<string, AnyNode>;
  /** The names the current context goes by: `context`, `ctx` in `{ context: ctx }`, `args.context`. */
  kept: Set<string>;
}

function scopeOf(fn: AnyNode, text: string): Scope {
  const declared = new Map<string, AnyNode | null>();
  const assigned = new Set<string>();
  walk(fn.body, (node) => {
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
      declared.set(node.id.name, declared.has(node.id.name) ? null : (node.init ?? null));
    }
  });
  // Writes count from nested callbacks too: `items.forEach(() => { next = "done" })`.
  walk(
    fn.body,
    (node) => {
      if (node.type === "AssignmentExpression") {
        // `x = …` and `x.target = …` both change what `x` holds.
        const name = rootName(node.left);
        if (name) assigned.add(name);
      } else if (node.type === "UpdateExpression") {
        const name = rootName(node.argument);
        if (name) assigned.add(name);
      } else if (node.type === "UnaryExpression" && node.operator === "delete") {
        const name = rootName(node.argument);
        if (name) assigned.add(name);
      } else if (node.type === "CallExpression") {
        // A local passed to a call (`Object.assign(t, …)`) or whose method is called may be changed.
        for (const argument of node.arguments) {
          if (argument.type === "Identifier") assigned.add(argument.name);
        }
        const name =
          node.callee.type === "MemberExpression" ? rootName(node.callee.object) : undefined;
        if (name) assigned.add(name);
      }
    },
    true,
  );
  const constants = new Map<string, AnyNode>();
  for (const [name, init] of declared) {
    if (init && !assigned.has(name)) constants.set(name, init);
  }

  const kept = new Set(["context"]);
  const param: AnyNode | undefined = fn.params?.[0];
  const binding = param?.type === "AssignmentPattern" ? param.left : param;
  if (binding?.type === "Identifier") kept.add(`${binding.name}.context`);
  if (binding?.type === "ObjectPattern") {
    for (const property of binding.properties) {
      if (property.type !== "Property" || keyName(property) !== "context") continue;
      const value =
        property.value.type === "AssignmentPattern" ? property.value.left : property.value;
      if (value.type === "Identifier") kept.add(value.name);
    }
  }
  return { text, constants, kept };
}

/** The variable a reference starts from: `t` in `t`, `t.target`, `t[k].x`. */
function rootName(node: AnyNode): string | undefined {
  let current = node;
  while (current.type === "MemberExpression") current = current.object;
  return current.type === "Identifier" ? current.name : undefined;
}

const keyName = (property: AnyNode): string | undefined =>
  property.computed
    ? undefined
    : property.key.type === "Identifier"
      ? property.key.name
      : typeof property.key.value === "string"
        ? property.key.value
        : undefined;

const sourceOf = (scope: Scope, node: AnyNode) =>
  scope.text.slice(node.start, node.end).replace(/\s+/g, " ");

/** Every value `node` can evaluate to, through ternaries, `&&`/`||`/`??` and local constants. */
function values(node: AnyNode, scope: Scope, depth = 0): Value[] {
  if (depth > 20) return [UNKNOWN];
  switch (node.type) {
    case "ConditionalExpression":
      return [
        ...values(node.consequent, scope, depth + 1),
        ...values(node.alternate, scope, depth + 1),
      ];
    case "LogicalExpression":
      return node.operator === "&&"
        ? [DECLINE, ...values(node.right, scope, depth + 1)]
        : [...values(node.left, scope, depth + 1), ...values(node.right, scope, depth + 1)];
    case "SequenceExpression":
      return values(node.expressions.at(-1), scope, depth + 1);
    case "Literal":
      return node.value === null ? [DECLINE] : [node];
    case "UnaryExpression":
      return node.operator === "void" ? [DECLINE] : [UNKNOWN];
    case "Identifier": {
      if (node.name === "undefined") return [DECLINE];
      const init = scope.constants.get(node.name);
      return init ? values(init, scope, depth + 1) : [UNKNOWN];
    }
    case "ObjectExpression":
    case "TemplateLiteral":
      return [node];
    default:
      return [UNKNOWN];
  }
}

/** Every value the function returns, including `undefined` when its body can fall through. */
function returnedValues(fn: AnyNode, scope: Scope): Value[] {
  if (fn.body.type !== "BlockStatement") return values(fn.body, scope);
  const returned: Value[] = [];
  walk(fn.body, (node) => {
    if (node.type !== "ReturnStatement") return;
    if (node.argument) returned.push(...values(node.argument, scope));
    else returned.push(DECLINE);
  });
  if (completes(fn.body)) returned.push(DECLINE);
  return returned;
}

/** True when control can run past the end of `node` (so the function may return nothing). */
function completes(node: AnyNode | null | undefined): boolean {
  if (!node) return true;
  switch (node.type) {
    case "ReturnStatement":
    case "ThrowStatement":
      return false;
    case "BlockStatement":
      return node.body.every(completes);
    case "IfStatement":
      return !node.alternate || completes(node.consequent) || completes(node.alternate);
    case "TryStatement":
      if (node.finalizer && !completes(node.finalizer)) return false;
      return completes(node.block) || (node.handler ? completes(node.handler.body) : false);
    case "SwitchStatement": {
      if (!node.cases.some((c: AnyNode) => c.test === null)) return true;
      if (breaksOut(node)) return true;
      // Cases fall through, so the last case decides.
      const last: AnyNode[] = node.cases.at(-1)?.consequent ?? [];
      return last.every(completes);
    }
    default:
      return true;
  }
}

/** True when a `break` inside this switch (not in a nested loop or switch) leaves it. */
function breaksOut(node: AnyNode): boolean {
  let found = false;
  const visit = (child: AnyNode) => {
    if (found || FUNCTION_TYPES.has(child.type)) return;
    if (child.type === "BreakStatement" && !child.label) {
      found = true;
      return;
    }
    if (/^(For|ForIn|ForOf|While|DoWhile|Switch)Statement$/.test(child.type)) return;
    for (const [key, value] of Object.entries(child)) {
      if (key === "start" || key === "end") continue;
      for (const item of Array.isArray(value) ? value : [value]) if (isNode(item)) visit(item);
    }
  };
  for (const c of node.cases) for (const statement of c.consequent) visit(statement);
  return found;
}

/** The literal string a node holds, if it is one: `"done"`, `` `done` ``. */
function literalString(node: AnyNode): string | undefined {
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

/** The keys an object sets: its own, plus `…name` for a spread of anything but the current context. */
function objectKeys(node: AnyNode, scope: Scope, keys: Set<string>, depth = 0): void {
  for (const value of values(node, scope, depth)) {
    if (value === DECLINE) continue;
    if (value === UNKNOWN || value.type !== "ObjectExpression") {
      const text = value === UNKNOWN ? sourceOf(scope, node) : sourceOf(scope, value);
      if (!scope.kept.has(text)) keys.add(`…${text}`);
      continue;
    }
    for (const property of value.properties) {
      if (property.type === "SpreadElement") {
        const text = sourceOf(scope, property.argument);
        if (!scope.kept.has(text)) keys.add(`…${text}`);
        continue;
      }
      keys.add(keyName(property) ?? `[${sourceOf(scope, property.key)}]`);
    }
  }
}

/**
 * The expression an object literal's `target` ends up as, with later
 * properties and spreads overriding earlier ones: `undefined` when it sets
 * none, `UNKNOWN` when a spread that cannot be read may set it.
 */
function targetOf(object: AnyNode, scope: Scope, depth = 0): AnyNode | typeof UNKNOWN | undefined {
  let target: AnyNode | typeof UNKNOWN | undefined;
  for (const property of object.properties) {
    if (property.type === "Property") {
      if (keyName(property) === "target") target = property.value;
      continue;
    }
    const spread = depth < 20 ? values(property.argument, scope, depth + 1) : [UNKNOWN];
    if (spread.length !== 1) {
      target = UNKNOWN;
      continue;
    }
    const only = spread[0] as Value;
    if (only === DECLINE) continue;
    if (only === UNKNOWN || only.type !== "ObjectExpression") target = UNKNOWN;
    else target = targetOf(only, scope, depth + 1) ?? target;
  }
  return target;
}

/**
 * Reads a transition function: where each of its return paths goes and what
 * context it sets. `undefined` when the source does not parse.
 */
export function readTransitionSource(code: string): TransitionSource | undefined {
  const parsed = parseFunction(code);
  if (!parsed) return undefined;
  const scope = scopeOf(parsed.fn, parsed.text);
  const result: TransitionSource = {
    targets: [],
    unknown: false,
    stays: false,
    declines: false,
    context: [],
  };
  const targets = new Set<string>();
  const context = new Set<string>();
  for (const value of returnedValues(parsed.fn, scope)) {
    if (value === DECLINE) {
      result.declines = true;
      continue;
    }
    if (value === UNKNOWN || value.type !== "ObjectExpression") {
      result.unknown = true;
      continue;
    }
    const target = targetOf(value, scope);
    if (target === undefined) result.stays = true;
    else if (target === UNKNOWN) result.unknown = true;
    else {
      for (const option of values(target, scope)) {
        const literal =
          option === DECLINE || option === UNKNOWN ? undefined : literalString(option);
        if (literal !== undefined) targets.add(literal);
        else if (option === DECLINE) result.stays = true;
        else result.unknown = true;
      }
    }
    const patch = value.properties.find(
      (property: AnyNode) => property.type === "Property" && keyName(property) === "context",
    );
    if (patch) objectKeys(patch.value, scope, context);
  }
  result.targets = [...targets];
  result.context = [...context];
  return result;
}

/** The keys a context function (`({ context }) => ({ … })`) returns. `undefined` when it does not parse. */
export function readContextSource(code: string): string[] | undefined {
  const parsed = parseFunction(code);
  if (!parsed) return undefined;
  const scope = scopeOf(parsed.fn, parsed.text);
  const keys = new Set<string>();
  for (const value of returnedValues(parsed.fn, scope)) {
    if (value === DECLINE) continue;
    if (value === UNKNOWN) keys.add("…");
    else objectKeys(value, scope, keys);
  }
  return [...keys];
}

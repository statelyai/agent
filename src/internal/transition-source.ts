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

/** Calls `visit` on every node under `node`, without entering nested functions. */
function walk(node: AnyNode, visit: (node: AnyNode) => void): void {
  for (const [key, value] of Object.entries(node)) {
    if (key === "start" || key === "end") continue;
    for (const child of Array.isArray(value) ? value : [value]) {
      if (!isNode(child)) continue;
      visit(child);
      if (!FUNCTION_TYPES.has(child.type)) walk(child, visit);
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
    } else if (node.type === "AssignmentExpression" && node.left.type === "Identifier") {
      assigned.add(node.left.name);
    } else if (node.type === "UpdateExpression" && node.argument.type === "Identifier") {
      assigned.add(node.argument.name);
    }
  });
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
  const last: AnyNode | undefined = fn.body.body.at(-1);
  if (last?.type !== "ReturnStatement" && last?.type !== "ThrowStatement") returned.push(DECLINE);
  return returned;
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
    const target = value.properties.find(
      (property: AnyNode) => property.type === "Property" && keyName(property) === "target",
    );
    if (!target) result.stays = true;
    else {
      for (const option of values(target.value, scope)) {
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

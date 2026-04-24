import {
  createGraph,
  type EdgeConfig,
  type Graph as StatelyGraph,
  type GraphEdge as StatelyGraphEdge,
  type GraphNode as StatelyGraphNode,
  type NodeConfig,
} from '@statelyai/graph';
import {
  toMermaidState,
  type MermaidStateGraph,
  type StateEdgeData,
  type StateGraphData,
  type StateNodeData,
} from '@statelyai/graph/mermaid';
import ts from 'typescript';
import type {
  AgentMachine,
  MachineConfig,
  StateConfig,
  TransitionResult,
} from '../types.js';

export interface AgentGraphNodeData {
  type: 'state' | 'choice' | 'final';
}

export interface AgentGraphEdgeData {
  event?: string;
  source?: 'event' | 'invoke.done';
  guard?: {
    type: string;
  };
  actions?: {
    context?: boolean;
    input?: boolean;
  };
}

export interface AgentGraphData {
}

export interface AgentGraphWarning {
  state: string;
  event: string;
  message: string;
}

export interface AgentGraphAnalysis {
  graph: AgentGraph;
  warnings: AgentGraphWarning[];
}

export interface AgentGraph
  extends StatelyGraph<AgentGraphNodeData, AgentGraphEdgeData, AgentGraphData> {}
export interface AgentGraphNode
  extends StatelyGraphNode<AgentGraphNodeData> {}
export interface AgentGraphEdge
  extends StatelyGraphEdge<AgentGraphEdgeData> {}

type InternalMachine = AgentMachine & {
  __config?: MachineConfig<any, any, any, any, any>;
};

type EdgeCandidate = {
  target: string;
  guard?: string;
  hasContext?: boolean;
  hasInput?: boolean;
};

type AnalysisResult = {
  candidates: EdgeCandidate[];
  warnings: string[];
};

type BlockAnalysis = AnalysisResult & {
  exits: boolean;
};

type AnalyzableFunction =
  | ts.ArrowFunction
  | ts.FunctionExpression
  | ts.FunctionDeclaration;

type HelperMap = Map<string, AnalyzableFunction | ts.Expression>;
type BindingMap = Map<string, ts.Expression>;
const printer = ts.createPrinter({ removeComments: true });

/**
 * Convert an agent machine to a Stately graph-compatible plain JSON object.
 *
 * Finite states come directly from the authored `states` object. Edges are
 * inferred from static transition objects and transition handler ASTs.
 */
export function toGraph(machine: AgentMachine): AgentGraph {
  return analyzeGraph(machine).graph;
}

export function analyzeGraph(machine: AgentMachine): AgentGraphAnalysis {
  const config = (machine as InternalMachine).__config;
  if (!config) {
    throw new Error('Machine config metadata is unavailable for graph export');
  }

  const nodes: Array<NodeConfig<AgentGraphNodeData>> = Object.entries(
    config.states
  ).map(([id, state]) => ({
    id,
    label: id,
    data: {
      type: getNodeType(state as StateConfig),
    },
  }));

  const edges: Array<EdgeConfig<AgentGraphEdgeData>> = [];
  const warnings: AgentGraphWarning[] = [];
  for (const [sourceId, state] of Object.entries(config.states)) {
    const stateConfig = state as StateConfig;

    if (stateConfig.onDone) {
      const event = `done.invoke.${sourceId}`;
      const result = getTransitionEdges({
        sourceId,
        event,
        source: 'invoke.done',
        transition: stateConfig.onDone,
        ordinalOffset: edges.length,
      });
      edges.push(...result.edges);
      warnings.push(...formatWarnings(sourceId, event, result.warnings));
    }

    if (!stateConfig.on) {
      continue;
    }

    for (const [event, transition] of Object.entries(stateConfig.on)) {
      const result = getTransitionEdges({
        sourceId,
        event,
        source: 'event',
        transition,
        ordinalOffset: edges.length,
      });
      edges.push(...result.edges);
      warnings.push(...formatWarnings(sourceId, event, result.warnings));
    }
  }

  const graph = createGraph<AgentGraphNodeData, AgentGraphEdgeData, AgentGraphData>({
    id: machine.id,
    initialNodeId:
      typeof config.initial === 'string' ? config.initial : undefined,
    nodes,
    edges,
  });

  return {
    graph,
    warnings,
  };
}

export function toMermaid(machine: AgentMachine): string {
  return toMermaidState(toMermaidStateGraph(toGraph(machine)));
}

function getNodeType(state: StateConfig): AgentGraphNodeData['type'] {
  if (state.type === 'final') {
    return 'final';
  }

  if (state.type === 'choice') {
    return 'choice';
  }

  return 'state';
}

function toMermaidStateGraph(graph: AgentGraph): MermaidStateGraph {
  const nodes: Array<NodeConfig<StateNodeData>> = graph.nodes.map((node) => ({
    id: node.id,
    label: node.label,
    data: {
      ...(node.data.type === 'choice' ? { stateType: 'choice' as const } : {}),
    },
  }));

  const edges: Array<EdgeConfig<StateEdgeData>> = graph.edges.map((edge) => ({
    id: edge.id,
    sourceId: edge.sourceId,
    targetId: edge.targetId,
    label: edge.label ?? undefined,
    data: {},
  }));

  if (graph.initialNodeId) {
    const startId = `${graph.id}.__start`;
    nodes.push({
      id: startId,
      data: { isStart: true },
    });
    edges.unshift({
      id: `${startId}:initial`,
      sourceId: startId,
      targetId: graph.initialNodeId,
      data: {},
    });
  }

  for (const node of graph.nodes) {
    if (node.data.type !== 'final') {
      continue;
    }

    const endId = `${node.id}.__end`;
    nodes.push({
      id: endId,
      data: { isEnd: true },
    });
    edges.push({
      id: `${node.id}:final`,
      sourceId: node.id,
      targetId: endId,
      data: {},
    });
  }

  return createGraph<StateNodeData, StateEdgeData, StateGraphData>({
    id: graph.id,
    type: graph.type,
    initialNodeId: graph.initialNodeId ?? undefined,
    data: {
      diagramType: 'stateDiagram',
    },
    nodes,
    edges,
  });
}

function getTransitionEdges(args: {
  sourceId: string;
  event: string;
  source: NonNullable<AgentGraphEdgeData['source']>;
  transition: unknown;
  ordinalOffset: number;
}): {
  edges: Array<EdgeConfig<AgentGraphEdgeData>>;
  warnings: string[];
} {
  const result =
    typeof args.transition === 'function'
      ? analyzeTransitionFunction(args.transition)
      : analyzeTransitionObject(args.transition);

  return {
    edges: result.candidates.map((candidate, index) => ({
      id: `${args.sourceId}:${args.event}:${args.ordinalOffset + index}`,
      sourceId: args.sourceId,
      targetId: candidate.target,
      label: getEdgeLabel(args.event, candidate.guard),
      data: {
        event: args.event,
        source: args.source,
        ...(candidate.guard
          ? {
              guard: {
                type: candidate.guard,
              },
            }
          : {}),
        ...((candidate.hasContext || candidate.hasInput)
          ? {
              actions: {
                ...(candidate.hasContext ? { context: true } : {}),
                ...(candidate.hasInput ? { input: true } : {}),
              },
            }
          : {}),
      },
    })),
    warnings: result.warnings,
  };
}

function analyzeTransitionObject(transition: unknown): AnalysisResult {
  const target =
    transition && typeof transition === 'object'
      ? (transition as TransitionResult).target
      : undefined;

  if (
    transition
    && typeof transition === 'object'
    && 'target' in transition
    && typeof target === 'string'
  ) {
    return {
      candidates: [{
        target,
        hasContext: 'context' in transition,
        hasInput: 'input' in transition,
      }],
      warnings: [],
    };
  }

  return { candidates: [], warnings: [] };
}

function analyzeTransitionFunction(fn: Function): AnalysisResult {
  const source = fn
    .toString()
    .replace(/__name\([^)]*\);?/g, '');
  const file = ts.createSourceFile(
    'transition.ts',
    `const __transition = ${source};`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const transitionFunction = findTransitionFunction(file);

  if (!transitionFunction) {
    return {
      candidates: [],
      warnings: ['Unable to parse transition function.'],
    };
  }

  const helpers = collectHelpers(transitionFunction);

  if (ts.isArrowFunction(transitionFunction) && !ts.isBlock(transitionFunction.body)) {
    return analyzeTransitionExpression(
      transitionFunction.body,
      [],
      file,
      helpers,
      new Map()
    );
  }

  if (transitionFunction.body && ts.isBlock(transitionFunction.body)) {
    return analyzeStatements(
      transitionFunction.body.statements,
      [],
      file,
      helpers,
      new Map()
    );
  }

  return {
    candidates: [],
    warnings: ['Unsupported transition function body.'],
  };
}

function findTransitionFunction(file: ts.SourceFile): AnalyzableFunction | undefined {
  let transitionFunction: AnalyzableFunction | undefined;

  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === '__transition'
      && node.initializer
      && isAnalyzableFunction(node.initializer)
    ) {
      transitionFunction = node.initializer;
      return;
    }

    if (!transitionFunction) {
      ts.forEachChild(node, visit);
    }
  }

  visit(file);
  return transitionFunction;
}

function isAnalyzableFunction(node: ts.Node): node is AnalyzableFunction {
  return (
    ts.isArrowFunction(node)
    || ts.isFunctionExpression(node)
    || ts.isFunctionDeclaration(node)
  );
}

function collectHelpers(fn: AnalyzableFunction): HelperMap {
  const helpers: HelperMap = new Map();
  if (!fn.body || !ts.isBlock(fn.body)) {
    return helpers;
  }

  function visit(node: ts.Node) {
    if (
      node !== fn.body
      && isAnalyzableFunction(node)
    ) {
      return;
    }

    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      helpers.set(node.name.text, node);
      return;
    }

    if (ts.isVariableDeclaration(node)) {
      if (!ts.isIdentifier(node.name) || !node.initializer) {
        return;
      }

      const initializer = unwrapParenthesized(node.initializer);
      if (
        isAnalyzableFunction(initializer)
        || ts.isObjectLiteralExpression(initializer)
        || ts.isConditionalExpression(initializer)
      ) {
        helpers.set(node.name.text, initializer);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(fn.body);

  return helpers;
}

function analyzeStatements(
  statements: ts.NodeArray<ts.Statement>,
  guards: string[],
  file: ts.SourceFile,
  helpers: HelperMap,
  bindings: BindingMap
): BlockAnalysis {
  const candidates: EdgeCandidate[] = [];
  const warnings: string[] = [];
  const fallthroughGuards = [...guards];

  for (const statement of statements) {
    const result = analyzeStatement(
      statement,
      fallthroughGuards,
      file,
      helpers,
      bindings
    );
    candidates.push(...result.candidates);
    warnings.push(...result.warnings);

    if (result.exits) {
      return { candidates, warnings, exits: true };
    }

    if (
      ts.isIfStatement(statement)
      && isReturnOnlyBranch(statement.thenStatement)
      && !statement.elseStatement
    ) {
      fallthroughGuards.push(
        `!(${renderExpressionText(statement.expression, file, bindings)})`
      );
    }
  }

  return { candidates, warnings, exits: false };
}

function analyzeStatement(
  statement: ts.Statement,
  guards: string[],
  file: ts.SourceFile,
  helpers: HelperMap,
  bindings: BindingMap
): BlockAnalysis {
  if (ts.isReturnStatement(statement)) {
    if (!statement.expression) {
      return {
        candidates: [],
        warnings: ['Return statement has no transition object.'],
        exits: true,
      };
    }

    const result = analyzeTransitionExpression(
      statement.expression,
      guards,
      file,
      helpers,
      bindings
    );

    return {
      candidates: result.candidates,
      warnings:
        result.candidates.length === 0 && result.warnings.length === 0
          ? [
              `Unsupported transition return expression: ${statement.expression.getText(file)}`,
            ]
          : result.warnings,
      exits: true,
    };
  }

  if (ts.isIfStatement(statement)) {
    return analyzeIfStatement(statement, guards, file, helpers, bindings);
  }

  if (ts.isSwitchStatement(statement)) {
    return analyzeSwitchStatement(statement, guards, file, helpers, bindings);
  }

  if (
    ts.isVariableStatement(statement)
    || ts.isFunctionDeclaration(statement)
    || ts.isEmptyStatement(statement)
  ) {
    return { candidates: [], warnings: [], exits: false };
  }

  return {
    candidates: [],
    warnings: [`Unsupported transition statement: ${statement.getText(file)}`],
    exits: false,
  };
}

function analyzeIfStatement(
  statement: ts.IfStatement,
  guards: string[],
  file: ts.SourceFile,
  helpers: HelperMap,
  bindings: BindingMap
): BlockAnalysis {
  const condition = renderExpressionText(statement.expression, file, bindings);
  const thenResult = analyzeBranch(
    statement.thenStatement,
    [...guards, condition],
    file,
    helpers,
    bindings
  );
  const elseResult = statement.elseStatement
    ? analyzeBranch(
        statement.elseStatement,
        [...guards, `!(${condition})`],
        file,
        helpers,
        bindings
      )
    : emptyBlockAnalysis();

  return {
    candidates: [...thenResult.candidates, ...elseResult.candidates],
    warnings: [...thenResult.warnings, ...elseResult.warnings],
    exits: thenResult.exits && !!statement.elseStatement && elseResult.exits,
  };
}

function analyzeSwitchStatement(
  statement: ts.SwitchStatement,
  guards: string[],
  file: ts.SourceFile,
  helpers: HelperMap,
  bindings: BindingMap
): BlockAnalysis {
  const candidates: EdgeCandidate[] = [];
  const warnings: string[] = [];
  const expression = renderExpressionText(statement.expression, file, bindings);
  const caseGuards: string[] = [];
  let allClausesExit = statement.caseBlock.clauses.length > 0;

  for (const clause of statement.caseBlock.clauses) {
    const clauseGuard = ts.isCaseClause(clause)
      ? `${expression} === ${clause.expression.getText(file)}`
      : caseGuards.length > 0
        ? caseGuards.map((guard) => `!(${guard})`).join(' && ')
        : undefined;

    if (clauseGuard) {
      caseGuards.push(clauseGuard);
    }

    const result = analyzeStatements(
      clause.statements,
      clauseGuard ? [...guards, clauseGuard] : guards,
      file,
      helpers,
      bindings
    );
    candidates.push(...result.candidates);
    warnings.push(...result.warnings);
    allClausesExit = allClausesExit && result.exits;
  }

  return {
    candidates,
    warnings,
    exits: allClausesExit,
  };
}

function analyzeBranch(
  statement: ts.Statement,
  guards: string[],
  file: ts.SourceFile,
  helpers: HelperMap,
  bindings: BindingMap
): BlockAnalysis {
  if (ts.isBlock(statement)) {
    return analyzeStatements(statement.statements, guards, file, helpers, bindings);
  }

  return analyzeStatement(statement, guards, file, helpers, bindings);
}

function emptyBlockAnalysis(): BlockAnalysis {
  return {
    candidates: [],
    warnings: [],
    exits: false,
  };
}

function isReturnOnlyBranch(statement: ts.Statement): boolean {
  if (ts.isReturnStatement(statement)) {
    return true;
  }

  return (
    ts.isBlock(statement)
    && statement.statements.length === 1
    && !!statement.statements[0]
    && ts.isReturnStatement(statement.statements[0])
  );
}

function analyzeTransitionExpression(
  expression: ts.Expression,
  guards: string[],
  file: ts.SourceFile,
  helpers: HelperMap,
  bindings: BindingMap
): AnalysisResult {
  const current = unwrapParenthesized(expression);

  if (ts.isConditionalExpression(current)) {
    const condition = renderExpressionText(current.condition, file, bindings);

    return mergeAnalysis([
      analyzeTransitionExpression(
        current.whenTrue,
        [...guards, condition],
        file,
        helpers,
        bindings
      ),
      analyzeTransitionExpression(
        current.whenFalse,
        [...guards, `!(${condition})`],
        file,
        helpers,
        bindings
      ),
    ]);
  }

  if (
    ts.isCallExpression(current)
    && ts.isIdentifier(current.expression)
  ) {
    const fallbackHelper = findHelperByName(file, current.expression.text);
    const helper =
      helpers.get(current.expression.text)
      ?? fallbackHelper;
    if (!helper) {
      return {
        candidates: [],
        warnings: [
          `Unsupported helper call: ${current.expression.text}(${current.arguments.map((arg) => renderExpressionText(arg, file, bindings)).join(', ')}) is not statically resolvable.`,
        ],
      };
    }

    return analyzeHelper(
      helper,
      current.arguments,
      guards,
      file,
      helpers,
      bindings
    );
  }

  const object = unwrapParenthesizedObject(current);
  const target = object
    ? getStringProperty(object, 'target', file, bindings)
    : undefined;
  if (!target) {
    return { candidates: [], warnings: [] };
  }

  return {
    candidates: [{
      target,
      guard: combineGuardList(guards),
      hasContext: object ? hasProperty(object, 'context') : false,
      hasInput: object ? hasProperty(object, 'input') : false,
    }],
    warnings: [],
  };
}

function analyzeHelper(
  helper: AnalyzableFunction | ts.Expression,
  args: ts.NodeArray<ts.Expression>,
  guards: string[],
  file: ts.SourceFile,
  helpers: HelperMap,
  bindings: BindingMap
): AnalysisResult {
  if (isAnalyzableFunction(helper)) {
    const helperBindings = createBindings(helper, args, bindings);
    if (!helperBindings) {
      return {
        candidates: [],
        warnings: [
          `Unsupported helper call: argument count for ${getHelperName(helper)}(...) could not be matched.`,
        ],
      };
    }

    if (ts.isArrowFunction(helper) && !ts.isBlock(helper.body)) {
      return analyzeTransitionExpression(
        helper.body,
        guards,
        file,
        helpers,
        helperBindings
      );
    }

    if (helper.body && ts.isBlock(helper.body)) {
      const result = analyzeStatements(
        helper.body.statements,
        guards,
        file,
        helpers,
        helperBindings
      );
      return {
        candidates: result.candidates,
        warnings: result.warnings,
      };
    }
  }

  if (ts.isExpression(helper)) {
    if (args.length > 0) {
      return {
        candidates: [],
        warnings: ['Unsupported helper call: non-function helper cannot accept arguments.'],
      };
    }

    return analyzeTransitionExpression(helper, guards, file, helpers, bindings);
  }

  return {
    candidates: [],
    warnings: ['Unsupported helper body.'],
  };
}

function mergeAnalysis(results: AnalysisResult[]): AnalysisResult {
  return {
    candidates: results.flatMap((result) => result.candidates),
    warnings: results.flatMap((result) => result.warnings),
  };
}

function unwrapParenthesized<T extends ts.Expression>(expression: T): ts.Expression {
  let current: ts.Expression = expression;

  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }

  return current;
}

function findHelperByName(
  file: ts.SourceFile,
  name: string
): AnalyzableFunction | ts.Expression | undefined {
  let helper: AnalyzableFunction | ts.Expression | undefined;

  function visit(node: ts.Node) {
    if (helper) {
      return;
    }

    if (
      ts.isFunctionDeclaration(node)
      && node.name?.text === name
      && node.body
    ) {
      helper = node;
      return;
    }

    if (ts.isVariableDeclaration(node)) {
      if (!ts.isIdentifier(node.name) || node.name.text !== name || !node.initializer) {
        ts.forEachChild(node, visit);
        return;
      }

      const initializer = unwrapParenthesized(node.initializer);
      if (
        isAnalyzableFunction(initializer)
        || ts.isObjectLiteralExpression(initializer)
        || ts.isConditionalExpression(initializer)
      ) {
        helper = initializer;
        return;
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(file);
  return helper;
}

function unwrapParenthesizedObject(
  expression: ts.Expression
): ts.ObjectLiteralExpression | undefined {
  let current = expression;

  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }

  return ts.isObjectLiteralExpression(current) ? current : undefined;
}

function getStringProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
  file: ts.SourceFile,
  bindings: BindingMap
): string | undefined {
  const property = object.properties.find((candidate) => {
    return (
      (ts.isPropertyAssignment(candidate)
        || ts.isShorthandPropertyAssignment(candidate))
      && ts.isIdentifier(candidate.name)
      && candidate.name.text === name
    );
  });

  if (!property) {
    return undefined;
  }

  if (ts.isPropertyAssignment(property)) {
    return resolveStringExpression(property.initializer, file, bindings);
  }

  if (ts.isShorthandPropertyAssignment(property)) {
    const binding = bindings.get(property.name.text);
    if (!binding) {
      return property.name.text;
    }

    return resolveStringExpression(binding, file, bindings);
  }

  return undefined;
}

function hasProperty(object: ts.ObjectLiteralExpression, name: string): boolean {
  return object.properties.some((candidate) => {
    return (
      (ts.isPropertyAssignment(candidate)
        || ts.isShorthandPropertyAssignment(candidate))
      && ts.isIdentifier(candidate.name)
      && candidate.name.text === name
    );
  });
}

function getEdgeLabel(event: string, guard: string | undefined): string {
  if (!guard) {
    return event;
  }

  return `${event} [${guard}]`;
}

function createBindings(
  helper: AnalyzableFunction,
  args: ts.NodeArray<ts.Expression>,
  parentBindings: BindingMap
): BindingMap | null {
  if (args.length > helper.parameters.length) {
    return null;
  }

  const bindings = new Map(parentBindings);
  helper.parameters.forEach((parameter, index) => {
    if (!ts.isIdentifier(parameter.name)) {
      return;
    }

    const arg = args[index];
    if (arg) {
      bindings.set(parameter.name.text, substituteExpression(arg, parentBindings));
    }
  });

  return bindings;
}

function getHelperName(helper: AnalyzableFunction): string {
  if (helper.name) {
    return helper.name.text;
  }

  return 'helper';
}

function resolveStringExpression(
  expression: ts.Expression,
  file: ts.SourceFile,
  bindings: BindingMap
): string | undefined {
  const current = substituteExpression(unwrapParenthesized(expression), bindings);

  if (ts.isStringLiteralLike(current)) {
    return current.text;
  }

  if (ts.isNoSubstitutionTemplateLiteral(current)) {
    return current.text;
  }

  if (ts.isIdentifier(current)) {
    return current.text;
  }

  const rendered = renderExpressionText(current, file, bindings);
  return /^["'`](.*)["'`]$/s.test(rendered)
    ? rendered.slice(1, -1)
    : undefined;
}

function renderExpressionText(
  expression: ts.Expression,
  file: ts.SourceFile,
  bindings: BindingMap
): string {
  const substituted = substituteExpression(unwrapParenthesized(expression), bindings);
  return printer.printNode(ts.EmitHint.Unspecified, substituted, file);
}

function substituteExpression(
  expression: ts.Expression,
  bindings: BindingMap
): ts.Expression {
  if (bindings.size === 0) {
    return expression;
  }

  const transformed = ts.transform(expression, [
    (context) => {
      const visit: ts.Visitor = (node) => {
        if (ts.isIdentifier(node) && bindings.has(node.text)) {
          return substituteExpression(bindings.get(node.text)!, bindings);
        }

        return ts.visitEachChild(node, visit, context);
      };

      return (node) => ts.visitNode(node, visit) as ts.Expression;
    },
  ]);

  const substituted = transformed.transformed[0] as ts.Expression;
  transformed.dispose();
  return substituted;
}

function combineGuardList(guards: string[]): string | undefined {
  if (guards.length === 0) {
    return undefined;
  }

  return guards
    .map((guard) => guards.length === 1 ? guard : `(${guard})`)
    .join(' && ');
}

function formatWarnings(
  state: string,
  event: string,
  warnings: string[]
): AgentGraphWarning[] {
  return warnings.map((message) => ({
    state,
    event,
    message,
  }));
}

/**
 * The example catalog.
 *
 * Inclusion rule: every example that can run without an API key is listed here,
 * and nothing else. Concretely, an example directory belongs in this file when
 * its `index.ts` exports a runnable `run<Name>Example` entry point (some
 * examples name that entry point `main`, and are re-exported under a
 * `run<Name>Example` alias below) and its `metadata.json` does NOT set
 * `manual: true`.
 *
 * Hosts marked `manual: true` are deliberately absent: they need a provider
 * key, a Workers/Next runtime, or a running framework, so they cannot be
 * imported or executed from a plain test process. They are still documented in
 * README.md. `examples/suspension.test.ts` walks the same rule off the
 * filesystem, so an example added here but marked manual (or the reverse) is a
 * bug in one of the two.
 *
 * Names are unique across the catalog. Where two examples export the same
 * symbol, the later one is aliased at the point of export and the reason is
 * noted inline.
 */

// --- Start here -------------------------------------------------------------

export {
  draftEmail,
  emailDrafterActors,
  emailDrafter,
  emailDrafterSchemas,
  evaluatePrompt,
} from "./email-drafter/index.js";
export { plainWriterMachine, runPlainXstateExample } from "./plain-xstate/index.js";
export { supportMachine, runRetrofitExample } from "./retrofit/index.js";
export {
  jsonAgentMachine,
  runJsonAgentDemo,
  workflowConfig as jsonAgentWorkflowConfig,
} from "./json-agent/index.js";
export { triageMachine, triageSchemas, triageSchema } from "./triage/index.js";

// --- Control flow a loop can't express --------------------------------------

export { twentyQuestionsMachine, twentyQuestionsSchemas } from "./twenty-questions/index.js";
export {
  guardrailsMachine,
  guardrailsSchemas,
  main as runGuardrailsExample,
} from "./guardrails/index.js";
export { jokeActors, jokeMachine, jokeSchemas, rateJoke, tellJoke } from "./joke/index.js";
export { reflectionWriterMachine, runReflectionWriterExample } from "./reflection-writer/index.js";
export {
  planFrom,
  roadNetwork,
  routeReplanningMachine,
  runRouteReplanningExample,
} from "./route-replanning/index.js";
export {
  codeAssistantMachine,
  executeCode,
  runCodeAssistantExample,
} from "./code-assistant/index.js";
export { correctiveRagMachine, runCorrectiveRagExample } from "./corrective-rag/index.js";
export {
  describeMachine,
  riverCrossingMachine,
  riverCrossingSchemas,
  runRiverCrossingExample,
} from "./river-crossing/index.js";
export {
  todoMachine,
  todoSchemas,
  runTodoNlExample,
  // `todo-nl` exports both a programmatic runner and an interactive readline
  // demo; the demo is the `main` one.
  main as runTodoNlDemo,
} from "./todo-nl/index.js";
export {
  contextCompactionMachine,
  contextCompactionSchemas,
  main as runContextCompactionExample,
} from "./context-compaction/index.js";
export {
  chatWithPdfMachine,
  chatWithPdfSchemas,
  queryPdfContent,
  main as runChatWithPdfExample,
} from "./chat-with-pdf/index.js";
export {
  rpsMachine,
  rpsSchemas,
  runRpsExample,
  renderHistory as renderRpsHistory,
} from "./game-agent/index.js";
export {
  playerAgentMachine,
  // `gameMachine` is already taken by the ai-sdk-host combat machine.
  gameMachine as gameLoopMachine,
  runGameLoopExample,
} from "./game-loop-agent/index.js";
export {
  adaptiveRagMachine,
  adaptiveRagSchemas,
  runAdaptiveRagExample,
} from "./adaptive-rag/index.js";
export { agenticRagMachine, agenticRagSchemas, runAgenticRagExample } from "./agentic-rag/index.js";
export {
  selfDiscoverMachine,
  selfDiscoverSchemas,
  REASONING_MODULES,
  runSelfDiscoverExample,
} from "./self-discover/index.js";
export { reflexionMachine, reflexionSchemas, runReflexionExample } from "./reflexion/index.js";
export {
  treeOfThoughtsMachine,
  treeOfThoughtsSchemas,
  scoreSteps as scoreGameOf24Steps,
  runTreeOfThoughtsExample,
} from "./tree-of-thoughts/index.js";
export {
  promptChainingMachine,
  promptChainingSchemas,
  hasPunchline,
  runPromptChainingExample,
} from "./prompt-chaining/index.js";
export {
  dataEnrichmentMachine,
  dataEnrichmentSchemas,
  runDataEnrichmentExample,
} from "./data-enrichment/index.js";
export { tntLlmMachine, tntLlmSchemas, runTntLlmExample } from "./tnt-llm/index.js";
export {
  toolRetrievalMachine,
  toolRetrievalSchemas,
  runToolRetrievalExample,
} from "./tool-retrieval/index.js";
export {
  modelFallbackMachine,
  modelFallbackSchemas,
  runModelFallbackExample,
} from "./model-fallback/index.js";
export {
  projectPlannerMachine,
  projectPlannerSchemas,
  criticalPath,
  graphProblems,
  runProjectPlannerExample,
} from "./project-planner/index.js";

// --- Human in the loop ------------------------------------------------------

export { humanInTheLoopMachine, runHumanInTheLoopExample } from "./human-in-the-loop/index.js";
export {
  reviewToolCallsMachine,
  runReviewToolCallsExample,
  // Second variant in the same example: the SDK owns the tool loop.
  toolCallingMachine,
  runToolCallingExample,
} from "./review-tool-calls/index.js";
export { customerSupportMachine, runCustomerSupportExample } from "./customer-support/index.js";
export { sqlAgentMachine, runSqlAgentExample } from "./sql-agent/index.js";
export {
  longRunningOnboardingMachine,
  runLongRunningOnboardingExample,
} from "./long-running-onboarding/index.js";
export {
  refundMachine,
  runMachineAsToolExample,
  startTool,
  resumeTool,
} from "./machine-as-tool/index.js";
export {
  infoGatheringMachine,
  infoGatheringSchemas,
  runInfoGatheringExample,
} from "./info-gathering/index.js";
export {
  longTermMemoryMachine,
  longTermMemorySchemas,
  searchMemoryStore,
  runLongTermMemoryExample,
} from "./long-term-memory/index.js";
export {
  feynmanTutorMachine,
  feynmanTutorSchemas,
  runFeynmanTutorExample,
} from "./feynman-tutor/index.js";

// --- Parallel and multi-agent -----------------------------------------------

export {
  hierarchicalTeamsMachine,
  researchTeamMachine,
  runHierarchicalTeamsExample,
  writingTeamMachine,
} from "./hierarchical-teams/index.js";
export { swarmHandoffMachine, runSwarmHandoffExample } from "./swarm-handoff/index.js";
export { deepResearchMachine, runDeepResearchExample } from "./deep-research/index.js";
export { planAndExecuteMachine, runPlanAndExecuteExample } from "./plan-and-execute/index.js";
export { parallelStreamsMachine, runParallelStreamsExample } from "./parallel-streams/index.js";
export {
  justOneMachine,
  justOneSchemas,
  judgeClues,
  main as runJustOneExample,
} from "./just-one/index.js";
export {
  chameleonMachine,
  chameleonSchemas,
  PLAYERS as CHAMELEON_PLAYERS,
  main as runChameleonExample,
} from "./chameleon/index.js";
export {
  agentSupervisorMachine,
  agentSupervisorSchemas,
  // Flat supervisor workers; hierarchical-teams exports its own team machines.
  researcherMachine as supervisedResearcherMachine,
  coderMachine as supervisedCoderMachine,
  runAgentSupervisorExample,
} from "./agent-supervisor/index.js";
export {
  mapReduceMachine,
  mapReduceSchemas,
  writeJoke as mapReduceWriteJoke,
  runMapReduceExample,
} from "./map-reduce/index.js";
export {
  llmCompilerMachine,
  llmCompilerSchemas,
  runLlmCompilerExample,
} from "./llm-compiler/index.js";
export {
  stormWriterMachine,
  stormWriterSchemas,
  interviewMachine as stormInterviewMachine,
  runStormWriterExample,
} from "./storm-writer/index.js";
export {
  multiAgentDebateMachine,
  multiAgentDebateSchemas,
  runMultiAgentDebateExample,
} from "./multi-agent-debate/index.js";

// --- Persistence and recovery -----------------------------------------------

export {
  crashRecoveryMachine,
  runUntilCrash,
  recover as recoverFromCrash,
} from "./crash-recovery/index.js";
export {
  orderApprovalMachine,
  orderApprovalMachineV1,
  migrateOrderSnapshot,
  runSnapshotMigrationExample,
} from "./snapshot-migration/index.js";
export { portableLoopMachine, runPortableXstateLoop } from "./portable-xstate-loop/index.js";
export {
  loadSnapshot,
  runFileSnapshotStoreExample,
  saveSnapshot,
  // Second half of the same example: an actor the application keeps alive
  // instead of persisting.
  runLongLivedActor,
} from "./file-snapshot-store/index.js";

// --- Hosts and adapters -----------------------------------------------------

export {
  gameMachine,
  gameSchemas,
  gameActors,
  chooseMoveInput,
  summarizeTurn,
  turnSummarySchema,
  runAiSdkHostExample,
} from "./ai-sdk-host/index.js";
export {
  aiSdkUiStreamMachine,
  agentRunToUIMessageStream,
  handleChatRequest,
  runAiSdkUiStreamExample,
} from "./ai-sdk-ui-stream/index.js";

// --- Evals and verification -------------------------------------------------

export {
  APPROVAL_THRESHOLD,
  // `refundMachine` is already taken by machine-as-tool.
  refundMachine as verifiedRefundMachine,
  verificationSchemas,
  main as runVerificationExample,
} from "./verification/index.js";
export {
  aiSdkEvaluatorOptimizerMachine,
  runAiSdkEvaluatorOptimizerExample,
} from "./ai-sdk-evaluator-optimizer/index.js";
export {
  generateAndRepairMachine,
  parseConfigActor,
  parseGeneratedConfig,
  runGenerateAndRepairExample,
} from "./generate-and-repair/index.js";
export {
  chatbotSimulationEvalMachine,
  chatbotSimulationEvalSchemas,
  runChatbotSimulationEvalExample,
} from "./chatbot-simulation-eval/index.js";
export {
  essayGraderMachine,
  essayGraderSchemas,
  runEssayGraderExample,
} from "./essay-grader/index.js";

// --- Statechart policies ----------------------------------------------------

export { consensusReviewMachine, runConsensusReviewExample } from "./consensus-review/index.js";
export {
  bookingCompensationMachine,
  runBookingCompensationExample,
} from "./booking-compensation/index.js";

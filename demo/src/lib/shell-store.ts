import { createStore } from "@xstate/store";
import type { ChatTurnResult, Turn } from "@/components/app-panel";
import type { ChatIdle, Json } from "./machine-ui";
import type { Selection } from "./selection";

export type Theme = "light" | "dark";
export type MobileView = "app" | "machine";

/** A settled result from either run path (curated scenario or library example). */
export type AnyRunResult = ChatTurnResult & { idle?: ChatIdle & { snapshot: Json } };

type ShellContext = {
  selection: Selection;
  machineIndex: number;
  theme: Theme;
  switcherOpen: boolean;
  switcherQuery: string;
  mobileView: MobileView;
  turns: Turn[];
  pendingIdle: ChatIdle | null;
  /** Snapshot to resume from while the machine idles awaiting human input. */
  idleSnapshot: Json | null;
  /**
   * Run generation. Bumped on every reset/selection change; async settle events
   * carry the epoch they started under and are dropped on mismatch.
   */
  epoch: number;
  /** Monotonic turn id source (also the settle correlation id). */
  nextTurnId: number;
};

type ShellEvents = {
  exampleSelected: { selection: Selection };
  machineSelected: { index: number };
  themeToggled: {};
  switcherToggled: {};
  switcherClosed: {};
  switcherQueryChanged: { query: string };
  mobileViewChanged: { view: MobileView };
  runReset: {};
  /** Appends a loading turn. The id to use is `context.nextTurnId` (read before triggering). */
  turnPushed: {
    id: number;
    input: string;
    role: Turn["role"];
    status: Turn["status"];
    eventType?: string;
  };
  turnSettled: { epoch: number; id: number; result: AnyRunResult };
  turnFailed: { epoch: number; id: number; message: string };
};

const themeStorageKey = "stately-agent-demo-theme";

export function readStoredTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const stored = window.localStorage.getItem(themeStorageKey);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function persistTheme(theme: Theme) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(themeStorageKey, theme);
  document.documentElement.toggleAttribute("data-dark", theme === "dark");
}

function resetRunState(context: ShellContext): ShellContext {
  return {
    ...context,
    turns: [],
    pendingIdle: null,
    idleSnapshot: null,
    epoch: context.epoch + 1,
  };
}

export function createShellStore(initialSelection: Selection, initialTheme: Theme = "light") {
  return createStore<ShellContext, ShellEvents, {}>({
    context: {
      selection: initialSelection,
      machineIndex: 0,
      theme: initialTheme,
      switcherOpen: false,
      switcherQuery: "",
      mobileView: "app",
      turns: [],
      pendingIdle: null,
      idleSnapshot: null,
      epoch: 0,
      nextTurnId: 1,
    },
    on: {
      exampleSelected: (context, event) => ({
        ...resetRunState(context),
        selection: event.selection,
        machineIndex: 0,
        switcherOpen: false,
        switcherQuery: "",
        mobileView: "app",
      }),
      machineSelected: (context, event) => ({
        ...resetRunState(context),
        machineIndex: event.index,
      }),
      themeToggled: (context) => {
        const theme: Theme = context.theme === "dark" ? "light" : "dark";
        persistTheme(theme);
        return { ...context, theme };
      },
      switcherToggled: (context) => ({
        ...context,
        switcherOpen: !context.switcherOpen,
        switcherQuery: "",
      }),
      switcherClosed: (context) =>
        context.switcherOpen ? { ...context, switcherOpen: false, switcherQuery: "" } : context,
      switcherQueryChanged: (context, event) => ({ ...context, switcherQuery: event.query }),
      mobileViewChanged: (context, event) => ({ ...context, mobileView: event.view }),
      runReset: resetRunState,
      turnPushed: (context, event) => ({
        ...context,
        nextTurnId: Math.max(context.nextTurnId, event.id) + 1,
        turns: [
          ...context.turns,
          {
            id: event.id,
            input: event.input,
            role: event.role,
            status: event.status,
            eventType: event.eventType,
          },
        ],
        // Sending anything consumes the pending idle affordances.
        pendingIdle: event.status === "loading" ? null : context.pendingIdle,
      }),
      turnSettled: (context, event) => {
        if (event.epoch !== context.epoch) return context;
        const idle = event.result.status === "idle" ? (event.result.idle ?? null) : null;
        let pendingIdle: ChatIdle | null = null;
        let idleSnapshot: Json | null = null;
        if (idle) {
          const { snapshot, ...rest } = idle;
          pendingIdle = rest;
          idleSnapshot = snapshot;
        }
        return {
          ...context,
          turns: context.turns.map((turn) =>
            turn.id === event.id ? { ...turn, status: "ready", result: event.result } : turn,
          ),
          pendingIdle,
          idleSnapshot,
        };
      },
      turnFailed: (context, event) => {
        if (event.epoch !== context.epoch) return context;
        return {
          ...context,
          turns: context.turns.map((turn) =>
            turn.id === event.id ? { ...turn, status: "error", error: event.message } : turn,
          ),
        };
      },
    },
  });
}

export type ShellStore = ReturnType<typeof createShellStore>;

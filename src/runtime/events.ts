export interface JournalEvent {
  type: 'xstate.init' | (string & {});
  at: number;
  sessionId?: string;
  sequence?: number;
  [key: string]: unknown;
}

export interface JournalEvent {
  sessionId: string;
  sequence: number;
  type: 'xstate.init' | (string & {});
  at: number;
  [key: string]: unknown;
}

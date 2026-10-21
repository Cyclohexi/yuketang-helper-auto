export type UpdatePhase =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'current'
  | 'error';

export interface AppUpdateState {
  readonly phase: UpdatePhase;
  readonly mode: 'portable' | 'unsupported';
  readonly currentVersion: string;
  readonly latestVersion?: string;
  readonly progress?: number;
  readonly retryAttempt?: number;
  readonly message: string;
}

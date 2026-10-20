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
  readonly mode: 'portable' | 'installed' | 'unsupported';
  readonly currentVersion: string;
  readonly latestVersion?: string;
  readonly progress?: number;
  readonly message: string;
}

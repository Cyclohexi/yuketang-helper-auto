export interface CourseBrushConfig {
  readonly playbackRate: number;
  readonly muteAudio: boolean;
  readonly enableVideo: boolean;
  readonly enableCourseware: boolean;
  readonly enableReplay: boolean;
  readonly enableDiscussion: boolean;
  readonly enableHomework: boolean;
  readonly autoSubmitHomework: boolean;
}

export const DefaultCourseBrushConfig: CourseBrushConfig = {
  playbackRate: 2,
  muteAudio: true,
  enableVideo: true,
  enableCourseware: true,
  enableReplay: true,
  enableDiscussion: true,
  enableHomework: true,
  autoSubmitHomework: true,
};

export type CourseBrushRunStatus = 'idle' | 'running' | 'paused' | 'stopping';

export type CourseBrushPageRoute =
  | 'v2-student-log'
  | 'v2-homework'
  | 'pro-lms-directory'
  | 'pro-lms-content'
  | 'ai-workspace'
  | 'classroom-replay'
  | 'unknown';

export type CourseBrushQuestionKind =
  | 'single'
  | 'multiple'
  | 'judge'
  | 'blank'
  | 'subjective'
  | 'unknown';

export interface CourseBrushDetectedOption {
  readonly index: number;
  readonly label: string;
  readonly text: string;
  readonly selected: boolean;
}

export interface CourseBrushQuestionProbe {
  readonly found: boolean;
  readonly route: CourseBrushPageRoute;
  readonly questionIndex: number;
  readonly totalQuestions: number;
  readonly questionType: CourseBrushQuestionKind;
  readonly typeLabel: string;
  readonly stemText: string;
  readonly hasEncryptedFont: boolean;
  readonly alreadyAnswered: boolean;
  readonly options: readonly CourseBrushDetectedOption[];
  readonly blankCount: number;
  readonly submitButtonText: string | null;
  readonly canSubmit: boolean;
  readonly rect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  } | null;
  readonly screenshotDataUrl?: string;
}

export interface CourseBrushPageProbe {
  readonly url: string;
  readonly title: string;
  readonly route: CourseBrushPageRoute;
  readonly routeLabel: string;
  readonly directoryItemsTotal: number;
  readonly directoryItemsPending: number;
  readonly directorySampleTitles: readonly string[];
  readonly mediaStatus: {
    readonly hasVideo: boolean;
    readonly hasAudio: boolean;
    readonly paused: boolean | null;
    readonly playbackRate: number | null;
    readonly progressText: string | null;
    readonly completed: boolean;
  };
  readonly questionProbe: CourseBrushQuestionProbe;
}

export interface CourseBrushLogItem {
  readonly id: number;
  readonly timestamp: string;
  readonly level: 'info' | 'success' | 'warn' | 'error';
  readonly message: string;
  readonly details?: string;
}

export interface CourseBrushAiResult {
  readonly questionTitle: string;
  readonly questionType: CourseBrushQuestionKind;
  readonly answerText: string;
  readonly explanation: string;
  readonly rawText: string;
  readonly applied: boolean;
  readonly submitted: boolean;
}

export interface CourseBrushState {
  readonly status: CourseBrushRunStatus;
  readonly config: CourseBrushConfig;
  readonly currentRoute: CourseBrushPageRoute;
  readonly currentTaskTitle: string;
  readonly completedCount: number;
  readonly answeredQuestionCount: number;
  readonly parentTabId: string | null;
  readonly activeTaskTabId: string | null;
  readonly lastProbe: CourseBrushPageProbe | null;
  readonly lastAiAnswer: CourseBrushAiResult | null;
  readonly logs: readonly CourseBrushLogItem[];
}

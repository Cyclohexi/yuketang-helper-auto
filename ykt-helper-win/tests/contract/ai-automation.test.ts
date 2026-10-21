import { effectScope, nextTick, reactive } from 'vue';
import type * as Vue from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BrowserEnvironment,
  DefaultAppSettings,
  ProblemType,
  type AnswerProposal,
  type AppSettings,
  type ProblemContext,
} from '@ykt/contracts';
import AssistantPanel from '../../apps/desktop/renderer/src/components/AssistantPanel.vue';

vi.mock('vue', async (importOriginal) => ({
  ...(await importOriginal<typeof Vue>()),
  onMounted: vi.fn(),
  onUnmounted: vi.fn(),
  useSSRContext: () => ({ modules: new Set() }),
}));

const scopes: ReturnType<typeof effectScope>[] = [];

afterEach(() => {
  scopes.splice(0).forEach((scope) => scope.stop());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('LLM automation settings', () => {
  it('waits for publication when the independent preanalysis switch is off', async () => {
    const { panel, api, problem } = setupPanel({
      llmAutoGenerate: true,
      llmManagedSubmit: true,
      aiPreanalysisEnabled: false,
    });
    problem.status = 'locked';
    await panel.loadLessonData();
    await vi.runAllTimersAsync();
    expect(api.generateAnswerProposal).not.toHaveBeenCalled();
    problem.status = 'available';
    await panel.automationTick();
    await vi.runAllTimersAsync();
    expect(api.generateAnswerProposal).toHaveBeenCalledOnce();
    expect(api.submitAnswer).toHaveBeenCalledOnce();
  });

  it('analyzes an expired unanswered question and tries force submission once', async () => {
    const { panel, api, problem } = setupPanel({
      llmAutoGenerate: true,
      llmManagedSubmit: true,
      autoForceRetryEnabled: true,
    });
    problem.status = 'expired';
    problem.deadlineAt = Date.now() - 1000;
    await panel.automationTick();
    await vi.runAllTimersAsync();
    await panel.automationTick();
    await vi.runAllTimersAsync();
    expect(api.generateAnswerProposal).toHaveBeenCalledOnce();
    expect(api.submitAnswer).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        problemId: problem.id,
        forceRetry: true,
        confirmedBy: 'agent',
      }),
    );
  });

  it('uses the cached answer when analysis finishes after the deadline with forced retry enabled', async () => {
    const { panel, api, problem, proposal } = setupPanel({
      llmAutoGenerate: true,
      llmManagedSubmit: true,
      autoForceRetryEnabled: true,
    });
    let resolve!: (value: AnswerProposal) => void;
    api.generateAnswerProposal.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    problem.deadlineAt = Date.now() + 2000;
    await panel.onAvailableProblem(problem);
    await vi.advanceTimersByTimeAsync(2500);
    resolve(proposal);
    await vi.runAllTimersAsync();
    expect(api.generateAnswerProposal).toHaveBeenCalledOnce();
    expect(api.submitAnswer).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ forceRetry: true }),
    );
  });

  it('attempts force submission after a normal submission fails and the deadline passes', async () => {
    const { panel, api, problem } = setupPanel({
      llmAutoGenerate: true,
      llmManagedSubmit: true,
      autoForceRetryEnabled: true,
    });
    problem.deadlineAt = Date.now() + 3000;
    api.submitAnswer.mockRejectedValueOnce(new Error('fetch failed'));
    await panel.automationTick();
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.submitAnswer).toHaveBeenCalledTimes(1);
    expect(api.submitAnswer.mock.calls[0]![0]).not.toHaveProperty('forceRetry');
    await vi.advanceTimersByTimeAsync(2500);
    problem.status = 'expired';
    await panel.automationTick();
    await vi.runAllTimersAsync();
    expect(api.submitAnswer).toHaveBeenCalledTimes(2);
    expect(api.submitAnswer).toHaveBeenLastCalledWith(
      expect.objectContaining({ forceRetry: true }),
    );
    expect(api.generateAnswerProposal).toHaveBeenCalledOnce();
  });

  it('does not repeatedly force-submit after the platform rejects an expired answer', async () => {
    const { panel, api, problem } = setupPanel({
      llmAutoGenerate: true,
      llmManagedSubmit: true,
      autoForceRetryEnabled: true,
    });
    problem.status = 'expired';
    api.submitAnswer.mockRejectedValue(new Error('补交未被平台接受'));
    for (let count = 0; count < 3; count++) {
      await panel.automationTick();
      await vi.runAllTimersAsync();
    }
    expect(api.submitAnswer).toHaveBeenCalledOnce();
  });

  it.each(['force-off', 'managed-off', 'answered', 'ended'] as const)(
    'does not force-submit when %s',
    async (condition) => {
      const { panel, api, problem } = setupPanel({
        llmAutoGenerate: true,
        llmManagedSubmit: condition !== 'managed-off',
        autoForceRetryEnabled: condition !== 'force-off',
      });
      problem.status = condition === 'answered' ? 'answered' : 'expired';
      if (condition === 'ended')
        panel.lessons.value = [
          { id: problem.lessonId, title: 'Ended', status: 'ended' },
        ];
      await panel.automationTick();
      await vi.runAllTimersAsync();
      expect(api.submitAnswer).not.toHaveBeenCalled();
    },
  );

  it('cancels an expired pending submission when the force switch is turned off', async () => {
    const { panel, api, problem, proposal } = setupPanel({
      llmAutoGenerate: true,
      llmManagedSubmit: true,
      autoForceRetryEnabled: true,
    });
    problem.status = 'expired';
    let resolve!: (value: AnswerProposal) => void;
    api.generateAnswerProposal.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await panel.automationTick();
    await vi.advanceTimersByTimeAsync(0);
    panel.applySettings({
      ...DefaultAppSettings,
      llmAutoGenerate: true,
      llmManagedSubmit: true,
      autoForceRetryEnabled: false,
    });
    resolve(proposal);
    await vi.runAllTimersAsync();
    expect(api.submitAnswer).not.toHaveBeenCalled();
  });

  it('persists all three independent feature switches from the settings form', async () => {
    const { panel, api } = setupPanel({});
    panel.settingsDraft.value.aiPreanalysisEnabled = false;
    panel.settingsDraft.value.aiAutoRetryEnabled = true;
    panel.settingsDraft.value.autoForceRetryEnabled = true;
    await panel.saveSettings();
    expect(api.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        aiPreanalysisEnabled: false,
        aiAutoRetryEnabled: true,
        autoForceRetryEnabled: true,
      }),
    );
  });

  it('preanalyzes loaded locked questions and submits the cached answer only after publication', async () => {
    const { panel, api, problem } = setupPanel({
      llmAutoGenerate: true,
      llmManagedSubmit: true,
    });
    problem.status = 'locked';
    await panel.loadLessonData();
    await panel.preanalyzeLoadedProblems();
    await vi.runAllTimersAsync();
    expect(api.generateAnswerProposal).toHaveBeenCalledOnce();
    expect(api.submitAnswer).not.toHaveBeenCalled();
    problem.status = 'available';
    await panel.automationTick();
    await panel.automationTick();
    await vi.runAllTimersAsync();
    await panel.automationTick();
    await vi.runAllTimersAsync();
    expect(api.generateAnswerProposal).toHaveBeenCalledOnce();
    expect(api.submitAnswer).toHaveBeenCalledOnce();
  });

  it('waits for an in-progress preanalysis after publication instead of generating again', async () => {
    const { panel, api, problem, proposal } = setupPanel({
      llmAutoGenerate: true,
      llmManagedSubmit: true,
    });
    let resolve!: (value: AnswerProposal) => void;
    api.generateAnswerProposal.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    problem.status = 'locked';
    const analysis = panel.preanalyzeLoadedProblems();
    await vi.advanceTimersByTimeAsync(0);
    problem.status = 'available';
    await panel.onAvailableProblem(problem);
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.submitAnswer).not.toHaveBeenCalled();
    resolve(proposal);
    await analysis;
    await vi.runAllTimersAsync();
    expect(api.generateAnswerProposal).toHaveBeenCalledOnce();
    expect(api.submitAnswer).toHaveBeenCalledOnce();
  });

  it.each(['disable', 'finish', 'switch'] as const)(
    'cancels pending submission on %s while AI is responding',
    async (action) => {
      const { panel, api, problem, proposal } = setupPanel({
        llmAutoGenerate: true,
        llmManagedSubmit: true,
      });
      let resolve!: (value: AnswerProposal) => void;
      api.generateAnswerProposal.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      await panel.onAvailableProblem(problem);
      await vi.advanceTimersByTimeAsync(1000);
      if (action === 'disable')
        panel.applySettings({
          ...DefaultAppSettings,
          llmAutoGenerate: true,
          llmManagedSubmit: false,
        });
      else if (action === 'finish') panel.leaveFinishedLesson(problem.lessonId);
      else panel.setLesson('lesson-2');
      resolve(proposal);
      await vi.runAllTimersAsync();
      expect(api.submitAnswer).not.toHaveBeenCalled();
    },
  );

  it('uses each question slide without moving the current selection', async () => {
    const { panel, api, problem } = setupPanel({ llmAutoGenerate: true });
    const second = {
      ...problem,
      id: 'problem-2',
      slideId: 'slide-2',
      status: 'locked',
    };
    panel.problems.value = [{ ...problem, status: 'locked' }, second];
    panel.presentations.value = [
      {
        id: problem.presentationId,
        lessonId: problem.lessonId,
        title: '课件',
        width: 100,
        height: 100,
        slides: [problem, second].map((item, index) => ({
          id: item.slideId,
          index,
          title: '题目',
          imageUrl: `https://example.test/${item.id}.png`,
          problem: item,
        })),
      },
    ];
    await panel.preanalyzeLoadedProblems();
    expect(api.generateAnswerProposal).toHaveBeenCalledTimes(2);
    for (const item of [problem, second]) {
      expect(api.generateAnswerProposal).toHaveBeenCalledWith(
        expect.objectContaining({
          problemId: item.id,
          imageUrls: [`https://example.test/${item.id}.png`],
          captureCurrentPage: false,
        }),
      );
    }
    expect(panel.selectedProblemId.value).toBe(problem.id);
    expect(api.submitAnswer).not.toHaveBeenCalled();
  });

  it('discards an old pending answer when the selected model changes', async () => {
    const { panel, api, problem, proposal } = setupPanel({
      llmAutoGenerate: true,
      llmManagedSubmit: true,
    });
    let resolve!: (value: AnswerProposal) => void;
    api.generateAnswerProposal.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await panel.automationTick();
    await vi.advanceTimersByTimeAsync(1000);
    panel.applySettings({
      ...DefaultAppSettings,
      llmAutoGenerate: true,
      llmManagedSubmit: true,
      notifyProblems: false,
      autoAnswerDelay: 1000,
      autoAnswerRandomDelay: 0,
      activeAiProfileId: 'new-model',
      aiProfiles: [
        {
          id: 'new-model',
          name: 'Test',
          providerId: 'fixture',
          baseUrl: 'https://example.test',
          model: 'model-2',
          visionModel: '',
          ocrModel: '',
          translationModel: '',
          temperature: null,
          models: [],
          discoveredAt: '',
        },
      ],
    });
    api.generateAnswerProposal.mockResolvedValueOnce({
      ...proposal,
      id: 'proposal-new-model',
    });
    resolve(proposal);
    await vi.runAllTimersAsync();
    await panel.automationTick();
    await vi.runAllTimersAsync();
    expect(api.generateAnswerProposal).toHaveBeenCalledTimes(2);
    expect(api.submitAnswer).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        problemId: problem.id,
        proposalId: 'proposal-new-model',
      }),
    );
  });

  it('reports failure without submitting if preanalysis finishes after the deadline', async () => {
    const { panel, api, problem, proposal } = setupPanel({
      llmAutoGenerate: true,
      llmManagedSubmit: true,
      notifyProblems: true,
      notifyNative: true,
      notifyPopup: false,
      notifySound: false,
    });
    let resolve!: (value: AnswerProposal) => void;
    api.generateAnswerProposal.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    problem.deadlineAt = Date.now() + 2000;
    await panel.onAvailableProblem(problem);
    await vi.advanceTimersByTimeAsync(2500);
    resolve(proposal);
    await vi.runAllTimersAsync();
    expect(api.submitAnswer).not.toHaveBeenCalled();
    expect(api.showNotification).toHaveBeenCalledWith(
      '作答失败',
      expect.stringContaining('已截止'),
    );
  });

  it('reports batch counts and actual submission rejection through the new notices', async () => {
    const { panel, api, problem } = setupPanel({
      llmAutoGenerate: true,
      llmManagedSubmit: true,
      notifyProblems: true,
      notifyNative: true,
      notifyPopup: false,
      notifySound: false,
    });
    problem.status = 'locked';
    panel.problems.value = [problem, { ...problem, id: 'problem-2' }];
    api.generateAnswerProposal.mockRejectedValueOnce(
      new Error('analysis failed'),
    );
    await panel.preanalyzeLoadedProblems();
    expect(api.showNotification.mock.calls).toEqual([
      ['AI 分析题目中，共 2 道题', expect.any(String)],
      ['AI 分析了 2 道题', '成功 1 道，失败 1 道。'],
    ]);
    problem.status = 'available';
    await panel.onAvailableProblem(problem);
    await vi.runAllTimersAsync();
    expect(api.submitAnswer).not.toHaveBeenCalled();
    expect(api.showNotification).toHaveBeenLastCalledWith(
      '作答失败',
      expect.stringContaining('预分析'),
    );

    api.showNotification.mockClear();
    const second = panel.problems.value[1];
    second.status = 'available';
    api.submitAnswer.mockResolvedValueOnce({
      problemId: second.id,
      status: 'rejected',
      route: 'answer',
      submittedAt: new Date().toISOString(),
    });
    await panel.onAvailableProblem(second);
    await vi.runAllTimersAsync();
    expect(api.showNotification).toHaveBeenLastCalledWith(
      '作答失败',
      '平台未接受本次作答。',
    );
    expect(
      api.showNotification.mock.calls.some(([title]) => title === '作答成功'),
    ).toBe(false);
  });

  it('reports success even when the notification transport fails', async () => {
    const { panel, api, problem } = setupPanel({
      llmAutoGenerate: true,
      llmManagedSubmit: true,
      notifyProblems: true,
      notifyNative: true,
      notifyPopup: false,
      notifySound: false,
    });
    api.showNotification.mockRejectedValue(
      new Error('notification unavailable'),
    );
    await panel.onAvailableProblem(problem);
    await vi.runAllTimersAsync();
    expect(api.submitAnswer).toHaveBeenCalledOnce();
    expect(api.showNotification).toHaveBeenCalledWith(
      '作答成功',
      expect.any(String),
    );
    expect(
      api.showNotification.mock.calls.some(([title]) => title === '作答失败'),
    ).toBe(false);
  });

  it.each([
    'notifyAiAnalysisStarted',
    'notifyAiAnalysisFinished',
    'notifyAnswerSucceeded',
    'notifyAnswerFailed',
    'notifyProblems',
  ] as const)(
    'respects the %s reminder switch without disabling analysis or submission',
    async (key) => {
      const { panel, api, problem } = setupPanel({
        llmAutoGenerate: true,
        llmManagedSubmit: true,
        notifyProblems: true,
        notifyNative: true,
        notifyPopup: false,
        notifySound: false,
        [key]: false,
      });
      if (key === 'notifyAnswerFailed')
        api.submitAnswer.mockRejectedValueOnce(
          new Error('submission rejected'),
        );
      await panel.onAvailableProblem(problem);
      await vi.runAllTimersAsync();
      const titles = api.showNotification.mock.calls.map(([title]) => title);
      expect(api.submitAnswer).toHaveBeenCalledOnce();
      if (key === 'notifyProblems') expect(titles).toEqual([]);
      else {
        const excluded = {
          notifyAiAnalysisStarted: 'AI 分析题目中，共 1 道题',
          notifyAiAnalysisFinished: 'AI 分析了 1 道题',
          notifyAnswerSucceeded: '作答成功',
          notifyAnswerFailed: '作答失败',
        }[key];
        expect(titles).not.toContain(excluded);
        expect(titles).toHaveLength(2);
      }
    },
  );

  it('runs the complete generation and managed submission flow', async () => {
    const { panel, api, problem } = setupPanel({
      llmAutoGenerate: true,
      llmManagedSubmit: true,
      aiAnalyzeLatestOnOpen: true,
    });

    await panel.onAvailableProblem(problem);
    await vi.runAllTimersAsync();

    expect(api.generateAnswerProposal).toHaveBeenCalledOnce();
    expect(api.validateAnswer).not.toHaveBeenCalled();
    expect(api.submitAnswer).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        problemId: problem.id,
        confirmedBy: 'agent',
      }),
    );
  });

  it('can generate an answer without validating or submitting it', async () => {
    const { panel, api, problem } = setupPanel({
      llmAutoGenerate: false,
      llmManagedSubmit: false,
    });

    await panel.onAvailableProblem(problem);
    panel.applySettings({
      ...DefaultAppSettings,
      llmAutoGenerate: true,
      llmManagedSubmit: false,
      autoAnswerDelay: 1000,
      autoAnswerRandomDelay: 0,
      notifyProblems: false,
    });
    await panel.onAvailableProblem(problem);
    await vi.runAllTimersAsync();

    expect(api.generateAnswerProposal).toHaveBeenCalledOnce();
    expect(api.validateAnswer).not.toHaveBeenCalled();
    expect(api.submitAnswer).not.toHaveBeenCalled();
    expect(panel.infoMessage.value).toContain('已预分析题目');
  });

  it('selects and analyzes the latest available problem on AI page open', async () => {
    const { panel, api, problem } = setupPanel({
      aiAnalyzeLatestOnOpen: true,
    });
    const latest: ProblemContext = {
      ...problem,
      id: 'problem-latest',
      unlockedAt: 2000,
    };
    panel.problems.value = [problem, latest];

    await panel.analyzeLatestProblemOnOpen();
    await nextTick();

    expect(panel.selectedProblemId.value).toBe(latest.id);
    expect(api.generateAnswerProposal).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ problemId: latest.id }),
    );
  });

  it('always sends the problem slide from the problem-page AI entry', async () => {
    const { panel, api, problem, emit } = setupPanel({
      aiCaptureCurrentPage: true,
    });
    const imageUrl = 'https://example.test/problem-slide.png';
    panel.presentations.value = [
      {
        id: problem.presentationId,
        lessonId: problem.lessonId,
        title: '题目课件',
        width: 1920,
        height: 1080,
        slides: [
          {
            id: problem.slideId,
            index: 0,
            title: '题目页',
            imageUrl,
            problem,
          },
        ],
      },
    ];
    panel.selectedProblemId.value = problem.id;
    panel.aiSlideSelection.value = ['unrelated-slide'];
    await nextTick();

    panel.openAiForProblem();
    await panel.analyzeProblem(false);

    expect(emit).toHaveBeenCalledWith('selectPage', 'ai');
    expect(api.generateAnswerProposal).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        problemId: problem.id,
        imageUrls: [imageUrl],
        imageSource: 'slide',
        captureCurrentPage: false,
      }),
    );
  });

  it('turns off managed submission when automatic generation is disabled', async () => {
    const { panel } = setupPanel({
      llmAutoGenerate: true,
      llmManagedSubmit: true,
    });

    panel.settingsDraft.value.llmAutoGenerate = false;
    await nextTick();

    expect(panel.settingsDraft.value.llmManagedSubmit).toBe(false);
  });

  it('keeps an existing available problem eligible when generation is enabled later', async () => {
    const { panel, api, problem } = setupPanel({
      llmAutoGenerate: false,
    });
    panel.connectedLessonIds.add(problem.lessonId);

    await panel.automationTick();
    expect(api.generateAnswerProposal).not.toHaveBeenCalled();

    panel.applySettings({
      ...DefaultAppSettings,
      llmAutoGenerate: true,
      autoAnswerDelay: 1000,
      autoAnswerRandomDelay: 0,
      notifyProblems: false,
    });
    await panel.automationTick();
    await vi.runAllTimersAsync();

    expect(api.generateAnswerProposal).toHaveBeenCalledOnce();
  });
});

function setupPanel(settings: Partial<AppSettings>) {
  vi.useFakeTimers();
  const problem: ProblemContext = {
    id: 'problem-1',
    lessonId: 'lesson-1',
    presentationId: 'presentation-1',
    slideId: 'slide-1',
    type: ProblemType.SingleChoice,
    prompt: '选择正确答案',
    options: ['选项 A', '选项 B'],
    blanks: [],
    result: null,
    status: 'available',
    unlockedAt: 1000,
    deadlineAt: null,
  };
  const proposal: AnswerProposal = {
    id: 'proposal-1',
    sessionId: 'session-1',
    problemId: problem.id,
    status: 'ready',
    answer: ['A'],
    explanation: '选择 A。',
    confidence: 0.9,
    failureReason: null,
    validationIssues: [],
    rawText: '{"answer":["A"]}',
    profileId: 'profile-1',
    model: 'model-1',
    contextSources: [`problem:${problem.id}`],
    createdAt: new Date().toISOString(),
  };
  const api = {
    updateSettings: vi.fn(async (patch: Partial<AppSettings>) => ({
      ...DefaultAppSettings,
      ...patch,
    })),
    generateAnswerProposal: vi.fn(
      async ({ problemId }: { problemId: string }) => ({
        ...proposal,
        problemId,
      }),
    ),
    validateAnswer: vi.fn(async () => ({
      valid: true,
      issues: [],
      normalizedAnswer: ['A'],
    })),
    submitAnswer: vi.fn(async () => ({
      problemId: problem.id,
      status: 'submitted',
      route: 'answer',
      submittedAt: new Date().toISOString(),
    })),
    listProblems: vi.fn(async () => [problem]),
    listPresentations: vi.fn(async () => []),
    showNotification: vi.fn(async () => true),
  };
  vi.stubGlobal('window', { yuketang: api });
  const scope = effectScope();
  scopes.push(scope);
  const emit = vi.fn();
  const props = reactive({
    page: 'settings',
    environment: BrowserEnvironment.Standard,
    runtime: undefined,
    browserUrl: undefined,
    collapsed: false,
  });
  const panel = scope.run(() =>
    (AssistantPanel as any).setup(props, { expose: vi.fn(), emit }),
  );
  panel.applySettings({
    ...DefaultAppSettings,
    autoAnswerDelay: 1000,
    autoAnswerRandomDelay: 0,
    notifyProblems: false,
    ...settings,
  });
  panel.problems.value = [problem];
  panel.selectedLessonId.value = problem.lessonId;
  panel.selectedProblemId.value = problem.id;
  return { panel, api, problem, proposal, emit, props };
}

it('prefills assignment extraction in AI without auto-send or leaking classroom/image context', async () => {
  const { panel, api, problem, emit, props } = setupPanel({
    aiAnalyzeLatestOnOpen: true,
    aiCaptureCurrentPage: true,
    llmManagedSubmit: true,
  });
  panel.selectedProblemId.value = problem.id;
  await nextTick();
  const draft = {
    title: '复习试卷',
    text: '请解释：未解码字符𛈒',
    hasEncryptedText: true,
  };
  panel.explainAssignment(draft);
  props.page = 'ai';
  await nextTick();
  expect(emit).toHaveBeenCalledWith('selectPage', 'ai');
  expect(panel.aiCustomPrompt.value).toBe(draft.text);
  expect(api.generateAnswerProposal).not.toHaveBeenCalled();
  panel.aiCustomPrompt.value = '已检查并修改的题干';
  await panel.analyzeProblem(false);
  expect(api.generateAnswerProposal).toHaveBeenCalledWith(
    expect.objectContaining({
      customPrompt: '已检查并修改的题干',
      captureCurrentPage: false,
      imageUrls: [],
      contextId: expect.stringMatching(/^assignment:/),
    }),
  );
  expect(api.generateAnswerProposal.mock.calls[0]![0]).not.toHaveProperty(
    'problemId',
  );
  expect(api.submitAnswer).not.toHaveBeenCalled();
  panel.aiChatDraft.value = '再解释一下';
  await panel.sendAiFollowUp();
  expect(api.generateAnswerProposal).toHaveBeenLastCalledWith(
    expect.objectContaining({
      customPrompt: '再解释一下',
      captureCurrentPage: false,
    }),
  );
  panel.startNewAiChat();
  expect(panel.aiCustomPrompt.value).toBe(draft.text);
});

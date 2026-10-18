import { describe, expect, it, vi } from 'vitest';
import type {
  CourseBrushPageProbe,
  CourseBrushQuestionProbe,
  YuketangFacade,
} from '@ykt/contracts';
import {
  CourseBrushController,
  buildDetectAndJumpToFirstIncompleteScript,
  buildTriggerNextDirectoryItemScript,
  parseCourseBrushAiAnswer,
} from '../../apps/desktop/main/course-brush-controller.js';
import type { BrowserController } from '../../apps/desktop/main/browser-controller.js';

function baseQuestionProbe(
  overrides: Partial<CourseBrushQuestionProbe> = {},
): CourseBrushQuestionProbe {
  return {
    found: true,
    route: 'v2-homework',
    questionIndex: 0,
    totalQuestions: 3,
    questionType: 'single',
    typeLabel: '单选题',
    stemText: '1. 下列关于操作系统进程调度的说法正确的是？',
    hasEncryptedFont: true,
    alreadyAnswered: false,
    options: [
      { index: 0, label: 'A', text: '选项A', selected: false },
      { index: 1, label: 'B', text: '选项B', selected: false },
      { index: 2, label: 'C', text: '选项C', selected: false },
      { index: 3, label: 'D', text: '选项D', selected: false },
    ],
    blankCount: 0,
    submitButtonText: '提交',
    canSubmit: false,
    rect: { x: 20, y: 80, width: 640, height: 360 },
    ...overrides,
  };
}

describe('parseCourseBrushAiAnswer', () => {
  it('parses single-choice JSON and filters to a single valid option letter', () => {
    const q = baseQuestionProbe({ questionType: 'single' });
    const parsed = parseCourseBrushAiAnswer(
      q,
      '```json\n{"answer": ["B", "C"], "explanation": "B 最准确"}\n```',
    );
    expect(parsed.answers).toEqual(['B']);
    expect(parsed.explanation).toBe('B 最准确');
  });

  it('parses multiple-choice answers preserving all valid selected letters', () => {
    const q = baseQuestionProbe({
      questionType: 'multiple',
      typeLabel: '多选题',
    });
    const parsed = parseCourseBrushAiAnswer(
      q,
      '{"answer": ["A", "C", "D"], "explanation": "ACD 均正确"}',
    );
    expect(parsed.answers).toEqual(['A', 'C', 'D']);
  });

  it('maps true/false answers onto 对/错 option labels accurately', () => {
    const q = baseQuestionProbe({
      questionType: 'judge',
      typeLabel: '判断题',
      options: [
        { index: 0, label: '对', text: '正确', selected: false },
        { index: 1, label: '错', text: '错误', selected: false },
      ],
    });
    expect(
      parseCourseBrushAiAnswer(q, '{"answer": ["正确"], "explanation": "对"}')
        .answers,
    ).toEqual(['对']);
    expect(
      parseCourseBrushAiAnswer(q, '{"answer": ["false"], "explanation": "错"}')
        .answers,
    ).toEqual(['错']);
  });

  it('parses multi-blank fill-in-the-blank answers in order', () => {
    const q = baseQuestionProbe({
      questionType: 'blank',
      typeLabel: '填空题',
      options: [],
      blankCount: 2,
    });
    const parsed = parseCourseBrushAiAnswer(
      q,
      '{"answer": ["死锁", "银行家算法"], "explanation": "两个空"}',
    );
    expect(parsed.answers).toEqual(['死锁', '银行家算法']);
  });
});

describe('CourseBrushController', () => {
  it('probes page with native cropped screenshot and solves current question via Vision AI', async () => {
    const sampleProbe: CourseBrushPageProbe = {
      url: 'https://www.yuketang.cn/v2/web/studentCards/123/456',
      title: '第一章作业',
      route: 'v2-homework',
      routeLabel: '作业 / 习题作答页',
      directoryItemsTotal: 0,
      directoryItemsPending: 0,
      directorySampleTitles: [],
      mediaStatus: {
        hasVideo: false,
        hasAudio: false,
        paused: null,
        playbackRate: null,
        progressText: null,
        completed: false,
      },
      questionProbe: baseQuestionProbe(),
    };

    const executeJavaScript = vi.fn().mockImplementation((script: string) => {
      if (
        typeof script === 'string' &&
        script.includes("document.getElementById('ykt-native-brush-hud')")
      ) {
        return Promise.resolve(null);
      }
      if (typeof script === 'string' && script.includes('answers')) {
        return Promise.resolve({
          applied: true,
          submitted: true,
          detail: '已选择 C；已点击提交按钮',
        });
      }
      return Promise.resolve(sampleProbe);
    });

    const capturePage = vi.fn().mockResolvedValue({
      isEmpty: () => false,
      toDataURL: () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
    });

    const mockBrowser = {
      webContents: {
        isDestroyed: () => false,
        executeJavaScript,
        capturePage,
      },
      captureCurrentPage: vi
        .fn()
        .mockResolvedValue('data:image/png;base64,full'),
      getState: () => ({
        tabs: [
          {
            id: 'tab-1',
            environment: 'standard',
            url: sampleProbe.url,
            title: sampleProbe.title,
            loading: false,
          },
        ],
        activeTabId: 'tab-1',
        environment: 'standard',
        url: sampleProbe.url,
        title: sampleProbe.title,
        loading: false,
        canGoBack: true,
        canGoForward: false,
        errorMessage: null,
        assistantPanelCollapsed: false,
        networkLabCollapsed: false,
      }),
    } as unknown as BrowserController;

    const generateAnswerProposal = vi.fn().mockResolvedValue({
      id: 'prop-1',
      sessionId: 'sess-1',
      problemId: 'ctx-1',
      status: 'ready',
      answer: { content: '{"answer":["C"],"explanation":"C正确"}', pics: [] },
      explanation: 'C正确',
      confidence: 0.9,
      failureReason: null,
      validationIssues: [],
      rawText: '{"answer":["C"],"explanation":"C正确"}',
      profileId: 'default',
      model: 'vision-model',
      contextSources: [],
      createdAt: new Date().toISOString(),
    });

    const mockFacade = {
      generateAnswerProposal,
    } as unknown as YuketangFacade;

    const states: unknown[] = [];
    const controller = new CourseBrushController(
      mockBrowser,
      () => mockFacade,
      (s) => states.push(s),
    );

    const result = await controller.solveCurrentQuestion(true);
    expect(capturePage).toHaveBeenCalledWith({
      x: 20,
      y: 80,
      width: 640,
      height: 360,
    });
    expect(generateAnswerProposal).toHaveBeenCalledOnce();
    expect(result.answerText).toBe('C');
    expect(result.applied).toBe(true);
    expect(result.submitted).toBe(true);
    expect(controller.getState().answeredQuestionCount).toBe(1);
    expect(states.length).toBeGreaterThan(0);
  });

  it('automatically detects and jumps to the first incomplete unit when starting brush in ai-workspace', async () => {
    const aiProbe: CourseBrushPageProbe = {
      url: 'https://www.yuketang.cn/ai-workspace/lms-graph/25055051/video/999',
      title: '第15节 某中途视频',
      route: 'ai-workspace',
      routeLabel: 'AI Workspace · 视频课',
      directoryItemsTotal: 20,
      directoryItemsPending: 18,
      directorySampleTitles: ['第2节 倪虹：加快构建房地产发展新模式 (5%)'],
      mediaStatus: {
        hasVideo: true,
        hasAudio: false,
        paused: false,
        playbackRate: 2,
        progressText: '50%',
        completed: false,
      },
      questionProbe: {
        found: false,
        route: 'unknown',
        questionIndex: 0,
        totalQuestions: 0,
        questionType: 'single',
        typeLabel: '未知',
        stemText: '',
        hasEncryptedFont: false,
        alreadyAnswered: false,
        options: [],
        blankCount: 0,
        submitButtonText: '',
        canSubmit: false,
        rect: null,
      },
    };

    const executedScripts: string[] = [];
    const executeJavaScript = vi.fn().mockImplementation((script: string) => {
      executedScripts.push(script);
      if (typeof script === 'string' && script.includes('firstIncompleteItem')) {
        return Promise.resolve({
          ready: true,
          switched: true,
          activeIdx: 14,
          targetIdx: 1,
          total: 20,
          title: '第2节 倪虹：加快构建房地产发展新模式 (当前进度 5%)',
        });
      }
      return Promise.resolve(aiProbe);
    });

    const mockBrowser = {
      webContents: {
        isDestroyed: () => false,
        executeJavaScript,
        setAudioMuted: vi.fn(),
      },
      getState: () => ({
        tabs: [
          {
            id: 'tab-1',
            environment: 'standard',
            url: aiProbe.url,
            title: aiProbe.title,
            loading: false,
          },
        ],
        activeTabId: 'tab-1',
        environment: 'standard',
        url: aiProbe.url,
        title: aiProbe.title,
        loading: false,
        canGoBack: true,
        canGoForward: false,
        errorMessage: null,
        assistantPanelCollapsed: false,
        networkLabCollapsed: false,
      }),
    } as unknown as BrowserController;

    const controller = new CourseBrushController(
      mockBrowser,
      () => ({} as YuketangFacade),
      () => {},
    );

    await controller.start();
    await new Promise((r) => setTimeout(r, 60));
    const state = controller.getState();
    controller.stop();

    const alignmentLog = state.logs.find((l) =>
      l.message.includes('自动检测到全课首个未完成任务（第 2/20 节）'),
    );
    expect(alignmentLog).toBeDefined();
    expect(alignmentLog?.level).toBe('info');
    expect(state.currentTaskTitle).toContain('倪虹：加快构建房地产发展新模式');
  });

  it('detects when the current page is already the first incomplete unit and proceeds directly', async () => {
    const aiProbe: CourseBrushPageProbe = {
      url: 'https://www.yuketang.cn/ai-workspace/lms-graph/25055051/video/101',
      title: '第2节 倪虹：加快构建房地产发展新模式',
      route: 'ai-workspace',
      routeLabel: 'AI Workspace · 视频课',
      directoryItemsTotal: 20,
      directoryItemsPending: 18,
      directorySampleTitles: ['第2节 倪虹：加快构建房地产发展新模式 (5%)'],
      mediaStatus: {
        hasVideo: true,
        hasAudio: false,
        paused: false,
        playbackRate: 2,
        progressText: '5%',
        completed: false,
      },
      questionProbe: {
        found: false,
        route: 'unknown',
        questionIndex: 0,
        totalQuestions: 0,
        questionType: 'single',
        typeLabel: '未知',
        stemText: '',
        hasEncryptedFont: false,
        alreadyAnswered: false,
        options: [],
        blankCount: 0,
        submitButtonText: '',
        canSubmit: false,
        rect: null,
      },
    };

    const executeJavaScript = vi.fn().mockImplementation((script: string) => {
      if (typeof script === 'string' && script.includes('firstIncompleteItem')) {
        return Promise.resolve({
          ready: true,
          alreadyAtTarget: true,
          activeIdx: 1,
          targetIdx: 1,
          total: 20,
          title: '第2节 倪虹：加快构建房地产发展新模式',
        });
      }
      return Promise.resolve(aiProbe);
    });

    const mockBrowser = {
      webContents: {
        isDestroyed: () => false,
        executeJavaScript,
        setAudioMuted: vi.fn(),
      },
      getState: () => ({
        tabs: [
          {
            id: 'tab-1',
            environment: 'standard',
            url: aiProbe.url,
            title: aiProbe.title,
            loading: false,
          },
        ],
        activeTabId: 'tab-1',
        environment: 'standard',
        url: aiProbe.url,
        title: aiProbe.title,
        loading: false,
        canGoBack: true,
        canGoForward: false,
        errorMessage: null,
        assistantPanelCollapsed: false,
        networkLabCollapsed: false,
      }),
    } as unknown as BrowserController;

    const controller = new CourseBrushController(
      mockBrowser,
      () => ({} as YuketangFacade),
      () => {},
    );

    await controller.start();
    await new Promise((r) => setTimeout(r, 60));
    controller.stop();

    const state = controller.getState();
    const confirmLog = state.logs.find((l) =>
      l.message.includes('当前正是全课首个未完成任务（第 2/20 节）'),
    );
    expect(confirmLog).toBeDefined();
    expect(confirmLog?.level).toBe('info');
  });

  it('buildDetectAndJumpToFirstIncompleteScript scans units in catalog order (chapter discussions included)', () => {
    const script = buildDetectAndJumpToFirstIncompleteScript({
      enableVideo: true,
      enableCourseware: true,
      enableDiscussion: true,
      enableHomework: true,
      playbackRate: 2,
      muteAudio: true,
      autoSubmitHomework: true,
    });
    expect(script).toContain('Sequential chapter progression');
    expect(script).not.toContain('Pass 1: Prioritize core learning materials');
    expect(script).toContain('__ykt_commented_discussions');
  });

  it('switches video playback speed to configured rate and logs success', async () => {
    const videoProbe: CourseBrushPageProbe = {
      url: 'https://www.yuketang.cn/ai-workspace/lms-graph/25055051/video/102',
      title: '第3节 核心概念讲解',
      route: 'ai-workspace',
      routeLabel: 'AI Workspace · 视频课',
      directoryItemsTotal: 10,
      directoryItemsPending: 5,
      directorySampleTitles: ['第3节 核心概念讲解'],
      mediaStatus: {
        hasVideo: true,
        hasAudio: false,
        paused: false,
        playbackRate: 1,
        progressText: '10%',
        completed: false,
      },
      questionProbe: {
        found: false,
        route: 'unknown',
        questionIndex: 0,
        totalQuestions: 0,
        questionType: 'single',
        typeLabel: '未知',
        stemText: '',
        hasEncryptedFont: false,
        alreadyAnswered: false,
        options: [],
        blankCount: 0,
        submitButtonText: '',
        canSubmit: false,
        rect: null,
      },
    };

    const executeJavaScript = vi.fn().mockImplementation((script: string) => {
      if (typeof script === 'string' && script.includes('firstIncompleteItem')) {
        return Promise.resolve({
          ready: true,
          alreadyAtTarget: true,
          activeIdx: 2,
          targetIdx: 2,
          total: 10,
          title: '第3节 核心概念讲解',
        });
      }
      if (typeof script === 'string' && script.includes('xt-speedbutton')) {
        return Promise.resolve({
          found: true,
          ok: true,
          clicked: true,
          clickedText: '2.00X',
          rate: 2,
          speedValText: '2.00X',
        });
      }
      return Promise.resolve(videoProbe);
    });

    const mockBrowser = {
      webContents: {
        isDestroyed: () => false,
        executeJavaScript,
        setAudioMuted: vi.fn(),
      },
      getState: () => ({
        tabs: [
          {
            id: 'tab-1',
            environment: 'standard',
            url: videoProbe.url,
            title: videoProbe.title,
            loading: false,
          },
        ],
        activeTabId: 'tab-1',
        environment: 'standard',
        url: videoProbe.url,
        title: videoProbe.title,
        loading: false,
        canGoBack: true,
        canGoForward: false,
        errorMessage: null,
        assistantPanelCollapsed: false,
        networkLabCollapsed: false,
      }),
    } as unknown as BrowserController;

    const controller = new CourseBrushController(
      mockBrowser,
      () => ({} as YuketangFacade),
      () => {},
    );

    await controller.start();
    await new Promise((r) => setTimeout(r, 60));
    controller.stop();

    const state = controller.getState();
    const speedLog = state.logs.find((l) =>
      l.message.includes('已切换视频播放倍速为 2X'),
    );
    expect(speedLog).toBeDefined();
    expect(speedLog?.level).toBe('success');
  });

  it('buildDetectAndJumpToFirstIncompleteScript accurately detects SVG shipin icons, completion checkmarks, and prefetches server progress', () => {
    const script = buildDetectAndJumpToFirstIncompleteScript(
      {
        enableVideo: true,
        enableCourseware: true,
        enableDiscussion: true,
        enableHomework: true,
        playbackRate: 2,
        muteAudio: true,
        autoSubmitHomework: true,
      },
      ['leaf-999'],
    );

    // Verify key robust identifiers
    expect(script).toContain('icon-shipin');
    expect(script).toContain('icon-wancheng');
    expect(script).toContain('xlink:href');
    expect(script).toContain('__ykt_completed_units');
    expect(script).toContain('leaf-999');
    expect(script).toContain('Sequential chapter progression');
    expect(script).toContain('已发表');
    expect(script).toContain('__ykt_commented_discussions');
    expect(script).not.toContain('Pass 2: Fallback to discussion');
    expect(script).toContain('/c27/online_courseware/schedule/course/progress/?classroom_id=');
  });

  it('buildTriggerNextDirectoryItemScript follows catalog order so chapter discussions are not skipped', () => {
    const script = buildTriggerNextDirectoryItemScript(
      'v2-student-log',
      {
        enableVideo: true,
        enableCourseware: true,
        enableDiscussion: true,
        enableHomework: true,
        playbackRate: 2,
        muteAudio: true,
        autoSubmitHomework: true,
      },
      [],
    );

    expect(script).toContain('Sequential progression across all candidates in chapter order');
    expect(script).not.toContain('Pass 1: Video Priority');
    expect(script).toContain("c.kind === 'discuss' && !config.enableDiscussion");
  });
});


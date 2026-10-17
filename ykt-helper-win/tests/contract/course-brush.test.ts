import { describe, expect, it, vi } from 'vitest';
import type {
  CourseBrushPageProbe,
  CourseBrushQuestionProbe,
  YuketangFacade,
} from '@ykt/contracts';
import {
  CourseBrushController,
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
});

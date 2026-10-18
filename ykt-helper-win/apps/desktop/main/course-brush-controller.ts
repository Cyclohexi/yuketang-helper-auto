import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DefaultCourseBrushConfig,
  type CourseBrushAiResult,
  type CourseBrushConfig,
  type CourseBrushLogItem,
  type CourseBrushPageProbe,
  type CourseBrushPageRoute,
  type CourseBrushQuestionKind,
  type CourseBrushQuestionProbe,
  type CourseBrushRunStatus,
  type CourseBrushState,
  type YuketangFacade,
} from '@ykt/contracts';
import { app, type WebContents } from 'electron';
import type { BrowserController } from './browser-controller.js';

const MAX_LOGS = 120;
const HUD_CMD_PREFIX = '__YKT_BRUSH_HUD_CMD__:';

export class CourseBrushController {
  #status: CourseBrushRunStatus = 'idle';
  #config: CourseBrushConfig = { ...DefaultCourseBrushConfig };
  #currentRoute: CourseBrushPageRoute = 'unknown';
  #currentTaskTitle = '未开始';
  #completedCount = 0;
  #answeredQuestionCount = 0;
  #parentTabId: string | null = null;
  #activeTaskTabId: string | null = null;
  #lastProbe: CourseBrushPageProbe | null = null;
  #lastAiAnswer: CourseBrushAiResult | null = null;
  #logs: CourseBrushLogItem[] = [];
  #nextLogId = 1;
  #loopPromise: Promise<void> | null = null;
  #processedDirectoryKeys = new Set<string>();
  #mediaWaitTicks = 0;
  #lastMediaProgress = '';
  #mediaStuckTicks = 0;
  #lastMediaUrl = '';
  #playedTicksOnUrl = 0;
  #speedHoverDoneForUrl = '';
  #unitReloadAttempts = new Map<string, number>();
  #needFirstIncompleteAlignment = true;
  #lastAlignedClassroomId = '';
  #alignmentAttempts = 0;
  #completedLeafKeys = new Set<string>();
  #removeContentsListener: (() => void) | null = null;

  constructor(
    private readonly browser: BrowserController,
    private readonly getFacade: () => YuketangFacade,
    private readonly onStateChanged: (state: CourseBrushState) => void,
  ) {
    this.#removeContentsListener =
      this.browser.onWebContentsCreated?.((contents) => {
        this.attachWebContentsHooks(contents);
      }) ?? null;

    try {
      if (app?.isReady?.()) {
        const cacheFile = join(app.getPath('userData'), 'course-brush-cache.json');
        readFile(cacheFile, 'utf8')
          .then((data) => {
            const arr = JSON.parse(data);
            if (Array.isArray(arr)) {
              for (const k of arr) {
                if (
                  typeof k === 'string' &&
                  (k.startsWith('http') || /^\d{4,}$/.test(k))
                ) {
                  this.#completedLeafKeys.add(k);
                }
              }
            }
          })
          .catch(() => null);
      }
    } catch {}
  }

  getState(): CourseBrushState {
    return {
      status: this.#status,
      config: this.#config,
      currentRoute: this.#currentRoute,
      currentTaskTitle: this.#currentTaskTitle,
      completedCount: this.#completedCount,
      answeredQuestionCount: this.#answeredQuestionCount,
      parentTabId: this.#parentTabId,
      activeTaskTabId: this.#activeTaskTabId,
      lastProbe: this.#lastProbe,
      lastAiAnswer: this.#lastAiAnswer,
      logs: this.#logs,
    };
  }

  updateConfig(patch: Partial<CourseBrushConfig>): CourseBrushState {
    const playbackRate =
      typeof patch.playbackRate === 'number' &&
      Number.isFinite(patch.playbackRate)
        ? Math.min(4, Math.max(0.5, patch.playbackRate))
        : this.#config.playbackRate;
    this.#config = {
      playbackRate,
      muteAudio:
        typeof patch.muteAudio === 'boolean'
          ? patch.muteAudio
          : this.#config.muteAudio,
      enableVideo:
        typeof patch.enableVideo === 'boolean'
          ? patch.enableVideo
          : this.#config.enableVideo,
      enableCourseware:
        typeof patch.enableCourseware === 'boolean'
          ? patch.enableCourseware
          : this.#config.enableCourseware,
      enableReplay:
        typeof patch.enableReplay === 'boolean'
          ? patch.enableReplay
          : this.#config.enableReplay,
      enableDiscussion:
        typeof patch.enableDiscussion === 'boolean'
          ? patch.enableDiscussion
          : this.#config.enableDiscussion,
      enableHomework:
        typeof patch.enableHomework === 'boolean'
          ? patch.enableHomework
          : this.#config.enableHomework,
      autoSubmitHomework:
        typeof patch.autoSubmitHomework === 'boolean'
          ? patch.autoSubmitHomework
          : this.#config.autoSubmitHomework,
    };
    this.#speedHoverDoneForUrl = '';
    try {
      const contents = this.browser.webContents;
      if (contents && !contents.isDestroyed()) {
        contents.setAudioMuted(Boolean(this.#config.muteAudio));
        void contents
          .executeJavaScript(
            buildEnsureMediaAndAntiCheckScript(this.#config),
            true,
          )
          .catch(() => null);
      }
    } catch {
      // Ignore if webContents not ready
    }
    this.log(
      'info',
      `刷课配置已更新：${this.#config.playbackRate}x 倍速，静音=${this.#config.muteAudio ? '开' : '关'}，AI答题=${this.#config.enableHomework ? '开' : '关'}`,
    );
    this.emitState();
    return this.getState();
  }

  clearLogs(): CourseBrushState {
    this.#logs = [];
    this.emitState();
    return this.getState();
  }

  async start(): Promise<CourseBrushState> {
    if (this.#status === 'running') return this.getState();
    if (this.#status === 'paused') {
      this.#status = 'running';
      this.log('info', '▶ 继续执行自动刷课');
      this.emitState();
      return this.getState();
    }
    this.#status = 'running';
    this.#needFirstIncompleteAlignment = true;
    this.#lastAlignedClassroomId = '';
    this.#alignmentAttempts = 0;
    this.#processedDirectoryKeys.clear();
    this.#unitReloadAttempts.clear();
    this.#speedAttemptsByUrl.clear();
    this.#mediaWaitTicks = 0;
    this.#lastMediaUrl = '';
    this.#playedTicksOnUrl = 0;
    this.#speedHoverDoneForUrl = '';
    const browserState = this.browser.getState();
    this.#parentTabId = browserState.activeTabId;
    this.#activeTaskTabId = null;
    try {
      this.browser.webContents.setAudioMuted(Boolean(this.#config.muteAudio));
    } catch {}
    this.log(
      'info',
      `🚀 启动 Electron 原生自动刷课（当前标签页 ${browserState.activeTabId}）`,
    );
    this.emitState();
    if (!this.#loopPromise) {
      this.#loopPromise = this.runLoop().finally(() => {
        this.#loopPromise = null;
      });
    }
    return this.getState();
  }

  pause(): CourseBrushState {
    if (this.#status === 'running') {
      this.#status = 'paused';
      this.log('warn', '⏸ 已暂停自动刷课');
      this.emitState();
    }
    return this.getState();
  }

  stop(): CourseBrushState {
    if (this.#status !== 'idle') {
      this.#status = 'idle';
      this.#currentTaskTitle = '已停止';
      this.#activeTaskTabId = null;
      this.#mediaWaitTicks = 0;
      this.#lastMediaUrl = '';
      this.#playedTicksOnUrl = 0;
      this.#speedHoverDoneForUrl = '';
      this.log('warn', '⏹ 已停止自动刷课');
      this.emitState();
    }
    return this.getState();
  }

  destroy(): void {
    this.#status = 'idle';
    if (this.#removeContentsListener) {
      this.#removeContentsListener();
      this.#removeContentsListener = null;
    }
  }

  async probeCurrentPage(
    captureScreenshot = true,
    quiet = false,
  ): Promise<CourseBrushPageProbe> {
    const contents = this.browser.webContents;
    if (contents.isDestroyed()) {
      throw new Error('当前浏览器标签页不可用。');
    }
    const rawProbe = (await contents.executeJavaScript(
      buildDomProbeScript(),
      true,
    )) as CourseBrushPageProbe;

    let questionProbe: CourseBrushQuestionProbe = rawProbe.questionProbe;
    if (captureScreenshot && questionProbe.found) {
      try {
        await this.sleep(220);
        const screenshotDataUrl = await this.captureQuestionRect(
          questionProbe.rect,
        );
        questionProbe = {
          ...questionProbe,
          screenshotDataUrl,
        };
      } catch {
        // Ignore screenshot errors during probe; DOM probe still succeeds.
      }
    }

    const probe: CourseBrushPageProbe = {
      ...rawProbe,
      questionProbe,
    };
    this.#currentRoute = probe.route;
    this.#lastProbe = probe;
    if (!quiet) {
      this.log(
        'info',
        `🔍 页面探测完成：[${probe.routeLabel}] 待刷目录项 ${probe.directoryItemsPending}/${probe.directoryItemsTotal}，题目检测=${probe.questionProbe.found ? `${probe.questionProbe.typeLabel}（第 ${probe.questionProbe.questionIndex + 1}/${probe.questionProbe.totalQuestions} 题，选项 ${probe.questionProbe.options.length} 个，填空 ${probe.questionProbe.blankCount} 个）` : '无'}`,
      );
    }
    this.emitState();
    return probe;
  }

  async solveCurrentQuestion(
    submit = this.#config.autoSubmitHomework,
  ): Promise<CourseBrushAiResult> {
    const probe = await this.probeCurrentPage(true);
    const q = probe.questionProbe;
    if (!q.found) {
      throw new Error(
        '当前页面未检测到可作答的题目区域，请先打开雨课堂作业或习题页面。',
      );
    }

    const questionTitle = `第 ${q.questionIndex + 1}/${q.totalQuestions} 题（${q.typeLabel}）`;
    this.#currentTaskTitle = `正在 AI 解答 ${questionTitle}`;
    this.log(
      'info',
      `🤖 开始解答 ${questionTitle}${q.hasEncryptedFont ? ' [检测到加密字体，启用原生高清截图视觉识别]' : ''}`,
    );
    this.emitState();

    const screenshotDataUrl =
      q.screenshotDataUrl ?? (await this.captureQuestionRect(q.rect));
    const prompt = buildHomeworkAiPrompt(q);
    const proposal = await this.getFacade().generateAnswerProposal({
      contextId: `course-brush:${randomUUID()}`,
      imageUrls: screenshotDataUrl ? [screenshotDataUrl] : [],
      imageSource: 'browser-page',
      customPrompt: prompt,
    });

    if (proposal.status !== 'ready' || !proposal.rawText.trim()) {
      const reason =
        proposal.failureReason || 'AI 未返回有效答案，请检查“模型”页配置。';
      this.log('error', `❌ ${questionTitle} AI 解答失败：${reason}`);
      throw new Error(reason);
    }

    const parsed = parseCourseBrushAiAnswer(q, proposal.rawText);
    if (!parsed.answers.length) {
      const msg = `无法从 AI 响应中解析出匹配题型（${q.typeLabel}）的答案：${proposal.rawText.slice(0, 120)}`;
      this.log('error', `❌ ${msg}`);
      throw new Error(msg);
    }

    const answerDisplay = parsed.answers.join(
      q.questionType === 'blank' ? ' | ' : ', ',
    );
    this.log(
      'success',
      `💡 ${questionTitle} AI 答案：【${answerDisplay}】${parsed.explanation ? `（${parsed.explanation.slice(0, 80)}）` : ''}`,
    );

    const applyResult = (await this.browser.webContents.executeJavaScript(
      buildApplyHomeworkAnswerScript({
        questionType: q.questionType,
        answers: parsed.answers,
        submit,
      }),
      true,
    )) as {
      applied: boolean;
      submitted: boolean;
      detail: string;
    };

    if (applyResult.applied) {
      this.log(
        applyResult.submitted || !submit ? 'success' : 'warn',
        `✅ ${questionTitle} 作答操作完成：${applyResult.detail}`,
      );
      if (applyResult.submitted) {
        this.#answeredQuestionCount += 1;
      }
    } else {
      this.log(
        'warn',
        `⚠️ ${questionTitle} 选项/输入框填充未完全匹配：${applyResult.detail}`,
      );
    }

    const result: CourseBrushAiResult = {
      questionTitle,
      questionType: q.questionType,
      answerText: answerDisplay,
      explanation: parsed.explanation,
      rawText: proposal.rawText,
      applied: applyResult.applied,
      submitted: applyResult.submitted,
    };
    this.#lastAiAnswer = result;
    await this.probeCurrentPage(false).catch(() => null);
    this.emitState();
    return result;
  }

  async solveAllQuestionsOnCurrentPage(): Promise<CourseBrushState> {
    this.log('info', '📝 开始自动遍历并作答当前页面全部题目…');
    this.#currentTaskTitle = '自动作答当前页作业';
    this.emitState();

    const navInfo = (await this.browser.webContents.executeJavaScript(
      buildInspectQuestionNavigationScript(),
      true,
    )) as {
      mode: 'order-bar' | 'card-list' | 'single';
      total: number;
    };

    const total = Math.max(1, navInfo.total);
    this.log(
      'info',
      `📋 检测到页面题目导航模式：${navInfo.mode}，共 ${total} 题`,
    );

    for (let idx = 0; idx < total; idx += 1) {
      if (this.#status === 'stopping') break;

      const switched = (await this.browser.webContents.executeJavaScript(
        buildActivateQuestionByIndexScript(navInfo.mode, idx),
        true,
      )) as {
        ok: boolean;
        skippedAsDone: boolean;
        reason: string;
      };

      await this.sleep(800);
      const probe = await this.probeCurrentPage(false);
      const q = probe.questionProbe;

      if (!q.found) {
        this.log('warn', `⏭️ 第 ${idx + 1}/${total} 题未找到可作答区域，跳过`);
        continue;
      }

      if (q.alreadyAnswered) {
        this.log(
          'info',
          `⏭️ 第 ${idx + 1}/${total} 题已作答/已提交，跳过`,
        );
        continue;
      }

      try {
        await this.solveCurrentQuestion(this.#config.autoSubmitHomework);
      } catch (error: unknown) {
        this.log(
          'error',
          `⚠️ 第 ${idx + 1}/${total} 题作答出错：${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // If single-view page has a "下一题" button and no order-bar, click it
      if (navInfo.mode === 'single' && idx + 1 < total) {
        await this.browser.webContents.executeJavaScript(
          buildClickNextQuestionButtonScript(),
          true,
        );
      }
      await this.sleep(1200);
    }

    this.#currentTaskTitle = '当前页题目作答完毕';
    this.log('success', '🎉 当前页面全部题目处理完毕');
    this.emitState();
    return this.getState();
  }

  async openSandbox(
    mode: 'directory' | 'homework' = 'homework',
  ): Promise<CourseBrushState> {
    const contents = this.browser.webContents;
    if (contents.isDestroyed()) {
      throw new Error('当前浏览器标签页不可用。');
    }
    this.#processedDirectoryKeys.clear();
    await contents.executeJavaScript(buildInstallSandboxScript(mode), true);
    await this.sleep(300);
    await this.probeCurrentPage(mode === 'homework');
    this.#currentTaskTitle =
      mode === 'directory'
        ? '已进入模拟课程目录（含视频/PPT/讨论/作业）'
        : '已进入模拟作业靶场（共 5 题全题型）';
    this.log(
      'success',
      mode === 'directory'
        ? '🎯 已在左侧浏览器生成「模拟课程刷课目录」（包含视频、课件PPT、讨论、5道全题型作业），可直接点击「启动自动刷课」体验全流程！'
        : '🎯 已在左侧浏览器生成「5道全题型模拟作业页」（单选/多选/判断/填空/主观），可直接点击「单题 AI 试答」或「自动作答本页全部题」联调！',
    );
    this.emitState();
    return this.getState();
  }

  private async runLoop(): Promise<void> {
    while (this.#status === 'running' || this.#status === 'paused') {
      if (this.#status === 'paused') {
        await this.sleep(1000);
        continue;
      }

      try {
        await this.stepOnce();
      } catch (error: unknown) {
        this.log(
          'error',
          `刷课循环异常：${error instanceof Error ? error.message : String(error)}`,
        );
        await this.sleep(2500);
      }
      await this.sleep(1200);
    }
  }

  private async stepOnce(): Promise<void> {
    const browserState = this.browser.getState();
    if (browserState.loading) {
      await this.sleep(1000);
      return;
    }

    try {
      this.browser.webContents.setAudioMuted(Boolean(this.#config.muteAudio));
    } catch {}

    // Always inject anti-blur/visibility protection & media speed/mute keep-alive
    await this.browser.webContents
      .executeJavaScript(buildEnsureMediaAndAntiCheckScript(this.#config), true)
      .catch(() => null);

    const probe = await this.probeCurrentPage(false);
    const isChildTab =
      Boolean(this.#parentTabId) &&
      browserState.activeTabId !== this.#parentTabId &&
      browserState.tabs.some((t) => t.id === this.#parentTabId);

    if (isChildTab) {
      this.#activeTaskTabId = browserState.activeTabId;
    }

    // 1. Handle active video / audio / classroom replay / courseware / ai-workspace content page
    if (
      probe.route === 'ai-workspace' ||
      probe.route === 'pro-lms-content' ||
      probe.route === 'classroom-replay' ||
      probe.route === 'v2-homework'
    ) {
      if (probe.route === 'ai-workspace' || probe.route === 'pro-lms-content') {
        const classroomMatch = probe.url.match(
          /\/ai-workspace\/lms-graph\/(\d+)/i,
        );
        const currentClassroomId = classroomMatch ? classroomMatch[1] : '';
        if (
          currentClassroomId &&
          currentClassroomId !== this.#lastAlignedClassroomId
        ) {
          this.#needFirstIncompleteAlignment = true;
          this.#lastAlignedClassroomId = currentClassroomId;
        }

        if (this.#needFirstIncompleteAlignment) {
          const alignResult = await this.alignToFirstIncompleteUnit();
          if (alignResult.waitingForSidebar) {
            this.#alignmentAttempts += 1;
            if (this.#alignmentAttempts <= 2) {
              this.#currentTaskTitle = '正在检测并读取课程目录进度…';
              this.emitState();
              await this.sleep(1200);
              return;
            }
            this.#needFirstIncompleteAlignment = false;
            this.#alignmentAttempts = 0;
            this.log(
              'info',
              'ℹ️ 侧边栏目录加载超时，直接从当前学习单元开刷',
            );
          } else if (alignResult.switched) {
            this.#needFirstIncompleteAlignment = false;
            this.#alignmentAttempts = 0;
            this.#mediaWaitTicks = 0;
            this.log(
              'info',
              `🎯 自动检测到全课首个未完成任务（第 ${(alignResult.targetIdx ?? 0) + 1}/${alignResult.total ?? '?'} 节）：${alignResult.title ?? ''}，正在自动跳转从首个未完成项开刷…`,
            );
            this.#currentTaskTitle = `正在跳转至首个未完成项：${alignResult.title ?? ''}`;
            this.emitState();
            await this.sleep(2800);
            return;
          } else if (alignResult.alreadyAtTarget) {
            this.#needFirstIncompleteAlignment = false;
            this.#alignmentAttempts = 0;
            this.log(
              'info',
              `🎯 自动检测确认：当前正是全课首个未完成任务（第 ${(alignResult.targetIdx ?? 0) + 1}/${alignResult.total ?? '?'} 节）：${alignResult.title ?? ''}，直接开始刷课`,
            );
          } else if (alignResult.allCompleted) {
            this.#needFirstIncompleteAlignment = false;
            this.#alignmentAttempts = 0;
            if (
              !probe.mediaStatus.hasVideo &&
              !probe.mediaStatus.hasAudio &&
              !probe.questionProbe.found
            ) {
              this.#currentTaskTitle = '🎉 当前课程全部任务已完成！';
              this.log(
                'success',
                '🎉 自动检测确认：当前课程所有已启用类型的任务均已完成！',
              );
              this.stop();
              return;
            }
          } else {
            this.#needFirstIncompleteAlignment = false;
            this.#alignmentAttempts = 0;
          }
        }
      }

      const finishedTask = await this.handleContentOrTaskPage(
        probe,
        isChildTab,
      );
      if (finishedTask) {
        this.#completedCount += 1;
        this.#mediaWaitTicks = 0;
        await this.finishTaskAndReturnToDirectory(isChildTab, probe.route);
      }
      return;
    }

    // 2. Handle V2 StudentLog or Pro LMS Directory Page
    if (
      probe.route === 'v2-student-log' ||
      probe.route === 'pro-lms-directory'
    ) {
      this.#parentTabId = browserState.activeTabId;
      this.#activeTaskTabId = null;

      // Check if an inline modal or courseware swiper is open on V2 page
      const inlineHandled = await this.handleV2InlineCoursewareOrMedia();
      if (inlineHandled) return;

      const tabsBefore = new Set(
        this.browser.getState().tabs.map((tab) => tab.id),
      );
      const urlBefore = browserState.url;

      const nextAction = (await this.browser.webContents.executeJavaScript(
        buildTriggerNextDirectoryItemScript(
          probe.route,
          this.#config,
          Array.from(this.#processedDirectoryKeys),
        ),
        true,
      )) as {
        status: 'clicked' | 'scrolled' | 'expanded' | 'all-done' | 'empty';
        key?: string;
        title?: string;
        itemType?: string;
      };

      if (nextAction.status === 'scrolled' || nextAction.status === 'expanded') {
        if (nextAction.key) {
          this.#processedDirectoryKeys.add(nextAction.key);
        }
        this.#currentTaskTitle =
          nextAction.status === 'expanded'
            ? `展开章节：${nextAction.title ?? ''}`
            : '正在滚动加载课程目录…';
        this.log('info', `📂 ${this.#currentTaskTitle}`);
        this.emitState();
        await this.sleep(1800);
        return;
      }

      if (nextAction.status === 'clicked') {
        if (nextAction.key) {
          this.#processedDirectoryKeys.add(nextAction.key);
        }
        this.#mediaWaitTicks = 0;
        this.#currentTaskTitle = `${nextAction.itemType ?? '任务'}：${nextAction.title ?? ''}`;
        this.log(
          'info',
          `👉 进入课程任务：[${nextAction.itemType ?? '未知'}] ${nextAction.title ?? ''}`,
        );
        this.emitState();
        await this.sleep(2800);

        // Check if clicking opened a new tab or navigated in-place
        const afterState = this.browser.getState();
        const newTab = afterState.tabs.find((t) => !tabsBefore.has(t.id));
        if (newTab) {
          this.#activeTaskTabId = newTab.id;
          this.browser.activateTab(newTab.id);
          this.log('info', `📑 已切换到新打开的任务标签页 (${newTab.id})`);
          this.emitState();
        } else if (afterState.url === urlBefore) {
          // Might be an inline video/audio/comment/courseware in V2 piliang
          await this.handleV2InlineCoursewareOrMedia();
        }
        return;
      }

      if (nextAction.status === 'all-done') {
        this.#currentTaskTitle = '🎉 当前课程目录全部任务已完成！';
        this.log('success', '🎉 当前课程目录下所有已启用类型的任务均已完成！');
        this.stop();
        return;
      }
    }

    this.#currentTaskTitle = '等待进入课程目录或作业页面…';
    this.emitState();
  }

  private async handleV2InlineCoursewareOrMedia(): Promise<boolean> {
    const inlineState = (await this.browser.webContents.executeJavaScript(
      buildCheckAndRunV2InlineTaskScript(this.#config),
      true,
    )) as {
      handled: boolean;
      kind: string;
      message: string;
      navigateBack: boolean;
    };

    if (!inlineState.handled) return false;
    this.#currentTaskTitle = inlineState.message;
    this.log('info', `⚡ ${inlineState.message}`);
    this.emitState();

    if (inlineState.navigateBack) {
      this.#completedCount += 1;
      const returnedInSandbox = await this.browser.webContents
        .executeJavaScript(
          'Boolean(window.__yktSandboxReturnToDirectory && window.__yktSandboxReturnToDirectory())',
          true,
        )
        .catch(() => false);
      if (!returnedInSandbox) {
        this.browser.back();
      }
      await this.sleep(2200);
    }
    return true;
  }

  private async alignToFirstIncompleteUnit(): Promise<{
    ready: boolean;
    waitingForSidebar?: boolean;
    noSidebar?: boolean;
    allCompleted?: boolean;
    alreadyAtTarget?: boolean;
    switched?: boolean;
    targetIdx?: number;
    activeIdx?: number;
    total?: number;
    title?: string;
  }> {
    const contents = this.browser.webContents;
    if (!contents || contents.isDestroyed()) {
      return { ready: false, noSidebar: true };
    }
    try {
      const res = (await contents.executeJavaScript(
        buildDetectAndJumpToFirstIncompleteScript(
          this.#config,
          Array.from(this.#completedLeafKeys),
        ),
        true,
      )) as {
        ready: boolean;
        waitingForSidebar?: boolean;
        noSidebar?: boolean;
        allCompleted?: boolean;
        alreadyAtTarget?: boolean;
        switched?: boolean;
        targetIdx?: number;
        activeIdx?: number;
        total?: number;
        title?: string;
      };
      return res;
    } catch {
      return { ready: false, noSidebar: true };
    }
  }

  private async handleContentOrTaskPage(
    probe: CourseBrushPageProbe,
    isChildTab: boolean,
  ): Promise<boolean> {
    if (probe.url !== this.#lastMediaUrl) {
      this.#lastMediaUrl = probe.url;
      this.#playedTicksOnUrl = 0;
      this.#speedHoverDoneForUrl = '';
      this.#mediaStuckTicks = 0;
      this.#lastMediaProgress = '';
    }

    const isDiscussUnit = Boolean(
      probe.url.includes('/forum/') ||
        probe.url.includes('/discuss/') ||
        probe.url.includes('/discussion/') ||
        probe.routeLabel.includes('讨论') ||
        probe.title.includes('讨论') ||
        probe.title.includes('[讨论]'),
    );

    // Case Discussion: Dedicated discussion unit handling (never skipped by mediaStatus.completed)
    if (isDiscussUnit) {
      if (!this.#config.enableDiscussion) {
        this.log('info', '⏭️ 已关闭讨论区刷课，跳过当前讨论单元');
        return true;
      }
      this.#mediaWaitTicks = 0;
      this.#mediaStuckTicks = 0;
      this.#lastMediaProgress = '';

      const extraResult = (await this.browser.webContents.executeJavaScript(
        buildHandleContentExtraTaskScript(this.#config),
        true,
      )) as {
        action: 'done' | 'waiting' | 'none';
        message: string;
      };

      if (extraResult.action === 'waiting') {
        this.#currentTaskTitle = extraResult.message;
        this.log('info', `⏳ ${extraResult.message}`);
        this.emitState();
        await this.sleep(2000);
        return false;
      }

      if (extraResult.action === 'done') {
        this.log('success', `✅ ${extraResult.message}`);
        await this.markCurrentUnitCompleted(probe);
        return true;
      }

      const discussWait = (this.#unitReloadAttempts.get(probe.url) ?? 0) + 1;
      this.#unitReloadAttempts.set(probe.url, discussWait);
      if (discussWait <= 3) {
        this.#currentTaskTitle = `正在等待讨论区加载 (${discussWait}/3)…：${probe.title}`;
        this.emitState();
        await this.sleep(1500);
        return false;
      }

      this.#unitReloadAttempts.delete(probe.url);
      this.log('warn', `⚠️ 讨论区未找到评论输入框或已无需发言：${probe.title}`);
      await this.markCurrentUnitCompleted(probe);
      return true;
    }

    const isMediaUnit =
      !isDiscussUnit &&
      (probe.route === 'ai-workspace'
        ? Boolean(
            probe.routeLabel.includes('视频') ||
              probe.routeLabel.includes('音频') ||
              /\/ai-workspace\/lms-graph\/[^/]+\/(video|audio)\//i.test(
                probe.url,
              ),
          )
        : Boolean(
            probe.mediaStatus.hasVideo ||
              probe.mediaStatus.hasAudio ||
              probe.routeLabel.includes('视频') ||
              probe.routeLabel.includes('音频') ||
              probe.url.includes('/video-student/'),
          ));

    if (probe.mediaStatus.completed) {
      this.#mediaWaitTicks = 0;
      this.#mediaStuckTicks = 0;
      this.#lastMediaProgress = '';

      const alreadyVerifiedBySidebar = Boolean(
        probe.mediaStatus.progressText?.startsWith('左侧栏已完成'),
      );

      if (
        isMediaUnit &&
        probe.route === 'ai-workspace' &&
        !alreadyVerifiedBySidebar
      ) {
        this.#currentTaskTitle = `正在刷新页面并读取左侧栏观看进度：${probe.title}`;
        this.log(
          'info',
          `🔄 视频播放至结尾，正在刷新页面并自动读取左侧栏观看进度：${probe.title}`,
        );
        this.emitState();

        await this.browser.webContents
          .executeJavaScript(
            '(() => { window.__yktProgressCache = null; })()',
            true,
          )
          .catch(() => null);
        this.browser.reload();
        await this.sleep(3600);
        for (let waitIdx = 0; waitIdx < 4; waitIdx += 1) {
          if (!this.browser.getState().loading) break;
          await this.sleep(800);
        }
        await this.sleep(800);

        const freshProbe = await this.probeCurrentPage(false, true);
        const sidebarNowDone = Boolean(
          freshProbe.mediaStatus.completed ||
            freshProbe.mediaStatus.progressText?.startsWith('左侧栏已完成'),
        );

        if (sidebarNowDone) {
          this.#unitReloadAttempts.delete(probe.url);
          this.log(
            'success',
            `✅ 刷新后读取左侧栏进度：已完成 (${freshProbe.mediaStatus.progressText ?? '100%'})，待刷目录项剩余 ${freshProbe.directoryItemsPending}/${freshProbe.directoryItemsTotal}：${probe.title}`,
          );
          await this.markCurrentUnitCompleted(probe);
          return true;
        }

        const attempts = (this.#unitReloadAttempts.get(probe.url) ?? 0) + 1;
        this.#unitReloadAttempts.set(probe.url, attempts);
        if (attempts <= 2) {
          this.#playedTicksOnUrl = 0;
          this.#speedHoverDoneForUrl = '';
          this.log(
            'warn',
            `⚠️ 刷新后读取左侧栏进度仍未满 100% (${freshProbe.mediaStatus.progressText ?? '未完成'})，已自动对齐进度条继续补刷 (第 ${attempts}/2 次)：${probe.title}`,
          );
          return false;
        }

        this.log(
          'warn',
          `⚠️ 当前视频已连续刷新补刷 ${attempts} 次，先切换下一未完成单元：${probe.title}`,
        );
        await this.markCurrentUnitCompleted(probe);
        return true;
      }

      this.log(
        'success',
        `✅ 当前学习单元已完成（${probe.mediaStatus.progressText ?? '已完成'}）：${probe.title}`,
      );
      await this.markCurrentUnitCompleted(probe);
      return true;
    }

    // Case A: Video or Audio unit
    if (isMediaUnit) {
      if (!this.#config.enableVideo) {
        this.log('info', '⏭️ 已关闭音视频刷课，跳过当前音视频单元');
        return true;
      }
      if (probe.mediaStatus.hasVideo || probe.mediaStatus.hasAudio) {
        this.#mediaWaitTicks = 0;
        if (!probe.mediaStatus.paused) {
          this.#playedTicksOnUrl += 1;
        }

        if (
          this.#speedHoverDoneForUrl !== probe.url ||
          (probe.mediaStatus.playbackRate !== null &&
            Math.abs(
              probe.mediaStatus.playbackRate - this.#config.playbackRate,
            ) > 0.05)
        ) {
          await this.ensureNativeVideoSpeed(probe.url);
        }

        const progressSig = `${probe.url}::${probe.mediaStatus.progressText ?? ''}`;
        if (
          probe.mediaStatus.paused ||
          progressSig === this.#lastMediaProgress
        ) {
          this.#mediaStuckTicks += 1;
        } else {
          this.#mediaStuckTicks = 0;
        }
        this.#lastMediaProgress = progressSig;

        if (this.#mediaStuckTicks >= 12) {
          this.#mediaStuckTicks = 0;
          this.#lastMediaProgress = '';
          this.log(
            'info',
            `⏭️ 当前音视频长时间未继续推进，正在刷新重读左侧栏进度：${probe.title}`,
          );
          return true;
        }

        this.#currentTaskTitle = `播放中 (${this.#config.playbackRate}x${this.#config.muteAudio ? '·静音' : ''})：${probe.title} [${probe.mediaStatus.progressText ?? '进行中'}]`;
        this.emitState();
        await this.sleep(2500);
        return false;
      }

      // Media element is still loading in the DOM — wait up to ~20s before giving up
      this.#mediaWaitTicks += 1;
      if (this.#mediaWaitTicks <= 10) {
        this.#currentTaskTitle = `正在等待音视频播放器加载 (${this.#mediaWaitTicks}/10)…`;
        this.emitState();
        await this.sleep(2000);
        return false;
      }
      this.#mediaWaitTicks = 0;
      this.log('warn', '⚠️ 等待音视频播放器加载超时，跳过当前单元');
      return true;
    }

    // Case B: Page has homework/exercise questions
    if (probe.questionProbe.found) {
      if (!this.#config.enableHomework) {
        this.log('info', '⏭️ 已关闭 AI 自动答题，跳过当前作业单元');
        return true;
      }
      await this.solveAllQuestionsOnCurrentPage();
      await this.markCurrentUnitCompleted(probe);
      return true;
    }

    // Case C: Discussion / Tuwen / PPT Courseware / Quiz Cover Page
    const extraResult = (await this.browser.webContents.executeJavaScript(
      buildHandleContentExtraTaskScript(this.#config),
      true,
    )) as {
      action: 'done' | 'waiting' | 'none';
      message: string;
    };

    if (extraResult.action === 'waiting') {
      this.#currentTaskTitle = extraResult.message;
      this.log('info', `⏳ ${extraResult.message}`);
      this.emitState();
      await this.sleep(2000);
      return false;
    }

    if (extraResult.action === 'done') {
      this.log('success', `✅ ${extraResult.message}`);
      await this.markCurrentUnitCompleted(probe);
      return true;
    }

    // If on a quiz/homework route that is still loading its iframe/questions, wait a few ticks
    if (
      probe.routeLabel.includes('作业') ||
      probe.routeLabel.includes('测验') ||
      /\/ai-workspace\/lms-graph\/[^/]+\/(exercise|quiz|homework)\//i.test(
        probe.url,
      )
    ) {
      this.#mediaWaitTicks += 1;
      if (this.#mediaWaitTicks <= 5) {
        this.#currentTaskTitle = `正在等待作业/测验内容加载 (${this.#mediaWaitTicks}/5)…`;
        this.emitState();
        await this.sleep(2000);
        return false;
      }
      this.#mediaWaitTicks = 0;
    }

    // If it's a child tab or content page with nothing left to do
    if (
      isChildTab ||
      probe.route === 'pro-lms-content' ||
      probe.route === 'ai-workspace'
    ) {
      await this.sleep(1500);
      return true;
    }

    return false;
  }

  #speedAttemptsByUrl = new Map<string, number>();

  /**
   * Switch Yuketang's <xt-video-player> to the configured speed exactly like a
   * real user would: hover the video (wakes xt-controls), hover xt-speedbutton
   * (native CSS :hover opens xt-speedlist), then a real native mouse click on
   * the target speed item. We deliberately do NOT write media.playbackRate
   * here, because the player resets it to its own internal speed and logs a
   * flood of `ratechange` events into heart_data, which ruins watch credit.
   */
  private async ensureNativeVideoSpeed(url: string): Promise<void> {
    const contents = this.browser.webContents;
    if (!contents || contents.isDestroyed()) return;
    const targetRate = Number(this.#config.playbackRate) || 2;
    const attempts = (this.#speedAttemptsByUrl.get(url) ?? 0) + 1;
    if (attempts > 8) return;
    this.#speedAttemptsByUrl.set(url, attempts);

    try {
      const res = (await contents.executeJavaScript(
        `(() => {
          const targetRate = ${JSON.stringify(targetRate)};
          const docs = [{ doc: document, frameEl: null }];
          for (const ifr of Array.from(document.querySelectorAll('iframe'))) {
            try {
              if (ifr.contentDocument && ifr.contentDocument.body) {
                docs.push({ doc: ifr.contentDocument, frameEl: ifr });
              }
            } catch {}
          }

          function parseRate(text) {
            const m = String(text || '').replace(/\\s+/g, '').match(/([0-9]+(?:\\.[0-9]+)?)/);
            return m ? Number(m[1]) : NaN;
          }

          function lockPlaybackRate(media, rate) {
            if (!media) return;
            const win = media.ownerDocument.defaultView || window;
            const proto = win.HTMLMediaElement ? win.HTMLMediaElement.prototype : null;
            const desc = proto ? Object.getOwnPropertyDescriptor(proto, 'playbackRate') : null;
            if (desc && desc.set) {
              desc.set.call(media, rate);
              media.defaultPlaybackRate = rate;
              if (!media.__yktRateHooked) {
                media.__yktDesiredRate = rate;
                media.__yktRateHooked = true;
                Object.defineProperty(media, 'playbackRate', {
                  configurable: true,
                  enumerable: true,
                  get() {
                    return media.__yktDesiredRate || rate;
                  },
                  set(v) {
                    const t = media.__yktDesiredRate || rate;
                    desc.set.call(media, t);
                  },
                });
              } else {
                media.__yktDesiredRate = rate;
              }
            } else {
              media.defaultPlaybackRate = rate;
              media.playbackRate = rate;
            }
          }

          for (const { doc } of docs) {
            const media = doc.querySelector('video, audio');
            if (!media) continue;

            const win = doc.defaultView || window;
            const speedBtn = doc.querySelector('xt-speedbutton');
            const speedValEl = doc.querySelector('xt-speedvalue');
            const speedValText = (speedValEl?.textContent || '').replace(/\\s+/g, '').toUpperCase();

            // 1. Permanently lock native playback rate on media element
            lockPlaybackRate(media, targetRate);

            if (!speedBtn) {
              return {
                found: true,
                ok: true,
                noPlayerUi: true,
                rate: media.playbackRate,
                speedValText,
              };
            }

            // 2. Dispatch hover on speed button to wake up list
            const enterEv = new win.MouseEvent('mouseenter', { bubbles: true, cancelable: true, composed: true });
            const overEv = new win.MouseEvent('mouseover', { bubbles: true, cancelable: true, composed: true });
            speedBtn.dispatchEvent(enterEv);
            speedBtn.dispatchEvent(overEv);

            const list = speedBtn.querySelector('xt-speedlist') || doc.querySelector('xt-speedlist');
            let clicked = false;
            let clickedText = '';

            if (list) {
              const items = Array.from(list.querySelectorAll('[data-speed], xt-button, li'));

              let target = items.find((el) => {
                const ds = Number(el.getAttribute('data-speed'));
                if (Number.isFinite(ds) && Math.abs(ds - targetRate) < 0.01) return true;
                const keyt = Number(el.getAttribute('keyt'));
                if (Number.isFinite(keyt) && Math.abs(keyt - targetRate) < 0.01) return true;
                return Math.abs(parseRate(el.textContent) - targetRate) < 0.01;
              });

              const fastRewriteItem =
                doc.querySelector('xt-speedlist xt-button') ||
                list.firstElementChild?.firstElementChild ||
                items[0];

              if (!target && fastRewriteItem) {
                target = fastRewriteItem;
                target.setAttribute('data-speed', String(targetRate));
                target.setAttribute('keyt', targetRate.toFixed(2));
                target.textContent = targetRate.toFixed(2) + 'X';
              }

              if (target) {
                const evOpts = { bubbles: true, cancelable: true, composed: true };
                try {
                  target.dispatchEvent(new win.PointerEvent('pointerdown', evOpts));
                } catch {}
                target.dispatchEvent(new win.MouseEvent('mousedown', evOpts));
                try {
                  target.dispatchEvent(new win.PointerEvent('pointerup', evOpts));
                } catch {}
                target.dispatchEvent(new win.MouseEvent('mouseup', evOpts));
                target.dispatchEvent(new win.MouseEvent('click', evOpts));
                if (typeof target.click === 'function') {
                  target.click();
                }
                clicked = true;
                clickedText = (target.textContent || '').trim();
              }
            }

            speedBtn.dispatchEvent(new win.MouseEvent('mouseleave', { bubbles: true, cancelable: true, composed: true }));

            // 3. Synchronize UI label
            if (speedValEl) {
              speedValEl.textContent = targetRate.toFixed(2) + 'X';
            }

            // Ensure media is still locked at targetRate
            lockPlaybackRate(media, targetRate);

            return {
              found: true,
              ok: true,
              clicked,
              clickedText,
              rate: media.playbackRate,
              speedValText: speedValEl ? speedValEl.textContent : speedValText,
            };
          }

          return { found: false };
        })()`,
        true,
      )) as {
        found: boolean;
        ok?: boolean;
        clicked?: boolean;
        clickedText?: string;
        rate?: number;
        speedValText?: string;
      } | null;

      if (res && res.found) {
        this.#speedHoverDoneForUrl = url;
        this.#speedAttemptsByUrl.delete(url);
        this.log(
          'success',
          `⏩ 已切换视频播放倍速为 ${targetRate}X（播放器 UI：${res.speedValText || `${targetRate}X`}，内核速率：${res.rate ?? targetRate}x）`,
        );
      }
    } catch {
      // Ignore transient errors during navigation
    }
  }

  private async markCurrentUnitCompleted(
    probe: CourseBrushPageProbe,
  ): Promise<void> {
    const keys: string[] = [];
    if (probe.url) keys.push(probe.url);
    const m =
      probe.url.match(
        /\/ai-workspace\/lms-graph\/(\d+)\/([^/?#]+)\/(\d+)/i,
      ) || probe.url.match(/node_id=(\d+)/i);
    const leafId = m && m[3] ? m[3] : m && m[1] ? m[1] : '';
    if (leafId && /^\d+$/.test(leafId)) keys.push(leafId);

    for (const k of keys) {
      this.#completedLeafKeys.add(k);
    }

    try {
      if (app?.isReady?.()) {
        const cacheFile = join(app.getPath('userData'), 'course-brush-cache.json');
        void writeFile(
          cacheFile,
          JSON.stringify(Array.from(this.#completedLeafKeys)),
          'utf8',
        ).catch(() => null);
      }
    } catch {}

    try {
      const contents = this.browser.webContents;
      if (contents && !contents.isDestroyed()) {
        await contents
          .executeJavaScript(
            `(() => {
              try {
                const keys = ${JSON.stringify(keys)};
                const cur = JSON.parse(localStorage.getItem('__ykt_completed_units') || '[]');
                const set = new Set(cur.concat(keys));
                localStorage.setItem('__ykt_completed_units', JSON.stringify(Array.from(set)));
              } catch {}
            })()`,
            true,
          )
          .catch(() => null);
      }
    } catch {
      // Ignore transient script errors
    }
  }

  private async finishTaskAndReturnToDirectory(
    isChildTab: boolean,
    route: CourseBrushPageRoute,
  ): Promise<void> {
    const state = this.browser.getState();

    const returnedInSandbox = await this.browser.webContents
      .executeJavaScript(
        'Boolean(window.__yktSandboxReturnToDirectory && window.__yktSandboxReturnToDirectory())',
        true,
      )
      .catch(() => false);
    if (returnedInSandbox) {
      this.log('info', '🔙 模拟靶场任务完成，已自动返回模拟课程目录页');
      await this.sleep(1500);
      return;
    }

    // 1. On AI Workspace or Pro LMS content page, advance directly to the next unfinished enabled unit in the sidebar!
    if (route === 'pro-lms-content' || route === 'ai-workspace') {
      const advanced = (await this.browser.webContents.executeJavaScript(
        buildAdvanceToNextUnitOrBackScript(
          this.#config,
          Array.from(this.#processedDirectoryKeys),
          Array.from(this.#completedLeafKeys),
        ),
        true,
      )) as { advanced: boolean; key?: string; message: string };
      if (advanced.advanced) {
        if (advanced.key) {
          this.#processedDirectoryKeys.add(advanced.key);
        }
        this.#mediaWaitTicks = 0;
        this.log('info', `⏭️ ${advanced.message}`);
        await this.sleep(2500);
        return;
      }
    }

    // 2. If no more units in current page and we are in a child tab opened from a parent directory tab, close child tab and return to parent
    if (
      isChildTab &&
      this.#parentTabId &&
      state.tabs.some((t) => t.id === this.#parentTabId)
    ) {
      const childTabId = state.activeTabId;
      this.log(
        'info',
        `🔙 子标签页任务完成，关闭 (${childTabId}) 并切回课程目录页 (${this.#parentTabId})`,
      );
      this.browser.activateTab(this.#parentTabId);
      await this.browser.closeTab(childTabId);
      this.#activeTaskTabId = null;
      await this.sleep(2000);
      return;
    }

    if (state.canGoBack) {
      this.log('info', '🔙 返回上一级课程目录页');
      this.browser.back();
      await this.sleep(2500);
    } else {
      this.log('info', '✅ 当前课程任务已全部处理完成');
      this.stop();
    }
  }

  private attachWebContentsHooks(contents: WebContents): void {
    const onNavigate = () => {
      void this.handlePageNavigation(contents);
    };
    contents.on('did-finish-load', onNavigate);
    contents.on('did-navigate-in-page', onNavigate);
  }

  private async handlePageNavigation(contents: WebContents): Promise<void> {
    for (const delay of [700, 2200]) {
      await this.sleep(delay);
      if (contents.isDestroyed() || contents !== this.browser.webContents) {
        return;
      }
      const url = contents.getURL() || '';
      if (!url || url === 'about:blank') return;
      try {
        await this.probeCurrentPage(false, true);
      } catch {
        // Ignore transient navigation errors
      }
    }
  }

  private async syncInPageHud(): Promise<void> {
    try {
      const contents = this.browser.webContents;
      if (!contents || contents.isDestroyed()) return;
      const url = contents.getURL() || '';
      if (!url || url === 'about:blank') return;
      await contents.executeJavaScript(
        `(() => { try { document.getElementById('ykt-native-brush-hud')?.remove(); } catch {} })()`,
        true,
      );
    } catch {
      // Ignore errors while page is navigating
    }
  }

  private async captureQuestionRect(
    rect: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    } | null,
  ): Promise<string> {
    const contents = this.browser.webContents;
    await contents
      .executeJavaScript(
        `(() => { const h = document.getElementById('ykt-native-brush-hud'); if (h) h.style.visibility = 'hidden'; })()`,
        true,
      )
      .catch(() => null);
    try {
      if (
        rect &&
        Number.isFinite(rect.x) &&
        Number.isFinite(rect.y) &&
        Number.isFinite(rect.width) &&
        Number.isFinite(rect.height) &&
        rect.width >= 30 &&
        rect.height >= 30
      ) {
        const captureRect = {
          x: Math.max(0, Math.floor(rect.x)),
          y: Math.max(0, Math.floor(rect.y)),
          width: Math.max(30, Math.ceil(rect.width)),
          height: Math.max(30, Math.ceil(rect.height)),
        };
        const cropped = await contents.capturePage(captureRect);
        if (!cropped.isEmpty()) {
          return cropped.toDataURL();
        }
      }
      return await this.browser.captureCurrentPage();
    } finally {
      await contents
        .executeJavaScript(
          `(() => { const h = document.getElementById('ykt-native-brush-hud'); if (h) h.style.visibility = 'visible'; })()`,
          true,
        )
        .catch(() => null);
    }
  }

  private log(
    level: CourseBrushLogItem['level'],
    message: string,
    details?: string,
  ): void {
    const item: CourseBrushLogItem = {
      id: this.#nextLogId++,
      timestamp: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      level,
      message,
      ...(details ? { details } : {}),
    };
    this.#logs = [item, ...this.#logs].slice(0, MAX_LOGS);
  }

  private emitState(): void {
    const state = this.getState();
    this.onStateChanged(state);
    void this.syncInPageHud();
    try {
      if (app?.isReady?.()) {
        void writeFile(
          join(app.getPath('userData'), 'course-brush-state.json'),
          JSON.stringify(
            {
              ...state,
              lastProbe: state.lastProbe
                ? {
                    ...state.lastProbe,
                    questionProbe: {
                      ...state.lastProbe.questionProbe,
                      screenshotDataUrl: state.lastProbe.questionProbe
                        .screenshotDataUrl
                        ? '[captured]'
                        : undefined,
                    },
                  }
                : null,
            },
            null,
            2,
          ),
          'utf8',
        ).catch(() => null);
      }
    } catch {
      // Ignore in unit tests where electron.app is not active
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function buildHomeworkAiPrompt(q: CourseBrushQuestionProbe): string {
  const optionLines = q.options.length
    ? q.options
        .map(
          (opt) =>
            `${opt.label}. ${opt.text || '（请直接查看截图中该选项的内容）'}`,
        )
        .join('\n')
    : '';
  const typeInstruction =
    q.questionType === 'single'
      ? `这是一道【单选题】。可用选项标号为：${q.options.map((o) => o.label).join(', ') || 'A, B, C, D'}。数组 answer 中只能包含 1 个最准确的选项标号（例如 ["A"]）。`
      : q.questionType === 'multiple'
        ? `这是一道【多选题】。可用选项标号为：${q.options.map((o) => o.label).join(', ') || 'A, B, C, D'}。数组 answer 中应包含所有正确选项标号（例如 ["A", "C"]）。`
        : q.questionType === 'judge'
          ? `这是一道【判断题】。可用选项标号为：${q.options.map((o) => o.label).join(', ') || '对, 错'}。请输出对应的选项标号（例如 ["对"] 或 ["错"]，若选项标号是 A/B 则输出 ["A"] 或 ["B"]）。`
          : q.questionType === 'blank'
            ? `这是一道【填空题】，共有 ${Math.max(1, q.blankCount)} 个空。数组 answer 请按顺序依次给出每个空的标准填写内容（例如 ["答案1", "答案2"]）。`
            : `这是一道【主观/简答题】或综合题。若图中是选择题请输出选项字母（如 ["A"]），若是简答题请在 answer 数组中给出简洁准确的作答文本（如 ["答：..."]）。`;

  return [
    '你是一个专业的雨课堂课程作业与习题解答助手。请结合附带的【当前题目高清原生截图】与下方辅助信息，给出最准确的答案。',
    q.hasEncryptedFont
      ? '⚠️ 重要提示：该页面使用了雨课堂加密字体（xuetangx-com-encrypted-font），下方提取的纯文本中可能存在字形替换或乱码，请【务必以附带的图片截图中的真实视觉文字和公式为准】进行审题和作答！'
      : '请同时参考截图中的公式/图表与下方提取的题干文本。',
    typeInstruction,
    q.stemText ? `【DOM 辅助题干文本】\n${q.stemText}` : '',
    optionLines ? `【DOM 辅助选项列表】\n${optionLines}` : '',
    '请严格只输出如下 JSON 格式（不要输出多余的寒暄）：',
    '{"answer": ["答案"], "explanation": "简短解题依据"}',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function parseCourseBrushAiAnswer(
  q: CourseBrushQuestionProbe,
  rawText: string,
): { answers: string[]; explanation: string } {
  const cleaned = rawText.trim();
  let rawAnswers: string[] = [];
  let explanation = '';

  const jsonMatch =
    cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ??
    cleaned.match(/\{[\s\S]*\}/)?.[0];
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch) as Record<string, unknown>;
      if (typeof parsed.explanation === 'string') {
        explanation = parsed.explanation.trim();
      }
      if (Array.isArray(parsed.answer)) {
        rawAnswers = parsed.answer
          .map((item) => String(item ?? '').trim())
          .filter(Boolean);
      } else if (
        typeof parsed.answer === 'string' ||
        typeof parsed.answer === 'number'
      ) {
        rawAnswers = [String(parsed.answer).trim()].filter(Boolean);
      }
    } catch {
      // Fallback to text parsing below
    }
  }

  if (
    q.questionType === 'single' ||
    q.questionType === 'multiple' ||
    q.questionType === 'judge' ||
    (q.questionType === 'unknown' && q.options.length > 0)
  ) {
    const validLabels = q.options.map((o) => o.label.toUpperCase());
    const joined = rawAnswers.length ? rawAnswers.join(' ') : cleaned;

    // Handle true/false mapping
    if (
      q.questionType === 'judge' ||
      validLabels.includes('对') ||
      validLabels.includes('错')
    ) {
      const isTrue = /(?:^|[^不])(正确|对|true|yes|√|\bA\b)/i.test(joined);
      const isFalse = /(错误|错|false|no|×|\bB\b)/i.test(joined);
      if (validLabels.includes('对') || validLabels.includes('错')) {
        if (isTrue && !isFalse) return { answers: ['对'], explanation };
        if (isFalse) return { answers: ['错'], explanation };
      }
      if (validLabels.includes('正确') || validLabels.includes('错误')) {
        if (isTrue && !isFalse) return { answers: ['正确'], explanation };
        if (isFalse) return { answers: ['错误'], explanation };
      }
    }

    const letters = (
      joined
        .toUpperCase()
        .replace(/[^A-H]/g, '')
        .split('') || []
    ).filter((ch, idx, arr) => arr.indexOf(ch) === idx);
    const filteredLetters = validLabels.length
      ? letters.filter((ch) => validLabels.includes(ch))
      : letters;
    if (filteredLetters.length) {
      return {
        answers:
          q.questionType === 'single' || q.questionType === 'judge'
            ? [filteredLetters[0]!]
            : filteredLetters,
        explanation,
      };
    }
  }

  if (rawAnswers.length) {
    return { answers: rawAnswers, explanation };
  }

  return {
    answers: cleaned ? [cleaned] : [],
    explanation,
  };
}

/**
 * Maps the server progress list onto sidebar leaf boxes strictly in catalog order.
 * Every chapter can have units with identical titles (e.g. "讨论一"), so a global
 * fuzzy title search maps later chapters onto chapter 1's completed entries. We walk
 * both lists with a forward-only pointer so each server entry is consumed once.
 */
const ORDERED_PROGRESS_MAPPING_JS = String.raw`
    function yktCleanTitle(s) {
      let t = String(s || '').trim();
      t = t.replace(/^(?:\[[^\]]+\]|【[^】]+】)\s*/, '');
      t = t.replace(/^(?:视频|音频|课件|文档|作业|练习|测验|讨论|图文)\s+/i, '');
      t = t.replace(/^(视频|音频|课件|文档|作业|练习|测验|讨论|图文)\1/i, '$1');
      return t.replace(/[\s\-_—·:：/\\()[\]{}【】（）]/g, '').toLowerCase();
    }
    function yktApplyOrderedProgress(boxes, list) {
      if (!boxes || !list || !Array.isArray(list) || list.length === 0) return;
      const boxArr = Array.from(boxes);
      if (boxArr.length === 0) return;

      // 1. Direct 1-to-1 mapping if counts match exactly
      if (boxArr.length === list.length) {
        for (let i = 0; i < boxArr.length; i += 1) {
          const box = boxArr[i];
          const m = list[i];
          if (!box || !m) continue;
          box.setAttribute('data-ykt-leaf-id', String(m.id));
          if (m.leafType !== undefined) box.setAttribute('data-ykt-leaf-type', String(m.leafType));
          const pct = Math.min(100, Math.max(0, Math.round((m.progress || 0) * 100)));
          box.setAttribute('data-ykt-leaf-pct', String(pct));
          if ((m.progress || 0) >= 0.995) box.setAttribute('data-ykt-leaf-done', 'true');
          else box.removeAttribute('data-ykt-leaf-done');
        }
        return;
      }

      // 2. Strict sequential forward pointer matching if counts differ
      let ptr = 0;
      for (const box of boxArr) {
        const nb = yktCleanTitle(box.textContent);
        if (!nb) continue;
        let hit = -1;
        for (let j = ptr; j < list.length; j += 1) {
          const n = yktCleanTitle(list[j].name);
          if (!n) continue;
          if (n === nb || (nb.length >= 4 && n.includes(nb)) || (n.length >= 4 && nb.includes(n))) {
            hit = j;
            break;
          }
        }
        if (hit === -1) continue;
        ptr = hit + 1;
        const m = list[hit];
        box.setAttribute('data-ykt-leaf-id', String(m.id));
        if (m.leafType !== undefined) box.setAttribute('data-ykt-leaf-type', String(m.leafType));
        const pct = Math.min(100, Math.max(0, Math.round((m.progress || 0) * 100)));
        box.setAttribute('data-ykt-leaf-pct', String(pct));
        if ((m.progress || 0) >= 0.995) box.setAttribute('data-ykt-leaf-done', 'true');
        else box.removeAttribute('data-ykt-leaf-done');
      }
    }
`;

function buildDomProbeScript(): string {
  return `(async () => {
${ORDERED_PROGRESS_MAPPING_JS}
    const url = location.href;
    let title = document.title || '';

    function getAccessibleDocs() {
      const docs = [{ doc: document, frameEl: null }];
      for (const ifr of Array.from(document.querySelectorAll('iframe'))) {
        try {
          if (ifr.contentDocument && ifr.contentDocument.body) {
            docs.push({ doc: ifr.contentDocument, frameEl: ifr });
          }
        } catch {}
      }
      return docs;
    }

    function queryAllDocs(selector) {
      const out = [];
      for (const { doc } of getAccessibleDocs()) {
        try {
          out.push(...Array.from(doc.querySelectorAll(selector)));
        } catch {}
      }
      return out;
    }

    function queryFirstDoc(selector) {
      for (const { doc } of getAccessibleDocs()) {
        try {
          const el = doc.querySelector(selector);
          if (el) return el;
        } catch {}
      }
      return null;
    }

    function isVisible(el) {
      if (!el || el.nodeType !== 1) return false;
      if (el.closest && el.closest('#ykt-native-brush-hud')) return false;
      const win = el.ownerDocument?.defaultView || window;
      const style = win.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 4 && rect.height > 4;
    }

    function getScreenRect(el) {
      const r = el.getBoundingClientRect();
      let offsetX = 0;
      let offsetY = 0;
      if (el.ownerDocument !== document) {
        const hostFrame = Array.from(document.querySelectorAll('iframe')).find((f) => {
          try { return f.contentDocument === el.ownerDocument; } catch { return false; }
        });
        if (hostFrame) {
          const fr = hostFrame.getBoundingClientRect();
          offsetX = fr.left;
          offsetY = fr.top;
        }
      }
      return {
        left: r.left + offsetX,
        top: r.top + offsetY,
        width: r.width,
        height: r.height,
      };
    }

    const allDocUrls = getAccessibleDocs().map((d) => {
      try { return d.doc.location?.href || ''; } catch { return ''; }
    });

    const activeLeafBox = queryFirstDoc('.nav-item-leaf-box .leaf-item.is-active, .nav-item-leaf-box .leaf-item.active, .leaf-item.is-active, .leaf-item.active, .nav-item-leaf-box.is-active, .nav-item-leaf-box.active')?.closest('.nav-item-leaf-box') ||
      queryFirstDoc('.nav-item-leaf-box.is-active, .nav-item-leaf-box.active, .leaf-item.is-active, .leaf-item.active');
    const activeLeafText = (activeLeafBox?.textContent || '').replace(/\\s+/g, ' ').trim();
    if (url.includes('/ai-workspace/lms-graph/') && activeLeafText) {
      title = activeLeafText.slice(0, 60);
    }

    // Fetch & sync left-sidebar watching progress for AI Workspace
    const aiMatch = url.match(/\\/ai-workspace\\/lms-graph\\/(\\d+)(?:\\/[^/?#]+\\/(\\d+))?/i);
    const aiClassroomId = aiMatch ? aiMatch[1] : '';
    const aiCurrentLeafId = aiMatch && aiMatch[2] ? aiMatch[2] : '';

    if (aiClassroomId) {
      const now = Date.now();
      const cache = window.__yktProgressCache;
      if (!cache || cache.classroomId !== aiClassroomId || now - cache.ts > 3500) {
        try {
          const resp = await fetch('/c27/online_courseware/schedule/course/progress/?classroom_id=' + aiClassroomId, {
            credentials: 'include',
          });
          if (resp.ok) {
            const json = await resp.json();
            const list = [];
            const byId = {};
            function walkProgress(nodes) {
              if (!Array.isArray(nodes)) return;
              for (const node of nodes) {
                if (!node || typeof node !== 'object') continue;
                if (Array.isArray(node.section_leaf_list)) {
                  walkProgress(node.section_leaf_list);
                } else if (Array.isArray(node.children)) {
                  walkProgress(node.children);
                } else if (node.id !== undefined && node.progress !== undefined) {
                  const item = {
                    id: String(node.id),
                    name: String(node.name || '').replace(/\\s+/g, ' ').trim(),
                    leafType: node.leaf_type,
                    progress: Number(node.progress || 0),
                  };
                  list.push(item);
                  byId[item.id] = item;
                }
              }
            }
            walkProgress(json?.data?.course_progress);
            if (list.length > 0) {
              window.__yktProgressCache = {
                classroomId: aiClassroomId,
                ts: now,
                list,
                byId,
              };
            }
          }
        } catch {}
      }

      const activeCache = window.__yktProgressCache;
      if (activeCache && Array.isArray(activeCache.list) && activeCache.list.length > 0) {
        yktApplyOrderedProgress(queryAllDocs('.nav-item-leaf-box'), activeCache.list);
      }
    }

    function isAiWorkspaceCurrentUnitCompleted() {
      if (!url.includes('/ai-workspace/lms-graph/')) return false;
      const cache = window.__yktProgressCache;
      if (aiCurrentLeafId && cache?.byId?.[aiCurrentLeafId]) {
        if ((cache.byId[aiCurrentLeafId].progress || 0) >= 0.995) return true;
      }
      try {
        const completedStorage = JSON.parse(localStorage.getItem('__ykt_completed_units') || '[]');
        if (Array.isArray(completedStorage) && completedStorage.length > 0) {
          if (aiCurrentLeafId && completedStorage.includes(aiCurrentLeafId)) return true;
          if (completedStorage.includes(url)) return true;
        }
      } catch {}
      if (activeLeafBox) {
        const attrDone = activeLeafBox.getAttribute('data-ykt-leaf-done');
        if (attrDone === 'true') return true;
        const pct = activeLeafBox.getAttribute('data-ykt-leaf-pct');
        if (pct !== null && Number(pct) >= 99) return true;
      }
      const candidates = document.querySelectorAll('span, div, p, em, i, b, strong');
      for (const el of candidates) {
        if (!el || el.children.length > 2) continue;
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!/^(已完成|已提交|已读|100%)$/.test(t)) continue;
        if (!isVisible(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.left >= 300 && r.top >= 30 && r.top <= 280) {
          return true;
        }
      }
      return false;
    }

    const aiUnitCompleted = isAiWorkspaceCurrentUnitCompleted();

    function isAiBoxDone(box) {
      if (!box) return false;
      const attrDone = box.getAttribute('data-ykt-leaf-done');
      if (attrDone === 'true') return true;
      const pct = box.getAttribute('data-ykt-leaf-pct');
      if (pct !== null && Number(pct) >= 99) return true;

      const leafId = box.getAttribute('data-ykt-leaf-id');
      if (leafId) {
        const cacheProg = window.__yktProgressCache?.byId?.[leafId];
        if (cacheProg && (cacheProg.progress || 0) >= 0.995) return true;
      }

      const t = (box.textContent || '').replace(/\s+/g, ' ').trim();
      if (/已完成|已读|已提交|已发表|已参与|已讨论|100%/.test(t)) return true;

      const html = (box.innerHTML || '').toLowerCase();
      const uses = Array.from(box.querySelectorAll('use'));
      for (const u of uses) {
        const h = (u.getAttribute('xlink:href') || u.getAttribute('href') || '').toLowerCase();
        if (h.includes('wancheng') || h.includes('finish') || h.includes('gou') || h.includes('check') || h.includes('complete')) {
          return true;
        }
      }

      if (/icon-wancheng|icon-finish|icon-gou|icon-check|is-finished|finished|completed|is-completed|\bdone\b|el-icon-check|is-success/i.test(html)) {
        return true;
      }

      const svgs = box.querySelectorAll('svg');
      for (const s of svgs) {
        const sHtml = (s.innerHTML || '').toLowerCase();
        const sCls = (s.getAttribute('class') || '').toLowerCase();
        if (/check|finish|done|success|gou|wancheng/.test(sCls) || /check|finish|done|success|gou|wancheng/.test(sHtml)) {
          return true;
        }
      }

      try {
        const completedStorage = JSON.parse(localStorage.getItem('__ykt_completed_units') || '[]');
        if (Array.isArray(completedStorage) && completedStorage.length > 0) {
          if (leafId && completedStorage.includes(leafId)) return true;
        }
      } catch {}

      try {
        const commentedStorage = JSON.parse(localStorage.getItem('__ykt_commented_discussions') || '[]');
        if (Array.isArray(commentedStorage) && commentedStorage.length > 0) {
          if (leafId && commentedStorage.some((k) => String(k) === String(leafId))) return true;
        }
      } catch {}

      return false;
    }

    function detectAiUnitKind() {
      const m = url.match(/\\/ai-workspace\\/lms-graph\\/[^/]+\\/([^/?#]+)/i);
      const rawType = m ? m[1].toLowerCase() : '';

      if (rawType === 'video' || /^视频/.test(activeLeafText)) return 'video';
      if (rawType === 'audio' || /^音频/.test(activeLeafText)) return 'audio';
      if (rawType === 'forum' || rawType === 'discuss' || rawType === 'discussion' || /^讨论/.test(activeLeafText)) return 'discussion';
      if (
        rawType === 'exercise' ||
        rawType === 'quiz' ||
        rawType === 'homework' ||
        rawType === 'exam' ||
        /^(作业|练习|习题|测验|考试)/.test(activeLeafText) ||
        allDocUrls.some((u) => u.includes('/iframe-quiz/') || u.includes('/v/exam/'))
      ) {
        return 'homework';
      }
      if (rawType === 'tuwen' || rawType === 'kejian' || /^(图文|课件|文档)/.test(activeLeafText)) return 'courseware';
      return 'unknown';
    }

    const aiUnitKind = url.includes('/ai-workspace/lms-graph/') ? detectAiUnitKind() : 'unknown';

    function detectRoute() {
      if (allDocUrls.some((u) => /\\/pro\\/lms\\/[^/]+\\/[^/]+\\/(video|homework|graph|forum|ketang|exam)/.test(u))) {
        return ['pro-lms-content', 'Pro LMS 学习内容页'];
      }
      if (
        allDocUrls.some((u) => u.includes('/v2/web/cloud/student/exercise/') || u.includes('/v2/web/studentQuiz/'))
      ) {
        return ['v2-homework', '作业 / 习题作答页'];
      }
      if (url.includes('/ai-workspace/lms-graph/')) {
        if (aiUnitKind === 'video') return ['ai-workspace', 'AI Workspace · 视频课'];
        if (aiUnitKind === 'audio') return ['ai-workspace', 'AI Workspace · 音频课'];
        if (aiUnitKind === 'discussion') return ['ai-workspace', 'AI Workspace · 讨论区'];
        if (aiUnitKind === 'homework') return ['ai-workspace', 'AI Workspace · 作业/测验'];
        if (aiUnitKind === 'courseware') return ['ai-workspace', 'AI Workspace · 课件/图文'];
        return ['ai-workspace', 'AI Workspace 知识图谱'];
      }
      if (url.includes('/v/index/course/normalcourse/manage_classroom') || document.querySelector('iframe.lesson-report-mobile')) {
        return ['classroom-replay', '课堂回放页'];
      }
      if (url.includes('/v2/web/studentLog/')) return ['v2-student-log', 'V2 课程日志目录'];
      if (allDocUrls.some((u) => /\\/pro\\/lms\\/[^/]+\\/[^/]+\\/studycontent/.test(u))) {
        return ['pro-lms-directory', 'Pro LMS 学习目录'];
      }
      if (
        url.includes('/v2/web/studentCards/') ||
        url.includes('/v2/web/xcloud/') ||
        url.includes('/v2/web/postDetail/') ||
        url.includes('/v2/web/discuss/') ||
        Boolean(queryFirstDoc('.ppt_img_box, .swiper-wrapper, .video-box, #new_discuss'))
      ) {
        return ['pro-lms-content', 'V2 课程学习内容页'];
      }
      if (queryAllDocs('.subject-item.J_order, .problem-item, .exercise-item, .container-problem').some(isVisible)) {
        return ['v2-homework', '作业 / 习题作答页'];
      }
      return ['unknown', '普通页面'];
    }

    const [route, routeLabel] = detectRoute();

    // 1. Directory items summary (supports both .logs-list .content-box, .leaf-detail, and ai-workspace sidebar)
    let directoryItemsTotal = 0;
    let directoryItemsPending = 0;
    const directorySampleTitles = [];

    if (route === 'v2-student-log' || route === 'pro-lms-directory') {
      const boxes = queryAllDocs('.logs-list .content-box').filter(isVisible);
      for (const box of boxes) {
        const subItems = Array.from(box.querySelectorAll('.leaf_list__wrap .activity__wrap')).filter(isVisible);
        if (subItems.length > 0) {
          for (const sub of subItems) {
            directoryItemsTotal += 1;
            const subAside = (sub.querySelector('.statistics-box .aside')?.textContent || '').trim();
            const subFrac = subAside.match(/(\\d+)\\s*\\/\\s*(\\d+)/);
            const subDone =
              subAside.includes('已完成') ||
              subAside.includes('已读') ||
              (subFrac && parseInt(subFrac[1], 10) >= parseInt(subFrac[2], 10) && parseInt(subFrac[2], 10) > 0);
            if (!subDone) {
              directoryItemsPending += 1;
              const st = (sub.querySelector('h2, .title')?.textContent || sub.textContent || '').replace(/\\s+/g, ' ').trim();
              if (st && directorySampleTitles.length < 5) directorySampleTitles.push(st.slice(0, 40));
            }
          }
          continue;
        }

        const headerSection = box.querySelector(':scope > section') || box.querySelector('section') || box;
        const useEl = headerSection.querySelector('.tag use, .tag svg use');
        const href = useEl ? (useEl.getAttribute('xlink:href') || useEl.getAttribute('href') || '') : '';
        if (href.includes('kaoshi') || href.includes('gonggao')) continue;
        directoryItemsTotal += 1;
        const asideText = (headerSection.querySelector('.statistics-box .aside')?.textContent || '').trim();
        const frac = asideText.match(/(\\d+)\\s*\\/\\s*(\\d+)/);
        const isDone =
          asideText.includes('已完成') ||
          asideText.includes('已读') ||
          (frac && parseInt(frac[1], 10) >= parseInt(frac[2], 10) && parseInt(frac[2], 10) > 0);
        if (!isDone) {
          directoryItemsPending += 1;
          const t = (headerSection.querySelector('.title, h2')?.textContent || headerSection.textContent || '').replace(/\\s+/g, ' ').trim();
          if (t && directorySampleTitles.length < 5) directorySampleTitles.push(t.slice(0, 40));
        }
      }

      const leaves = queryAllDocs('.leaf-detail').filter(isVisible);
      for (const leaf of leaves) {
        directoryItemsTotal += 1;
        const pText = (leaf.querySelector('.progress-time')?.textContent || '').trim();
        const isDone = pText.includes('已完成') || pText.includes('已读') || pText.includes('已提交') || pText.includes('100%');
        if (!isDone) {
          directoryItemsPending += 1;
          const t = (leaf.querySelector('.title')?.textContent || '').replace(/\\s+/g, ' ').trim();
          if (t && directorySampleTitles.length < 5) directorySampleTitles.push(t.slice(0, 40));
        }
      }
    } else if (route === 'ai-workspace') {
      const navBoxes = queryAllDocs('.nav-item-leaf-box').filter(isVisible);
      for (const box of navBoxes) {
        directoryItemsTotal += 1;
        const t = (box.textContent || '').replace(/\\s+/g, ' ').trim();
        const isDone = isAiBoxDone(box);
        if (!isDone) {
          directoryItemsPending += 1;
          const pctAttr = box.getAttribute('data-ykt-leaf-pct');
          const pctSuffix = pctAttr !== null ? ' (' + pctAttr + '%)' : '';
          if (t && directorySampleTitles.length < 5) directorySampleTitles.push(t.slice(0, 34) + pctSuffix);
        }
      }
    }

    // 2. Media status
    const allMedias = queryAllDocs('video, audio');
    let bestMedia = null;
    let bestScore = -1e9;
    for (const m of allMedias) {
      let score = 0;
      const r = m.getBoundingClientRect();
      if (r.width > 40 && r.height > 40) score += 1000 + Math.min(r.width * r.height, 500000) / 1000;
      if (m.currentSrc || m.src) score += 500;
      if (Number.isFinite(m.duration) && m.duration > 3) score += 300;
      if (!m.paused) score += 200;
      if (score > bestScore) {
        bestScore = score;
        bestMedia = m;
      }
    }
    const media = bestMedia;
    const video = media && media.tagName === 'VIDEO' ? media : queryFirstDoc('video');
    const audio = media && media.tagName === 'AUDIO' ? media : queryFirstDoc('audio');

    const progressEl = queryFirstDoc('.progress-wrap .text, .finish-status');
    let progressText = progressEl ? (progressEl.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40) : null;

    const currentServerLeaf = aiCurrentLeafId ? window.__yktProgressCache?.byId?.[aiCurrentLeafId] : null;
    const currentServerPct = currentServerLeaf
      ? Math.min(100, Math.max(0, Math.round((currentServerLeaf.progress || 0) * 100)))
      : activeLeafBox?.getAttribute('data-ykt-leaf-pct') !== null && activeLeafBox?.getAttribute('data-ykt-leaf-pct') !== undefined
        ? Number(activeLeafBox.getAttribute('data-ykt-leaf-pct'))
        : null;

    if (!window.__yktUrlPlayState || window.__yktUrlPlayState.url !== url) {
      window.__yktUrlPlayState = { url, playTicks: 0, rewound: false };
    }

    let mediaTimeNearlyDone = false;
    if (media && Number.isFinite(media.duration) && media.duration > 3) {
      // If this video has low completion on the left sidebar (< 99%), but the player's saved last_point is way ahead of server progress, rewind once to match left-sidebar progress!
      if (
        !aiUnitCompleted &&
        currentServerPct !== null &&
        currentServerPct < 99 &&
        !window.__yktUrlPlayState.rewound
      ) {
        const targetStartSec = Math.max(0, Math.floor((Math.max(0, currentServerPct - 3) / 100) * media.duration));
        if ((media.currentTime || 0) > targetStartSec + 20) {
          try {
            media.currentTime = targetStartSec;
            window.__yktUrlPlayState.rewound = true;
            window.__yktUrlPlayState.playTicks = 0;
          } catch {}
        } else {
          window.__yktUrlPlayState.rewound = true;
        }
      }

      const cur = Math.floor(media.currentTime || 0);
      const dur = Math.floor(media.duration || 0);
      const pct = Math.min(100, Math.round(((media.currentTime || 0) / media.duration) * 100));

      if (!media.paused && cur > 0 && media.duration - (media.currentTime || 0) > 1.5) {
        window.__yktUrlPlayState.playTicks += 1;
      }

      if (currentServerPct !== null && route === 'ai-workspace') {
        progressText = '左侧栏 ' + currentServerPct + '% · 播放 ' + pct + '% (' + cur + 's/' + dur + 's)';
      } else if (!progressText) {
        progressText = pct + '% (' + cur + 's/' + dur + 's)';
      }

      if (cur > 0 && media.duration - (media.currentTime || 0) <= 1.2) {
        mediaTimeNearlyDone = true;
      }
    }

    const activeSidebarDone = Boolean(activeLeafBox && isAiBoxDone(activeLeafBox));
    if (aiUnitCompleted || activeSidebarDone) {
      progressText = '左侧栏已完成 (100%)';
    }

    const mediaReachedEndLocally = Boolean(
      ((media && media.ended) || mediaTimeNearlyDone) &&
      (route !== 'ai-workspace' || window.__yktUrlPlayState.playTicks >= 1)
    );

    const mediaCompleted = Boolean(
      aiUnitCompleted ||
      activeSidebarDone ||
      mediaReachedEndLocally ||
      (progressText && (/学习进度[：:]?\\s*(100%|99%|98%)|已完成\\s*\\(100%\\)/.test(progressText)))
    );

    // 3. Question Probe
    // Clear previous tags across all accessible docs
    for (const el of queryAllDocs('[data-ykt-active-question],[data-ykt-opt-label],[data-ykt-blank-index],[data-ykt-submit-btn]')) {
      el.removeAttribute('data-ykt-active-question');
      el.removeAttribute('data-ykt-opt-label');
      el.removeAttribute('data-ykt-opt-index');
      el.removeAttribute('data-ykt-blank-index');
      el.removeAttribute('data-ykt-submit-btn');
    }

    function isNonQuestionElement(el) {
      if (!el || el.nodeType !== 1) return true;
      if (
        el.closest &&
        el.closest(
          '#ykt-native-brush-hud, .nav-item-leaf-box, .leaf-item, .logs-list, #new_discuss, .discuss-list, .publish_discuss, aside, nav, header, [class*="sidebar"], [class*="catalog"], [class*="directory"], [class*="menu-tree"]'
        )
      ) {
        return true;
      }
      if (route === 'ai-workspace' && el.ownerDocument === document) {
        const r = el.getBoundingClientRect();
        if (r.left < 310 && r.width < 420) return true;
      }
      return false;
    }

    function isQuestionBlankInput(el) {
      if (!isVisible(el) || isNonQuestionElement(el)) return false;
      const placeholder = (el.getAttribute('placeholder') || '').trim();
      if (/搜索|查找|筛选|关键字|观点|评论|回复|讨论|发言|留言|弹幕|笔记|提问/.test(placeholder)) {
        return false;
      }
      const typeAttr = (el.getAttribute('type') || '').toLowerCase();
      if (typeAttr === 'search' || typeAttr === 'password' || typeAttr === 'hidden' || typeAttr === 'file') {
        return false;
      }
      return true;
    }

    function isOptionChecked(el) {
      if (!el) return false;
      const cls = el.className && typeof el.className === 'string' ? el.className : '';
      if (/\\b(is-checked|selected|active|checked|is-active|choose|on)\\b/i.test(cls)) return true;
      if (el.getAttribute('aria-checked') === 'true') return true;
      const innerChecked = el.querySelector('.is-checked, .selected, .active, .checked, input:checked, [aria-checked="true"]');
      return Boolean(innerChecked);
    }

    function extractOptionLabel(el, idx, total) {
      const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
      const letterMatch = text.match(/^([A-H])(?:[\\.、\\s\\)\\uff09:]|$)/i);
      if (letterMatch) return letterMatch[1].toUpperCase();
      const iconText = (el.querySelector('.option-label, .el-radio__label, .el-checkbox__label, .num, .letter, span')?.textContent || '').trim();
      if (/^[A-H]$/i.test(iconText)) return iconText.toUpperCase();
      if (/^(对|正确|√|true)$/i.test(text) || /^(对|正确|√|true)$/i.test(iconText)) return '对';
      if (/^(错|错误|×|false)$/i.test(text) || /^(错|错误|×|false)$/i.test(iconText)) return '错';
      if (total === 2 && (text.includes('正确') || text.includes('错误') || text.includes('对') || text.includes('错'))) {
        return idx === 0 ? '对' : '错';
      }
      return String.fromCharCode(65 + idx);
    }

    function findOptionElements(scope) {
      const radioOrCheck = Array.from(
        scope.querySelectorAll('label.el-radio, label.el-checkbox, .option-item, .radio-item, .checkbox-item')
      ).filter((el) => isVisible(el) && !isNonQuestionElement(el));
      if (radioOrCheck.length >= 2) {
        const parentLis = radioOrCheck.map((n) => n.closest('li')).filter(Boolean);
        if (parentLis.length === radioOrCheck.length && new Set(parentLis).size === radioOrCheck.length) {
          return parentLis;
        }
        return radioOrCheck;
      }

      const uls = Array.from(scope.querySelectorAll('ul, ol, .options-list, .option-list')).filter(
        (el) => isVisible(el) && !isNonQuestionElement(el)
      );
      for (const ul of uls) {
        const lis = Array.from(ul.children).filter((child) => child.tagName === 'LI' && isVisible(child));
        if (lis.length >= 2 && lis.length <= 10) {
          const looksLikeOptions = lis.every((li) => {
            const t = (li.innerText || '').trim();
            return /^[A-H][\\.、\\s\\)\\uff09:]?/i.test(t) || /^(对|错|正确|错误|√|×)/.test(t) || Boolean(li.querySelector('.el-radio, .el-checkbox, input[type="radio"], input[type="checkbox"]'));
          });
          if (looksLikeOptions) return lis;
        }
      }
      return [];
    }

    const hasQuizIframe = allDocUrls.some((u) => u.includes('/iframe-quiz/') || u.includes('/v/exam/') || u.includes('/exercise/') || u.includes('/studentQuiz/'));
    const skipQuestionSearch =
      aiUnitKind === 'video' ||
      aiUnitKind === 'audio' ||
      aiUnitKind === 'discussion' ||
      aiUnitKind === 'courseware' ||
      ((Boolean(video) || Boolean(audio)) && !hasQuizIframe && route !== 'v2-homework');

    // Locate question navigation & active question container across all docs
    const orderBtns = skipQuestionSearch
      ? []
      : queryAllDocs('.subject-item.J_order, .question-nav-item, .topic-item, .number-item').filter(
          (el) => isVisible(el) && !isNonQuestionElement(el)
        );
    let questionIndex = 0;
    let totalQuestions = orderBtns.length;
    if (orderBtns.length > 0) {
      const activeIdx = orderBtns.findIndex((btn) =>
        /\\b(active|current|selected|is-active|on)\\b/i.test(btn.className || '')
      );
      questionIndex = activeIdx >= 0 ? activeIdx : 0;
    }

    let activeContainer = null;
    const candidateCards = skipQuestionSearch
      ? []
      : queryAllDocs(
          '.problem-item, .exercise-item, .subject-detail, .question-item, .homework-item, .subject-box, .container-problem'
        ).filter((el) => isVisible(el) && !isNonQuestionElement(el));

    if (candidateCards.length > 0) {
      if (orderBtns.length === 0) {
        totalQuestions = candidateCards.length;
        const firstUnansweredIdx = candidateCards.findIndex((card) => {
          const t = (card.innerText || '').trim();
          return !/(已提交|回答正确|回答错误|正确答案)/.test(t);
        });
        questionIndex = firstUnansweredIdx >= 0 ? firstUnansweredIdx : 0;
        activeContainer = candidateCards[questionIndex] || candidateCards[0];
      } else {
        activeContainer = candidateCards[0];
      }
    }

    if (!activeContainer && !skipQuestionSearch) {
      for (const { doc } of getAccessibleDocs()) {
        if (!doc.body) continue;
        const anyOptions = findOptionElements(doc.body);
        const explicitBlank = Array.from(doc.querySelectorAll('.blank-item input, .blank-input input')).find(isQuestionBlankInput);
        const firstTarget = anyOptions[0] || explicitBlank;
        if (firstTarget) {
          let curr = firstTarget.parentElement;
          while (curr && curr !== doc.body) {
            if (isNonQuestionElement(curr)) break;
            const text = (curr.innerText || '').trim();
            const rect = curr.getBoundingClientRect();
            if (
              rect.height >= 100 &&
              rect.width >= 240 &&
              (text.length > 15 || /(单选|多选|判断|填空|主观|简答|\\d+[\\.、])/.test(text))
            ) {
              activeContainer = curr;
              if (/(单选|多选|判断|填空|主观|简答)/.test(text) || rect.height >= 220) {
                break;
              }
            }
            curr = curr.parentElement;
          }
          if (!activeContainer && !isNonQuestionElement(firstTarget.parentElement)) {
            activeContainer = firstTarget.parentElement;
          }
          if (activeContainer && totalQuestions === 0) totalQuestions = 1;
          if (activeContainer) break;
        }
      }
    }

    if (!activeContainer) {
      return {
        url,
        title,
        route,
        routeLabel,
        directoryItemsTotal,
        directoryItemsPending,
        directorySampleTitles,
        mediaStatus: {
          hasVideo: Boolean(video),
          hasAudio: Boolean(audio),
          paused: media ? media.paused : null,
          playbackRate: media ? media.playbackRate : null,
          progressText,
          completed: mediaCompleted,
        },
        questionProbe: {
          found: false,
          route,
          questionIndex: 0,
          totalQuestions: 0,
          questionType: 'unknown',
          typeLabel: '未检测到题目',
          stemText: '',
          hasEncryptedFont: false,
          alreadyAnswered: false,
          options: [],
          blankCount: 0,
          submitButtonText: null,
          canSubmit: false,
          rect: null,
        },
      };
    }

    activeContainer.setAttribute('data-ykt-active-question', 'true');
    try {
      activeContainer.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
    } catch {
      // ignore
    }

    const optionEls = findOptionElements(activeContainer);
    const options = optionEls.map((el, idx) => {
      const label = extractOptionLabel(el, idx, optionEls.length);
      el.setAttribute('data-ykt-opt-index', String(idx));
      el.setAttribute('data-ykt-opt-label', label);
      const rawText = (el.innerText || el.textContent || '')
        .replace(/\\s+/g, ' ')
        .trim()
        .replace(new RegExp('^' + label + '[\\\\.、\\\\s\\\\)\\\\uff09:]*', 'i'), '')
        .trim();
      return {
        index: idx,
        label,
        text: rawText.slice(0, 200),
        selected: isOptionChecked(el),
      };
    });

    const blankEls = Array.from(
      activeContainer.querySelectorAll(
        'input[type="text"]:not([readonly]), input:not([type]):not([readonly]), textarea:not([readonly]), [contenteditable="true"]'
      )
    ).filter((el) => isQuestionBlankInput(el) && !el.closest('.el-select, .search, .comment'));
    blankEls.forEach((el, idx) => {
      el.setAttribute('data-ykt-blank-index', String(idx));
    });

    if (options.length === 0 && blankEls.length === 0) {
      return {
        url,
        title,
        route,
        routeLabel,
        directoryItemsTotal,
        directoryItemsPending,
        directorySampleTitles,
        mediaStatus: {
          hasVideo: Boolean(video),
          hasAudio: Boolean(audio),
          paused: media ? media.paused : null,
          playbackRate: media ? media.playbackRate : null,
          progressText,
          completed: mediaCompleted,
        },
        questionProbe: {
          found: false,
          route,
          questionIndex: 0,
          totalQuestions: 0,
          questionType: 'unknown',
          typeLabel: '未检测到题目',
          stemText: '',
          hasEncryptedFont: false,
          alreadyAnswered: false,
          options: [],
          blankCount: 0,
          submitButtonText: null,
          canSubmit: false,
          rect: null,
        },
      };
    }

    const containerText = (activeContainer.innerText || '').replace(/\\s+/g, ' ').trim();
    const hasEncryptedFont = Boolean(
      activeContainer.querySelector('.xuetangx-com-encrypted-font') ||
      queryFirstDoc('.xuetangx-com-encrypted-font')
    );

    // Detect question type
    let questionType = 'unknown';
    let typeLabel = '未知题型';
    if (/多选/.test(containerText) || activeContainer.querySelector('.el-checkbox, input[type="checkbox"]')) {
      questionType = 'multiple';
      typeLabel = '多选题';
    } else if (
      /判断/.test(containerText) ||
      (options.length === 2 && options.some((o) => o.label === '对' || o.label === '错'))
    ) {
      questionType = 'judge';
      typeLabel = '判断题';
    } else if (/单选|投票/.test(containerText) || options.length >= 2) {
      questionType = 'single';
      typeLabel = '单选题';
    } else if (/填空/.test(containerText) || (blankEls.length > 0 && blankEls.every((el) => el.tagName === 'INPUT'))) {
      questionType = 'blank';
      typeLabel = '填空题';
    } else if (/主观|简答|论述|问答/.test(containerText) || blankEls.length > 0) {
      questionType = 'subjective';
      typeLabel = '主观题';
    }

    // Find submit button in or near activeContainer
    const ownerBody = activeContainer.ownerDocument?.body || document.body;
    const buttonScopes = [activeContainer, activeContainer.parentElement, ownerBody].filter(Boolean);
    let submitBtn = null;
    for (const scope of buttonScopes) {
      const candidates = Array.from(
        scope.querySelectorAll('button, .submit-btn, .el-button, [role="button"]')
      ).filter(isVisible);
      submitBtn = candidates.find((btn) => {
        const t = (btn.innerText || btn.textContent || '').replace(/\\s+/g, '').trim();
        return /^(提交|提交答案|确定|保存|作答完毕|提交本题)$/.test(t);
      });
      if (submitBtn) break;
    }
    if (submitBtn) {
      submitBtn.setAttribute('data-ykt-submit-btn', 'true');
    }

    const submitButtonText = submitBtn
      ? (submitBtn.innerText || submitBtn.textContent || '').replace(/\\s+/g, ' ').trim()
      : null;
    const submitDisabled = Boolean(
      submitBtn &&
      (submitBtn.hasAttribute('disabled') ||
        submitBtn.classList.contains('is-disabled') ||
        submitBtn.classList.contains('disabled'))
    );

    const hasExplicitGradedMarker = /(已提交|作答完毕|回答正确|回答错误|正确答案[：:\\s]|我的答案[：:\\s]|本题得分)/.test(containerText);
    const optionsLocked =
      options.length > 0 &&
      optionEls.every((el) =>
        el.classList.contains('is-disabled') ||
        el.classList.contains('disabled') ||
        Boolean(el.querySelector('input:disabled, .is-disabled'))
      );
    const blanksLocked =
      blankEls.length > 0 &&
      blankEls.every((el) => el.hasAttribute('disabled') || el.classList.contains('is-disabled'));
    const alreadyAnswered = Boolean(hasExplicitGradedMarker || optionsLocked || blanksLocked);

    const domRect = getScreenRect(activeContainer);
    const pad = 12;
    const rect = {
      x: Math.max(0, Math.floor(domRect.left - pad)),
      y: Math.max(0, Math.floor(domRect.top - pad)),
      width: Math.min(window.innerWidth, Math.ceil(domRect.width + pad * 2)),
      height: Math.min(window.innerHeight, Math.ceil(domRect.height + pad * 2)),
    };

    return {
      url,
      title,
      route,
      routeLabel,
      directoryItemsTotal,
      directoryItemsPending,
      directorySampleTitles,
      mediaStatus: {
        hasVideo: Boolean(video),
        hasAudio: Boolean(audio),
        paused: media ? media.paused : null,
        playbackRate: media ? media.playbackRate : null,
        progressText,
        completed: mediaCompleted,
      },
      questionProbe: {
        found: true,
        route,
        questionIndex,
        totalQuestions: Math.max(1, totalQuestions),
        questionType,
        typeLabel,
        stemText: containerText.slice(0, 500),
        hasEncryptedFont,
        alreadyAnswered,
        options,
        blankCount: blankEls.length,
        submitButtonText,
        canSubmit: Boolean(submitBtn && !submitDisabled),
        rect,
      },
    };
  })()`;
}

function buildApplyHomeworkAnswerScript(input: {
  questionType: CourseBrushQuestionKind;
  answers: readonly string[];
  submit: boolean;
}): string {
  return `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const questionType = ${JSON.stringify(input.questionType)};
    const answers = ${JSON.stringify(input.answers)};
    const shouldSubmit = ${JSON.stringify(input.submit)};

    function getAccessibleDocs() {
      const docs = [document];
      for (const ifr of Array.from(document.querySelectorAll('iframe'))) {
        try {
          if (ifr.contentDocument && ifr.contentDocument.body) docs.push(ifr.contentDocument);
        } catch {}
      }
      return docs;
    }

    function queryAllDocs(selector) {
      const out = [];
      for (const doc of getAccessibleDocs()) {
        try { out.push(...Array.from(doc.querySelectorAll(selector))); } catch {}
      }
      return out;
    }

    function queryFirstDoc(selector) {
      for (const doc of getAccessibleDocs()) {
        try {
          const el = doc.querySelector(selector);
          if (el) return el;
        } catch {}
      }
      return null;
    }

    function isOptionChecked(el) {
      if (!el) return false;
      const cls = el.className && typeof el.className === 'string' ? el.className : '';
      if (/\\b(is-checked|selected|active|checked|is-active|choose|on)\\b/i.test(cls)) return true;
      if (el.getAttribute('aria-checked') === 'true') return true;
      return Boolean(el.querySelector('.is-checked, .selected, .active, .checked, input:checked, [aria-checked="true"]'));
    }

    async function setOptionState(el, targetSelected) {
      if (isOptionChecked(el) === targetSelected) return true;
      if (typeof el.click === 'function') el.click();
      await sleep(160);
      if (isOptionChecked(el) === targetSelected) return true;

      const innerCandidates = el.querySelectorAll(
        'label.el-radio, label.el-checkbox, .el-radio__input, .el-checkbox__input, input[type="radio"], input[type="checkbox"], .option-label, span, p, div'
      );
      for (const inner of innerCandidates) {
        if (inner && typeof inner.click === 'function') {
          inner.click();
          await sleep(140);
          if (isOptionChecked(el) === targetSelected) return true;
        }
      }
      return isOptionChecked(el) === targetSelected;
    }

    function setNativeInputValue(el, value) {
      const win = el.ownerDocument?.defaultView || window;
      if (el.getAttribute('contenteditable') === 'true') {
        el.focus();
        el.innerText = value;
        el.dispatchEvent(new win.Event('input', { bubbles: true }));
        el.dispatchEvent(new win.Event('change', { bubbles: true }));
        el.dispatchEvent(new win.Event('blur', { bubbles: true }));
        return true;
      }
      const proto =
        el.tagName === 'TEXTAREA'
          ? win.HTMLTextAreaElement?.prototype
          : win.HTMLInputElement?.prototype;
      const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
      el.focus();
      if (descriptor && descriptor.set) {
        descriptor.set.call(el, value);
      } else {
        el.value = value;
      }
      el.dispatchEvent(new win.Event('input', { bubbles: true }));
      el.dispatchEvent(new win.Event('change', { bubbles: true }));
      el.dispatchEvent(new win.Event('blur', { bubbles: true }));
      return true;
    }

    const optionEls = queryAllDocs('[data-ykt-opt-label]');
    const blankEls = queryAllDocs('[data-ykt-blank-index]');
    let applied = false;
    const logs = [];

    if (
      (questionType === 'single' || questionType === 'multiple' || questionType === 'judge' || optionEls.length > 0) &&
      optionEls.length > 0
    ) {
      const normalizedTargets = answers.map((a) => a.trim().toUpperCase());
      for (const optEl of optionEls) {
        const label = (optEl.getAttribute('data-ykt-opt-label') || '').toUpperCase();
        const shouldSelect = normalizedTargets.includes(label);
        if (questionType === 'multiple') {
          const ok = await setOptionState(optEl, shouldSelect);
          if (shouldSelect && ok) {
            applied = true;
            logs.push('已勾选 ' + label);
          }
        } else if (shouldSelect) {
          const ok = await setOptionState(optEl, true);
          applied = ok || true;
          logs.push('已选择 ' + label);
        }
      }
    } else if (blankEls.length > 0) {
      for (let i = 0; i < blankEls.length; i += 1) {
        const val = answers[i] ?? answers[answers.length - 1] ?? '';
        if (val) {
          setNativeInputValue(blankEls[i], val);
          applied = true;
          logs.push('第 ' + (i + 1) + ' 空填入: ' + val.slice(0, 30));
          await sleep(120);
        }
      }
    }

    await sleep(450);

    let submitted = false;
    if (shouldSubmit && applied) {
      const container = queryFirstDoc('[data-ykt-active-question="true"]') || document.body;
      let submitBtn =
        queryFirstDoc('[data-ykt-submit-btn="true"]') ||
        Array.from(container.querySelectorAll('button, .submit-btn, .el-button')).find((b) =>
          /^(提交|提交答案|确定|保存|作答完毕|提交本题)$/.test((b.innerText || b.textContent || '').replace(/\\s+/g, '').trim())
        );

      if (
        submitBtn &&
        typeof submitBtn.click === 'function' &&
        !submitBtn.hasAttribute('disabled') &&
        !submitBtn.classList.contains('is-disabled')
      ) {
        submitBtn.click();
        submitted = true;
        logs.push('已点击提交按钮');
        await sleep(600);
        const confirmBtn = queryFirstDoc('.el-message-box__btns .el-button--primary');
        if (confirmBtn && typeof confirmBtn.click === 'function') {
          confirmBtn.click();
          logs.push('已确认弹窗');
        }
      } else {
        logs.push('未点击提交（未找到可用提交按钮或仅填充模式）');
      }
    } else if (!shouldSubmit) {
      logs.push('试答模式（未自动点击提交）');
    }

    return {
      applied,
      submitted,
      detail: logs.join('；') || '无匹配控件',
    };
  })()`;
}

function buildInspectQuestionNavigationScript(): string {
  return `(() => {
    function getAccessibleDocs() {
      const docs = [document];
      for (const ifr of Array.from(document.querySelectorAll('iframe'))) {
        try {
          if (ifr.contentDocument && ifr.contentDocument.body) docs.push(ifr.contentDocument);
        } catch {}
      }
      return docs;
    }
    function queryAllDocs(selector) {
      const out = [];
      for (const doc of getAccessibleDocs()) {
        try { out.push(...Array.from(doc.querySelectorAll(selector))); } catch {}
      }
      return out;
    }
    const isVisible = (el) => {
      if (!el || el.nodeType !== 1 || (el.closest && el.closest('#ykt-native-brush-hud'))) return false;
      const r = el.getBoundingClientRect();
      return r.width > 4 && r.height > 4;
    };
    const orderBtns = queryAllDocs('.subject-item.J_order, .question-nav-item, .topic-item').filter(isVisible);
    if (orderBtns.length > 0) {
      return { mode: 'order-bar', total: orderBtns.length };
    }
    const cards = queryAllDocs('.problem-item, .exercise-item, .question-item, .homework-item').filter(isVisible);
    if (cards.length > 1) {
      return { mode: 'card-list', total: cards.length };
    }
    return { mode: 'single', total: 1 };
  })()`;
}

function buildActivateQuestionByIndexScript(
  mode: 'order-bar' | 'card-list' | 'single',
  index: number,
): string {
  return `(() => {
    function getAccessibleDocs() {
      const docs = [document];
      for (const ifr of Array.from(document.querySelectorAll('iframe'))) {
        try {
          if (ifr.contentDocument && ifr.contentDocument.body) docs.push(ifr.contentDocument);
        } catch {}
      }
      return docs;
    }
    function queryAllDocs(selector) {
      const out = [];
      for (const doc of getAccessibleDocs()) {
        try { out.push(...Array.from(doc.querySelectorAll(selector))); } catch {}
      }
      return out;
    }
    const isVisible = (el) => {
      if (!el || el.nodeType !== 1 || (el.closest && el.closest('#ykt-native-brush-hud'))) return false;
      const r = el.getBoundingClientRect();
      return r.width > 4 && r.height > 4;
    };
    const mode = ${JSON.stringify(mode)};
    const idx = ${JSON.stringify(index)};
    if (mode === 'order-bar') {
      const orderBtns = queryAllDocs('.subject-item.J_order, .question-nav-item, .topic-item').filter(isVisible);
      const target = orderBtns[idx];
      if (!target) return { ok: false, skippedAsDone: false, reason: '题号按钮不存在' };
      target.click();
      return { ok: true, skippedAsDone: false, reason: '已点击第 ' + (idx + 1) + ' 题题号' };
    }
    if (mode === 'card-list') {
      const cards = queryAllDocs('.problem-item, .exercise-item, .question-item, .homework-item').filter(isVisible);
      const card = cards[idx];
      if (!card) return { ok: false, skippedAsDone: false, reason: '题目卡片不存在' };
      card.scrollIntoView({ behavior: 'instant', block: 'center' });
      return { ok: true, skippedAsDone: false, reason: '已定位到第 ' + (idx + 1) + ' 张题目卡片' };
    }
    return { ok: true, skippedAsDone: false, reason: '单题视图' };
  })()`;
}

function buildClickNextQuestionButtonScript(): string {
  return `(() => {
    function getAccessibleDocs() {
      const docs = [document];
      for (const ifr of Array.from(document.querySelectorAll('iframe'))) {
        try {
          if (ifr.contentDocument && ifr.contentDocument.body) docs.push(ifr.contentDocument);
        } catch {}
      }
      return docs;
    }
    for (const doc of getAccessibleDocs()) {
      const btns = Array.from(doc.querySelectorAll('button, .el-button, span, a'));
      const nextBtn = btns.find((b) => /^(下一题|下一页)$/.test((b.textContent || '').trim()));
      if (nextBtn && typeof nextBtn.click === 'function') {
        nextBtn.click();
        return true;
      }
    }
    return false;
  })()`;
}

function buildEnsureMediaAndAntiCheckScript(config: CourseBrushConfig): string {
  return `(() => {
    try {
      const rate = Number(${JSON.stringify(config.playbackRate)}) || 2;
      const mute = Boolean(${JSON.stringify(config.muteAudio)});

      try {
        const rawCompleted = JSON.parse(localStorage.getItem('__ykt_completed_units') || '[]');
        if (Array.isArray(rawCompleted)) {
          const sanitized = rawCompleted.filter((k) => typeof k === 'string' && (k.startsWith('http') || /^\d{4,}$/.test(k)));
          if (sanitized.length !== rawCompleted.length) {
            localStorage.setItem('__ykt_completed_units', JSON.stringify(sanitized));
          }
        }
        const rawCommented = JSON.parse(localStorage.getItem('__ykt_commented_discussions') || '[]');
        if (Array.isArray(rawCommented)) {
          const sanitized = rawCommented.filter((k) => typeof k === 'string' && (k.startsWith('http') || /^\d{4,}$/.test(k)));
          if (sanitized.length !== rawCommented.length) {
            localStorage.setItem('__ykt_commented_discussions', JSON.stringify(sanitized));
          }
        }
      } catch {}

      const docs = [document];
      for (const ifr of Array.from(document.querySelectorAll('iframe'))) {
        try {
          if (ifr.contentDocument && ifr.contentDocument.body) docs.push(ifr.contentDocument);
        } catch {}
      }

      function isAiUnitAlreadyCompleted(doc) {
        try {
          if (!location.href.includes('/ai-workspace/lms-graph/')) return false;
          const candidates = doc.querySelectorAll('span, div, p, em, i, b, strong');
          for (const el of candidates) {
            if (!el || el.children.length > 2) continue;
            const t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
            if (!/^(已完成|已提交|已读|100%)$/.test(t)) continue;
            const r = el.getBoundingClientRect();
            if (r.width > 4 && r.height > 4 && r.left >= 300 && r.top >= 30 && r.top <= 280) {
              return true;
            }
          }
        } catch {}
        return false;
      }

      function enforceOnDoc(doc) {
        try {
          const win = doc.defaultView || window;
          // Dismiss anti-AFK or pause dialogs
          const dialogBtns = Array.from(doc.querySelectorAll('button, .el-button, span, a'));
          for (const btn of dialogBtns) {
            const t = (btn.textContent || '').replace(/\\s+/g, '').trim();
            if (/^(继续观看|好好学习|我知道了|继续学习)$/.test(t) && typeof btn.click === 'function') {
              btn.click();
            }
          }

          const unitAlreadyDone = isAiUnitAlreadyCompleted(doc);
          const medias = Array.from(doc.querySelectorAll('video, audio'));
          for (const media of medias) {
            const curMute = Boolean(win.__yktDesiredMediaMute ?? mute);
            const curRate = Number(win.__yktDesiredMediaRate ?? rate) || 2;

            if (curMute) {
              if (!media.muted) media.muted = true;
              if (media.volume !== 0) {
                try {
                  const volIcon = doc.querySelector(
                    '#video-box > div > xt-wrap > xt-controls > xt-inner > xt-volumebutton > xt-icon, xt-volumebutton xt-icon'
                  );
                  if (volIcon && typeof volIcon.click === 'function') volIcon.click();
                } catch {}
                media.volume = 0;
              }
              media.setAttribute('muted', 'muted');
            }

            try {
              const proto = win.HTMLMediaElement ? win.HTMLMediaElement.prototype : null;
              const desc = proto ? Object.getOwnPropertyDescriptor(proto, 'playbackRate') : null;
              if (desc && desc.set) {
                desc.set.call(media, curRate);
                media.defaultPlaybackRate = curRate;
                if (!media.__yktRateHooked) {
                  media.__yktDesiredRate = curRate;
                  media.__yktRateHooked = true;
                  Object.defineProperty(media, 'playbackRate', {
                    configurable: true,
                    enumerable: true,
                    get() {
                      return media.__yktDesiredRate || curRate;
                    },
                    set(v) {
                      const t = media.__yktDesiredRate || curRate;
                      desc.set.call(media, t);
                    },
                  });
                } else {
                  media.__yktDesiredRate = curRate;
                }
              } else {
                media.defaultPlaybackRate = curRate;
                media.playbackRate = curRate;
              }
            } catch {}
            const speedVal = doc.querySelector('xt-speedvalue');
            if (speedVal && (!speedVal.textContent || !speedVal.textContent.includes(String(curRate)))) {
              speedVal.textContent = curRate.toFixed(2) + 'X';
            }

            const nearEnd =
              Number.isFinite(media.duration) &&
              media.duration > 3 &&
              media.currentTime > 0 &&
              media.duration - media.currentTime <= 1.2;
            if (!unitAlreadyDone && media.paused && !media.ended && !nearEnd) {
              media.play().catch(() => {});
              const playTip = (doc.querySelector('.play-btn-tip')?.textContent || '').trim();
              const bigPlay = doc.querySelector('xt-bigbutton, .xt_video_player_big_play_layer.pause_show');
              if (bigPlay && typeof bigPlay.click === 'function') {
                bigPlay.click();
              } else if (playTip === '播放') {
                const playBtn = doc.querySelector('xt-playbutton, .xt_video_player_play_btn');
                if (playBtn && typeof playBtn.click === 'function') playBtn.click();
              }
            }
          }
        } catch {}
      }

      for (const doc of docs) {
        const win = doc.defaultView || window;
        win.__yktDesiredMediaRate = rate;
        win.__yktDesiredMediaMute = mute;

        if (!win.__yktAntiCheckInstalled) {
          win.__yktAntiCheckInstalled = true;
          try {
            Object.defineProperty(doc, 'hidden', { get: () => false, configurable: true });
            Object.defineProperty(doc, 'visibilityState', { get: () => 'visible', configurable: true });
            Object.defineProperty(doc, 'webkitHidden', { get: () => false, configurable: true });
            doc.hasFocus = () => true;
            win.addEventListener('blur', (e) => e.stopImmediatePropagation(), true);
            doc.addEventListener('visibilitychange', (e) => e.stopImmediatePropagation(), true);
            doc.addEventListener('webkitvisibilitychange', (e) => e.stopImmediatePropagation(), true);
          } catch {}
        }

        enforceOnDoc(doc);

        if (!win.__yktMediaKeepAliveTimer) {
          win.__yktMediaKeepAliveTimer = win.setInterval(() => {
            enforceOnDoc(doc);
          }, 500);
        }
      }
    } catch {}
  })()`;
}

export function buildTriggerNextDirectoryItemScript(
  route: CourseBrushPageRoute,
  config: CourseBrushConfig,
  processedKeys: readonly string[],
): string {
  return `(() => {
    const route = ${JSON.stringify(route)};
    const config = ${JSON.stringify(config)};
    const processed = new Set(${JSON.stringify(processedKeys)});

    function getAccessibleDocs() {
      const docs = [document];
      for (const ifr of Array.from(document.querySelectorAll('iframe'))) {
        try {
          if (ifr.contentDocument && ifr.contentDocument.body) docs.push(ifr.contentDocument);
        } catch {}
      }
      return docs;
    }

    function queryAllDocs(selector) {
      const out = [];
      for (const doc of getAccessibleDocs()) {
        try { out.push(...Array.from(doc.querySelectorAll(selector))); } catch {}
      }
      return out;
    }

    function isVisible(el) {
      if (!el || el.nodeType !== 1) return false;
      const r = el.getBoundingClientRect();
      return r.width > 4 && r.height > 4;
    }

    function isFractionDone(text) {
      const m = text.match(/(\\d+)\\s*\\/\\s*(\\d+)/);
      if (!m) return false;
      const done = parseInt(m[1], 10);
      const total = parseInt(m[2], 10);
      return total > 0 && done >= total;
    }

    if (route === 'v2-student-log' || route === 'pro-lms-directory') {
      // 1. Check .logs-list .content-box items
      const boxes = queryAllDocs('.logs-list .content-box').filter(isVisible);
      const candidates = [];
      let pendingExpandBtn = null;
      let pendingExpandTitle = '';

      for (let i = 0; i < boxes.length; i += 1) {
        const box = boxes[i];
        const headerSection = box.querySelector(':scope > section') || box.querySelector('section') || box;
        const asideText = (headerSection.querySelector('.statistics-box .aside')?.textContent || '').replace(/\\s+/g, ' ').trim();
        const headerStatHtml = (headerSection.querySelector('.statistics-box')?.innerHTML || '').toLowerCase();
        if (
          asideText.includes('已完成') ||
          asideText.includes('已读') ||
          asideText.includes('已发表') ||
          asideText.includes('已参与') ||
          asideText.includes('已讨论') ||
          isFractionDone(asideText) ||
          /icon-(?:gou|check|wancheng|finish)|class="[^"]*(?:done|finish|success)/i.test(headerStatHtml)
        ) {
          continue;
        }

        const course = headerSection;
        const useEl = headerSection.querySelector('.tag use, .tag svg use');
        const href = useEl ? (useEl.getAttribute('xlink:href') || useEl.getAttribute('href') || '') : '';
        const leafWrap = box.querySelector('.leaf_list__wrap') || box.parentElement?.querySelector('.leaf_list__wrap');
        const hasBatchExpand = Boolean(box.querySelector('.sub-info .gray span') || leafWrap);
        const typeMatch = href.match(/icon-(shipin|kejian|ketang|zuoye|piliang|taolun|tuwen|kaoshi)/);
        const itemType = hasBatchExpand ? 'piliang' : (typeMatch ? typeMatch[1] : (!href ? 'piliang' : 'unknown'));
        const title = (headerSection.querySelector('.title, h2')?.textContent || headerSection.textContent || ('第' + (i + 1) + '项')).replace(/\\s+/g, ' ').trim().slice(0, 50);

        if (itemType === 'piliang') {
          const subActivities = leafWrap
            ? Array.from(leafWrap.querySelectorAll('.activity__wrap')).filter(isVisible)
            : [];
          const expandBtn = box.querySelector('.sub-info .gray span');
          const expandText = (expandBtn?.textContent || '').trim();
          const batchDoneKey = 'v2-batch-done-' + i;
          if (processed.has(batchDoneKey)) {
            continue;
          }
          if (subActivities.length === 0 && expandBtn && typeof expandBtn.click === 'function' && !expandText.includes('收起')) {
            if (!pendingExpandBtn) {
              pendingExpandBtn = expandBtn;
              pendingExpandTitle = title;
            }
            continue;
          }
          const allSubs = subActivities.length > 0
            ? subActivities
            : (leafWrap ? Array.from(leafWrap.querySelectorAll('.activity__wrap')) : []);
          let chapterHasPending = false;
          for (let j = 0; j < allSubs.length; j += 1) {
            const sub = allSubs[j];
            const subAside = (sub.querySelector('.statistics-box .aside')?.textContent || '').replace(/\\s+/g, ' ').trim();
            const subStatHtml = (sub.querySelector('.statistics-box')?.innerHTML || '').toLowerCase();
            const subIsDone =
              subAside.includes('已完成') ||
              subAside.includes('已读') ||
              subAside.includes('已发表') ||
              subAside.includes('已参与') ||
              subAside.includes('已讨论') ||
              isFractionDone(subAside) ||
              /icon-(?:gou|check|wancheng|finish)|class="[^"]*(?:done|finish|success)/i.test(subStatHtml);
            if (subIsDone) continue;
            const subTagText = (sub.querySelector('.tag')?.textContent || '').trim();
            const subUse = sub.querySelector('.tag use') || sub.querySelector('.tag svg use');
            const subHref = subUse ? (subUse.getAttribute('xlink:href') || subUse.getAttribute('href') || '') : '';
            const subTitle = (sub.querySelector('h2, .title')?.textContent || sub.textContent || ('子项' + (j + 1))).replace(/\\s+/g, ' ').trim().slice(0, 40);
            const subKey = 'v2-sub-' + i + '-' + j + '-' + subTitle.slice(0, 24);
            if (processed.has(subKey)) continue;

            const isVideoOrAudio = subTagText.includes('音频') || subTagText.includes('视频') || subHref.includes('shipin');
            const isHomework = subTagText.includes('作业') || subTagText.includes('习题') || subTagText.includes('测验') || subHref.includes('zuoye');
            const isDiscuss = subTagText.includes('图文') || subTagText.includes('讨论') || subHref.includes('tuwen') || subHref.includes('taolun');
            const isCourseware = subTagText.includes('课件') || subHref.includes('kejian');

            const kind = isVideoOrAudio ? 'video' : isHomework ? 'homework' : isCourseware ? 'courseware' : isDiscuss ? 'discuss' : 'unknown';
            const label = isHomework ? '作业' : isVideoOrAudio ? (subTagText.includes('音频') ? '音频' : '视频') : isCourseware ? '课件' : (subTagText || '任务');

            candidates.push({
              el: sub,
              key: subKey,
              title: subTitle,
              kind,
              label,
            });
            chapterHasPending = true;
          }
          if (!chapterHasPending && (allSubs.length > 0 || expandText.includes('收起'))) {
            processed.add(batchDoneKey);
          }
          continue;
        }

        const key = 'v2-box-' + i + '-' + title;
        if (processed.has(key)) continue;

        if (itemType === 'shipin') {
          candidates.push({ el: course, key, title, kind: 'video', label: '视频' });
        } else if (itemType === 'kejian') {
          const checkBtn = box.querySelector('.ppt_img_box .check') || course;
          candidates.push({ el: checkBtn, key, title, kind: 'courseware', label: '课件' });
        } else if (itemType === 'ketang') {
          candidates.push({ el: course, key, title, kind: 'replay', label: '课堂回放' });
        } else if (itemType === 'zuoye') {
          candidates.push({ el: course, key, title, kind: 'homework', label: '作业' });
        } else if (itemType === 'taolun' || itemType === 'tuwen') {
          candidates.push({ el: course, key, title, kind: 'discuss', label: itemType === 'tuwen' ? '图文' : '讨论' });
        }
      }

      // Sequential progression across all candidates in chapter order
      const match = candidates.find((c) => {
        if (c.kind === 'video' && !config.enableVideo) return false;
        if (c.kind === 'homework' && !config.enableHomework) return false;
        if (c.kind === 'courseware' && !config.enableCourseware) return false;
        if (c.kind === 'replay' && !config.enableReplay) return false;
        if (c.kind === 'discuss' && !config.enableDiscussion) return false;
        return true;
      });
      if (match) {
        match.el.scrollIntoView({ behavior: 'instant', block: 'center' });
        match.el.click();
        return { status: 'clicked', key: match.key, title: match.title, itemType: match.label };
      }

      if (pendingExpandBtn) {
        pendingExpandBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
        pendingExpandBtn.click();
        return { status: 'expanded', key: '', title: pendingExpandTitle };
      }

      // 2. Check .leaf-detail items (in main document or embedded /pro/lms/ iframe)
      const leaves = queryAllDocs('.leaf-detail').filter(isVisible);
      const leafCandidates = [];
      for (let i = 0; i < leaves.length; i += 1) {
        const leaf = leaves[i];
        const pText = (leaf.querySelector('.progress-time')?.textContent || '').trim();
        if (pText.includes('已完成') || pText.includes('已读') || pText.includes('已提交') || pText.includes('100%')) {
          continue;
        }
        const useEl = leaf.querySelector('i svg use, i use');
        const iconCls = leaf.querySelector('i')?.className || '';
        const href = (useEl ? (useEl.getAttribute('xlink:href') || useEl.getAttribute('href') || '') : '') + ' ' + iconCls;
        const title = (leaf.querySelector('.title')?.textContent || ('第' + (i + 1) + '节')).replace(/\\s+/g, ' ').trim();
        const key = 'pro-leaf-' + i + '-' + title;
        if (processed.has(key)) continue;

        const isVideo = href.includes('shipin');
        const isHomework = href.includes('zuoye');
        const isCourseware = href.includes('tuwen') || href.includes('kejian');
        const isDiscuss = href.includes('taolun');
        const kind = isVideo ? 'video' : isHomework ? 'homework' : isCourseware ? 'courseware' : isDiscuss ? 'discuss' : 'unknown';
        const label = isHomework ? '作业' : isVideo ? '视频' : isCourseware ? '课件' : '课程内容';
        leafCandidates.push({ el: leaf, key, title, kind, label });
      }

      // Sequential progression across all leaf candidates in catalog order
      const leafMatch = leafCandidates.find((c) => {
        if (c.kind === 'video' && !config.enableVideo) return false;
        if (c.kind === 'homework' && !config.enableHomework) return false;
        if (c.kind === 'courseware' && !config.enableCourseware) return false;
        if (c.kind === 'discuss' && !config.enableDiscussion) return false;
        return true;
      });
      if (leafMatch) {
        leafMatch.el.scrollIntoView({ behavior: 'instant', block: 'center' });
        leafMatch.el.click();
        return { status: 'clicked', key: leafMatch.key, title: leafMatch.title, itemType: leafMatch.label };
      }

      // Check if we can scroll .viewContainer to load more items
      for (const vc of queryAllDocs('.viewContainer')) {
        if (vc && vc.scrollTop + vc.clientHeight + 30 < vc.scrollHeight) {
          vc.scrollTop = vc.scrollHeight;
          return { status: 'scrolled' };
        }
      }

      if (boxes.length === 0 && leaves.length === 0) return { status: 'empty' };
      return { status: 'all-done' };
    }

    return { status: 'empty' };
  })()`;
}

function buildCheckAndRunV2InlineTaskScript(
  config: CourseBrushConfig,
): string {
  return `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const config = ${JSON.stringify(config)};

    function getAccessibleDocs() {
      const docs = [document];
      for (const ifr of Array.from(document.querySelectorAll('iframe'))) {
        try {
          if (ifr.contentDocument && ifr.contentDocument.body) docs.push(ifr.contentDocument);
        } catch {}
      }
      return docs;
    }

    for (const doc of getAccessibleDocs()) {
      // 1. Check PPT swiper slides (.swiper-wrapper)
      const slides = doc.querySelectorAll('.swiper-wrapper .swiper-slide');
      if (slides.length > 0 && config.enableCourseware) {
        for (let i = 0; i < slides.length; i += 1) {
          slides[i].click();
          await sleep(600);
        }
        const videoBoxes = doc.querySelectorAll('.video-box');
        for (let i = 0; i < videoBoxes.length; i += 1) {
          videoBoxes[i].click();
          await sleep(1000);
          const v = doc.querySelector('video');
          if (v) {
            v.muted = config.muteAudio;
            v.playbackRate = config.playbackRate;
            v.play().catch(() => {});
          }
        }
        return {
          handled: true,
          kind: 'courseware',
          message: '已完成课件 PPT 翻页浏览 (' + slides.length + ' 页)',
          navigateBack: videoBoxes.length === 0,
        };
      }

      // 2. Check inline discussion comment (#new_discuss)
      const discussBox = doc.querySelector('#new_discuss');
      if (discussBox && config.enableDiscussion) {
        const firstComment = discussBox.querySelector('.new_discuss_list .cont_detail');
        const textarea = doc.querySelector('.el-textarea__inner');
        const submitBtn = doc.querySelector('.el-button.submitComment');
        if (firstComment && textarea && textarea.tagName === 'TEXTAREA' && submitBtn && typeof submitBtn.click === 'function') {
          const text = (firstComment.textContent || '').trim();
          if (text) {
            const win = doc.defaultView || window;
            const desc = win.HTMLTextAreaElement ? Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value') : null;
            textarea.focus();
            if (desc && desc.set) desc.set.call(textarea, text);
            else textarea.value = text;
            textarea.dispatchEvent(new win.Event('input', { bubbles: true }));
            textarea.dispatchEvent(new win.Event('change', { bubbles: true }));
            await sleep(400);
            submitBtn.click();
            await sleep(1200);
            return {
              handled: true,
              kind: 'discussion',
              message: '已自动跟评讨论区：' + text.slice(0, 24),
              navigateBack: true,
            };
          }
        }
      }
    }

    return { handled: false, kind: 'none', message: '', navigateBack: false };
  })()`;
}

export function buildHandleContentExtraTaskScript(config: CourseBrushConfig): string {
  return `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const config = ${JSON.stringify(config)};

    function getAccessibleDocs() {
      const docs = [document];
      for (const ifr of Array.from(document.querySelectorAll('iframe'))) {
        try {
          if (ifr.contentDocument && ifr.contentDocument.body) docs.push(ifr.contentDocument);
        } catch {}
      }
      return docs;
    }

    const url = location.href;
    const activeLeaf = document.querySelector('.nav-item-leaf-box .leaf-item.is-active, .nav-item-leaf-box .leaf-item.active, .leaf-item.is-active, .leaf-item.active, .nav-item-leaf-box.is-active, .nav-item-leaf-box.active');
    const activeLeafText = (activeLeaf?.textContent || '').replace(/\\s+/g, ' ').trim();
    const isAiDiscussUnit =
      /\\/ai-workspace\\/lms-graph\\/[^/]+\\/(forum|discuss|discussion)/i.test(url) ||
      /^讨论/.test(activeLeafText);

    for (const doc of getAccessibleDocs()) {
      const win = doc.defaultView || window;
      const docUrl = doc.location?.href || '';

      // 0. Handle iframe-quiz cover page ("开始做题" / "继续做题")
      if (config.enableHomework && (docUrl.includes('/iframe-quiz/') || docUrl.includes('/v/exam/') || /^作业|^练习|^测验/.test(activeLeafText))) {
        const bodyText = (doc.body?.innerText || '').replace(/\\s+/g, ' ').trim();
        const startExamBtn = Array.from(doc.querySelectorAll('button, .el-button, a, div[role="button"], span.btn')).find((b) => {
          const t = (b.innerText || b.textContent || '').replace(/\\s+/g, '').trim();
          return /^(开始做题|继续做题|开始答题|继续答题|去作答|立即作答|重新作答)$/.test(t);
        });
        if (startExamBtn && typeof startExamBtn.click === 'function') {
          startExamBtn.click();
          await sleep(1500);
          return { action: 'waiting', message: '已点击「开始做题」，正在进入试卷…' };
        }
        if (docUrl.includes('/cover') && /(已完成|已提交|得分|成绩|查看试卷)/.test(bodyText) && !startExamBtn) {
          return { action: 'done', message: '该章节测验已完成' };
        }
      }

      const checkBtn = doc.querySelector('.ppt_img_box .check, p.check');
      if (
        checkBtn &&
        typeof checkBtn.click === 'function' &&
        (checkBtn.textContent || '').trim() === '查看课件' &&
        !doc.querySelector('.swiper-wrapper .swiper-slide') &&
        config.enableCourseware
      ) {
        checkBtn.click();
        await sleep(1800);
      }

      const slides = doc.querySelectorAll('.swiper-wrapper .swiper-slide');
      if (slides.length > 0 && config.enableCourseware && !win.__yktSlidesClicked) {
        win.__yktSlidesClicked = true;
        for (let i = 0; i < slides.length; i += 1) {
          slides[i].click();
          await sleep(500);
        }
        const unplayedVideoBox = Array.from(doc.querySelectorAll('.video-box')).find(
          (vb) => !(vb.textContent || '').includes('已完成')
        );
        if (unplayedVideoBox && typeof unplayedVideoBox.click === 'function') {
          unplayedVideoBox.click();
          await sleep(1200);
          return { action: 'waiting', message: '课件 PPT 已翻完，正在播放内嵌视频…' };
        }
        return { action: 'done', message: '课件 PPT (' + slides.length + ' 页) 已浏览完毕' };
      }

      const unplayedVideoBox = Array.from(doc.querySelectorAll('.video-box')).find(
        (vb) => !(vb.textContent || '').includes('已完成')
      );
      if (unplayedVideoBox && typeof unplayedVideoBox.click === 'function' && !doc.querySelector('video') && config.enableCourseware) {
        unplayedVideoBox.click();
        await sleep(1200);
        return { action: 'waiting', message: '已打开课件内嵌视频播放器…' };
      }

      // Discussion unit handling (only on dedicated discussion pages or #new_discuss, never on video pages)
      if (config.enableDiscussion && (isAiDiscussUnit || doc.querySelector('#new_discuss, .publish_discuss, .discuss-list'))) {
        function hasUserAlreadyCommentedInPage(d) {
          const ownActions = Array.from(
            d.querySelectorAll(
              '#new_discuss [class*="del"], #new_discuss [class*="delete"], #new_discuss [class*="edit"], .discuss-list [class*="del"], .discuss-list [class*="delete"], .discuss-list [class*="edit"], .new_discuss_list [class*="del"], .new_discuss_list [class*="delete"], .del-btn, .delete-btn, .btn-del'
            )
          );
          if (ownActions.some((el) => {
            const t = (el.textContent || '').trim();
            return /删除|撤回|编辑/i.test(t) || el.className.includes('del') || el.className.includes('delete');
          })) {
            return true;
          }

          const myBadges = Array.from(d.querySelectorAll('.my-comment, .is-me, .comment-me, [class*="author-me"]'));
          if (myBadges.length > 0) return true;

          try {
            const stored = JSON.parse(localStorage.getItem('__ykt_commented_discussions') || '[]');
            const leafMatch = location.href.match(/\/ai-workspace\/lms-graph\/\d+\/[^/?#]+\/(\d+)/i) || location.href.match(/node_id=(\d+)/i);
            const leafId = leafMatch ? leafMatch[1] : '';
            if (leafId && stored.some((item) => String(item) === String(leafId))) {
              return true;
            }
            if (stored.includes(location.href)) {
              return true;
            }
          } catch {}

          return false;
        }

        function markDiscussDoneInStorage() {
          try {
            const stored = JSON.parse(localStorage.getItem('__ykt_commented_discussions') || '[]');
            const leafMatch = location.href.match(/\/ai-workspace\/lms-graph\/\d+\/[^/?#]+\/(\d+)/i) || location.href.match(/node_id=(\d+)/i);
            const leafId = leafMatch ? leafMatch[1] : '';
            if (leafId && /^\d+$/.test(leafId) && !stored.includes(leafId)) {
              stored.push(leafId);
              localStorage.setItem('__ykt_commented_discussions', JSON.stringify(stored));
            }
          } catch {}
          win.__yktLastDiscussUrl = url;
        }

        if (win.__yktLastDiscussUrl === url || hasUserAlreadyCommentedInPage(doc)) {
          markDiscussDoneInStorage();
          return { action: 'done', message: '当前讨论单元已发言过，无需重复发言，直接跳过' };
        }

        const discussCandidates = Array.from(
          doc.querySelectorAll(
            '#new_discuss .new_discuss_list .cont_detail, .discuss-list .comment-content, .cont_detail.word-break, [class*="comment"] [class*="content"], [class*="discuss"] p, [class*="reply"] p, [class*="post"] p'
          )
        );
        const firstValidComment = discussCandidates
          .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
          .find(
            (t) =>
              t.length >= 2 &&
              t.length <= 220 &&
              !/^\d{4}[-/]\d{1,2}/.test(t) &&
              !/^\d+$/.test(t) &&
              !/发表你的观点|暂无评论|还没有人发言|Shift\+Enter|全部评论|话题详情|编辑于|条评论/.test(t)
          );

        const inputEl = doc.querySelector(
          'textarea[placeholder*="观点"], textarea[placeholder*="评论"], textarea[placeholder*="讨论"], textarea.el-textarea__inner, .publish_discuss textarea, #new_discuss textarea, .publish_discuss [contenteditable="true"], #new_discuss [contenteditable="true"], [contenteditable="true"], textarea'
        );
        let submitBtn =
          doc.querySelector('.el-button.submitComment, .publish_discuss .postBtn button, .submit-comment-btn, #new_discuss button[class*="submit"], #new_discuss button[class*="post"]') ||
          Array.from(doc.querySelectorAll('button, .el-button, a[role="button"], span[role="button"], div[role="button"]')).find((b) =>
            /^(发送|发表|发表评论|发布|提交评论|回复)$/.test((b.textContent || '').replace(/\s+/g, '').trim())
          );

        if (!submitBtn && inputEl) {
          const inputWrap = inputEl.parentElement?.parentElement || inputEl.parentElement;
          if (inputWrap) {
            const enterHint = Array.from(inputWrap.querySelectorAll('span, div')).find(
              (el) => el.children.length === 0 && /Enter\s*发送/i.test(el.textContent || '')
            );
            if (enterHint && enterHint.parentElement) {
              submitBtn =
                enterHint.nextElementSibling ||
                enterHint.parentElement.querySelector('button, svg, i, [class*="send"], [class*="submit"]') ||
                enterHint.parentElement.lastElementChild;
            }
          }
        }

        if (inputEl) {
          const text = firstValidComment || '坚持党的领导，坚定理想信念！';
          inputEl.focus();
          if (inputEl.tagName === 'TEXTAREA' || inputEl.tagName === 'INPUT') {
            const desc = win.HTMLTextAreaElement ? Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value') : null;
            if (desc && desc.set) desc.set.call(inputEl, text);
            else inputEl.value = text;
            inputEl.dispatchEvent(new win.Event('input', { bubbles: true }));
            inputEl.dispatchEvent(new win.Event('change', { bubbles: true }));
          } else {
            inputEl.innerText = text;
            inputEl.dispatchEvent(new win.InputEvent('input', { bubbles: true, data: text }));
            inputEl.dispatchEvent(new win.Event('change', { bubbles: true }));
          }
          await sleep(450);
          if (submitBtn && typeof submitBtn.click === 'function') {
            submitBtn.click();
          }
          try {
            const enterOpts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
            inputEl.dispatchEvent(new win.KeyboardEvent('keydown', enterOpts));
            inputEl.dispatchEvent(new win.KeyboardEvent('keypress', enterOpts));
            inputEl.dispatchEvent(new win.KeyboardEvent('keyup', enterOpts));
          } catch {}
          markDiscussDoneInStorage();
          await sleep(1500);
          return { action: 'done', message: '讨论区已自动发表评论：' + text.slice(0, 20) };
        }

        if (isAiDiscussUnit) {
          return { action: 'waiting', message: '正在等待讨论区评论输入框加载…' };
        }
      }
    }

    return { action: 'none', message: '' };
  })()`;
}

export function buildAdvanceToNextUnitOrBackScript(
  config: CourseBrushConfig,
  processedKeys: readonly string[],
  completedKeys: readonly string[] = [],
): string {
  return `(() => {
${ORDERED_PROGRESS_MAPPING_JS}
    const config = ${JSON.stringify(config)};
    const processed = new Set(${JSON.stringify(processedKeys)});
    const completedCache = new Set(${JSON.stringify(completedKeys)});
    const docs = [document];
    for (const ifr of Array.from(document.querySelectorAll('iframe'))) {
      try {
        if (ifr.contentDocument && ifr.contentDocument.body) docs.push(ifr.contentDocument);
      } catch {}
    }

    function getCombinedItemSig(el) {
      if (!el) return { html: '', text: '', hrefs: [] };
      const html = (el.innerHTML || '').toLowerCase();
      const text = (el.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const hrefs = [];
      try {
        const uses = el.querySelectorAll('use');
        for (const u of uses) {
          const h = (u.getAttribute('xlink:href') || u.getAttribute('href') || '').toLowerCase();
          if (h) hrefs.push(h);
        }
      } catch {}
      const combined = html + ' ' + hrefs.join(' ') + ' ' + text;
      return { html, text, hrefs, combined };
    }

    function isVideoItem(el) {
      const { combined, text } = getCombinedItemSig(el);
      if (combined.includes('icon-shipin') || combined.includes('shipin') || combined.includes('video') || combined.includes('icon-video')) return true;
      if (/^(?:\\[?视频\\]?|\\[?音频\\]?|video|audio)/i.test(text) || /视频|音频/.test(text.slice(0, 8))) return true;
      const tagText = (el.querySelector?.('.tag, .leaf-tag, [class*="tag"]')?.textContent || '').trim().toLowerCase();
      if (/视频|音频|video|audio/.test(tagText)) return true;
      return false;
    }

    function isDiscussItem(el) {
      const { combined, text } = getCombinedItemSig(el);
      if (combined.includes('icon-taolun') || combined.includes('icon-tuwen') || combined.includes('taolun') || combined.includes('discuss') || combined.includes('forum')) return true;
      if (/^(?:\\[?讨论\\]?|\\[?图文\\]?|discuss|forum)/i.test(text) || /讨论|图文/.test(text.slice(0, 8))) return true;
      const tagText = (el.querySelector?.('.tag, .leaf-tag, [class*="tag"]')?.textContent || '').trim().toLowerCase();
      if (/讨论|图文|discuss|forum/.test(tagText)) return true;
      return false;
    }

    function isHomeworkItem(el) {
      const { combined, text } = getCombinedItemSig(el);
      if (combined.includes('icon-zuoye') || combined.includes('zuoye') || combined.includes('homework') || combined.includes('quiz') || combined.includes('exam') || combined.includes('ceyan') || combined.includes('lianxi')) return true;
      if (/^(?:\\[?作业\\]?|\\[?练习\\]?|\\[?习题\\]?|\\[?测验\\]?|\\[?测试\\]?|\\[?考试\\]?)/i.test(text) || /作业|练习|习题|测验|测试|考试/.test(text.slice(0, 8))) return true;
      const tagText = (el.querySelector?.('.tag, .leaf-tag, [class*="tag"]')?.textContent || '').trim().toLowerCase();
      if (/作业|练习|习题|测验|测试|考试/.test(tagText)) return true;
      return false;
    }

    function isCoursewareItem(el) {
      const { combined, text } = getCombinedItemSig(el);
      if (combined.includes('icon-kejian') || combined.includes('kejian') || combined.includes('courseware') || combined.includes('ppt') || combined.includes('pdf') || combined.includes('doc')) return true;
      if (/^(?:\\[?课件\\]?|\\[?文档\\]?)/i.test(text) || /课件|文档/.test(text.slice(0, 8))) return true;
      const tagText = (el.querySelector?.('.tag, .leaf-tag, [class*="tag"]')?.textContent || '').trim().toLowerCase();
      if (/课件|文档|ppt|pdf/.test(tagText)) return true;
      return false;
    }

    function isAiBoxDone(box) {
      if (!box) return false;
      const attrDone = box.getAttribute('data-ykt-leaf-done');
      if (attrDone === 'true') return true;
      const pct = box.getAttribute('data-ykt-leaf-pct');
      if (pct !== null && Number(pct) >= 99) return true;

      const leafId = box.getAttribute('data-ykt-leaf-id');
      if (leafId) {
        if (completedCache.has(leafId)) return true;
        const cacheProg = window.__yktProgressCache?.byId?.[leafId];
        if (cacheProg && (cacheProg.progress || 0) >= 0.995) return true;
      }

      const t = (box.textContent || '').replace(/\\s+/g, ' ').trim();
      if (/已完成|已读|已提交|已发表|已参与|已讨论|100%/.test(t)) return true;

      const { html, hrefs } = getCombinedItemSig(box);
      for (const h of hrefs) {
        if (h.includes('wancheng') || h.includes('finish') || h.includes('gou') || h.includes('check') || h.includes('complete')) {
          return true;
        }
      }
      if (/icon-wancheng|icon-finish|icon-gou|icon-check|is-finished|finished|completed|is-completed|\\bdone\\b|el-icon-check|is-success/i.test(html)) {
        return true;
      }

      const svgs = box.querySelectorAll('svg');
      for (const s of svgs) {
        const sHtml = (s.innerHTML || '').toLowerCase();
        const sCls = (s.getAttribute('class') || '').toLowerCase();
        if (/check|finish|done|success|gou|wancheng/.test(sCls) || /check|finish|done|success|gou|wancheng/.test(sHtml)) {
          return true;
        }
      }

      try {
        const completedStorage = JSON.parse(localStorage.getItem('__ykt_completed_units') || '[]');
        if (Array.isArray(completedStorage) && completedStorage.length > 0) {
          if (leafId && completedStorage.includes(leafId)) return true;
        }
      } catch {}

      try {
        const commentedStorage = JSON.parse(localStorage.getItem('__ykt_commented_discussions') || '[]');
        if (Array.isArray(commentedStorage) && commentedStorage.length > 0) {
          if (leafId && commentedStorage.some((k) => String(k) === String(leafId))) return true;
        }
      } catch {}

      return false;
    }

    for (const doc of docs) {
      // 1. Pro LMS .btn-next
      const btnNext = doc.querySelector('.btn-next');
      if (btnNext && typeof btnNext.click === 'function' && btnNext.offsetParent !== null) {
        btnNext.click();
        return { advanced: true, message: '点击「下一单元」(.btn-next)' };
      }

      // 2. AI Workspace sidebar (.nav-item-leaf-box)
      const rawBoxes = Array.from(doc.querySelectorAll('.nav-item-leaf-box'));
      const navItems = rawBoxes.length > 0 ? rawBoxes : Array.from(doc.querySelectorAll('.leaf-item'));
      if (navItems.length > 0) {
        const activeCache = window.__yktProgressCache;
        if (activeCache && Array.isArray(activeCache.list) && activeCache.list.length > 0) {
          yktApplyOrderedProgress(navItems, activeCache.list);
        }

        let activeIdx = navItems.findIndex((el) =>
          /active|current|is-active|selected/i.test((el.className || '') + ' ' + (el.firstElementChild?.className || '')) ||
          Boolean(el.querySelector('.is-active, .active'))
        );
        const scanOrder = [];
        for (let i = activeIdx + 1; i < navItems.length; i += 1) {
          scanOrder.push(i);
        }
        for (let i = 0; i < activeIdx; i += 1) {
          scanOrder.push(i);
        }

        // Sequential chapter progression: advance to the next unfinished enabled unit in natural
        // catalog order (videos, then the same chapter's discussions/homework, then next chapter).
        for (const i of scanOrder) {
          const item = navItems[i];
          const text = (item.textContent || '').replace(/\\s+/g, ' ').trim();
          if (!text || isAiBoxDone(item)) continue;
          const key = 'ai-nav-' + i + '-' + text.slice(0, 24);
          const isVideo = isVideoItem(item);
          const isDiscuss = isDiscussItem(item);
          const isHomework = isHomeworkItem(item);
          const isCourseware = isCoursewareItem(item);

          if (
            (isVideo && !config.enableVideo) ||
            (isDiscuss && !config.enableDiscussion) ||
            (isHomework && !config.enableHomework) ||
            (isCourseware && !config.enableCourseware)
          ) {
            continue;
          }

          if (isDiscuss) {
            const leafId = item.getAttribute('data-ykt-leaf-id');
            let alreadyCommented = false;
            try {
              const stored = JSON.parse(localStorage.getItem('__ykt_commented_discussions') || '[]');
              if (leafId && stored.some((id) => String(id) === String(leafId))) alreadyCommented = true;
            } catch {}
            if (alreadyCommented) continue;
          }

          const pctAttr = item.getAttribute('data-ykt-leaf-pct');
          const pctLabel = pctAttr !== null ? ' (当前进度 ' + pctAttr + '%)' : '';

          item.scrollIntoView({ behavior: 'instant', block: 'center' });
          const clickTarget = item.querySelector('.leaf-item') || item.firstElementChild || item;
          if (clickTarget && typeof clickTarget.click === 'function') {
            clickTarget.click();
            return { advanced: true, key, message: '切换到未完成单元：' + text.slice(0, 28) + pctLabel };
          }
        }
      }
    }

    return { advanced: false, message: '' };
  })()`;
}

export function buildDetectAndJumpToFirstIncompleteScript(
  config: CourseBrushConfig,
  completedKeys: readonly string[] = [],
): string {
  return `(async () => {
${ORDERED_PROGRESS_MAPPING_JS}
    const config = ${JSON.stringify(config)};
    const completedCache = new Set(${JSON.stringify(completedKeys)});
    const docs = [document];
    for (const ifr of Array.from(document.querySelectorAll('iframe'))) {
      try {
        if (ifr.contentDocument && ifr.contentDocument.body) docs.push(ifr.contentDocument);
      } catch {}
    }

    function isVisible(el) {
      if (!el || el.nodeType !== 1) return false;
      const r = el.getBoundingClientRect();
      return r.width > 4 && r.height > 4;
    }

    function getCombinedItemSig(el) {
      if (!el) return { html: '', text: '', hrefs: [] };
      const html = (el.innerHTML || '').toLowerCase();
      const text = (el.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const hrefs = [];
      try {
        const uses = el.querySelectorAll('use');
        for (const u of uses) {
          const h = (u.getAttribute('xlink:href') || u.getAttribute('href') || '').toLowerCase();
          if (h) hrefs.push(h);
        }
      } catch {}
      const combined = html + ' ' + hrefs.join(' ') + ' ' + text;
      return { html, text, hrefs, combined };
    }

    function isVideoItem(el) {
      const { combined, text } = getCombinedItemSig(el);
      if (combined.includes('icon-shipin') || combined.includes('shipin') || combined.includes('video') || combined.includes('icon-video')) return true;
      if (/^(?:\\[?视频\\]?|\\[?音频\\]?|video|audio)/i.test(text) || /视频|音频/.test(text.slice(0, 8))) return true;
      const tagText = (el.querySelector?.('.tag, .leaf-tag, [class*="tag"]')?.textContent || '').trim().toLowerCase();
      if (/视频|音频|video|audio/.test(tagText)) return true;
      return false;
    }

    function isDiscussItem(el) {
      const { combined, text } = getCombinedItemSig(el);
      if (combined.includes('icon-taolun') || combined.includes('icon-tuwen') || combined.includes('taolun') || combined.includes('discuss') || combined.includes('forum')) return true;
      if (/^(?:\\[?讨论\\]?|\\[?图文\\]?|discuss|forum)/i.test(text) || /讨论|图文/.test(text.slice(0, 8))) return true;
      const tagText = (el.querySelector?.('.tag, .leaf-tag, [class*="tag"]')?.textContent || '').trim().toLowerCase();
      if (/讨论|图文|discuss|forum/.test(tagText)) return true;
      return false;
    }

    function isHomeworkItem(el) {
      const { combined, text } = getCombinedItemSig(el);
      if (combined.includes('icon-zuoye') || combined.includes('zuoye') || combined.includes('homework') || combined.includes('quiz') || combined.includes('exam') || combined.includes('ceyan') || combined.includes('lianxi')) return true;
      if (/^(?:\\[?作业\\]?|\\[?练习\\]?|\\[?习题\\]?|\\[?测验\\]?|\\[?测试\\]?|\\[?考试\\]?)/i.test(text) || /作业|练习|习题|测验|测试|考试/.test(text.slice(0, 8))) return true;
      const tagText = (el.querySelector?.('.tag, .leaf-tag, [class*="tag"]')?.textContent || '').trim().toLowerCase();
      if (/作业|练习|习题|测验|测试|考试/.test(tagText)) return true;
      return false;
    }

    function isCoursewareItem(el) {
      const { combined, text } = getCombinedItemSig(el);
      if (combined.includes('icon-kejian') || combined.includes('kejian') || combined.includes('courseware') || combined.includes('ppt') || combined.includes('pdf') || combined.includes('doc')) return true;
      if (/^(?:\\[?课件\\]?|\\[?文档\\]?)/i.test(text) || /课件|文档/.test(text.slice(0, 8))) return true;
      const tagText = (el.querySelector?.('.tag, .leaf-tag, [class*="tag"]')?.textContent || '').trim().toLowerCase();
      if (/课件|文档|ppt|pdf/.test(tagText)) return true;
      return false;
    }

    function isAiBoxDone(box) {
      if (!box) return false;
      const attrDone = box.getAttribute('data-ykt-leaf-done');
      if (attrDone === 'true') return true;
      const pct = box.getAttribute('data-ykt-leaf-pct');
      if (pct !== null && Number(pct) >= 99) return true;

      const leafId = box.getAttribute('data-ykt-leaf-id');
      if (leafId) {
        if (completedCache.has(leafId)) return true;
        const cacheProg = window.__yktProgressCache?.byId?.[leafId];
        if (cacheProg && (cacheProg.progress || 0) >= 0.995) return true;
      }

      const t = (box.textContent || '').replace(/\\s+/g, ' ').trim();
      if (/已完成|已读|已提交|已发表|已参与|已讨论|100%/.test(t)) return true;

      const { html, hrefs } = getCombinedItemSig(box);
      for (const h of hrefs) {
        if (h.includes('wancheng') || h.includes('finish') || h.includes('gou') || h.includes('check') || h.includes('complete')) {
          return true;
        }
      }
      if (/icon-wancheng|icon-finish|icon-gou|icon-check|is-finished|finished|completed|is-completed|\\bdone\\b|el-icon-check|is-success/i.test(html)) {
        return true;
      }

      const svgs = box.querySelectorAll('svg');
      for (const s of svgs) {
        const sHtml = (s.innerHTML || '').toLowerCase();
        const sCls = (s.getAttribute('class') || '').toLowerCase();
        if (/check|finish|done|success|gou|wancheng/.test(sCls) || /check|finish|done|success|gou|wancheng/.test(sHtml)) {
          return true;
        }
      }

      try {
        const completedStorage = JSON.parse(localStorage.getItem('__ykt_completed_units') || '[]');
        if (Array.isArray(completedStorage) && completedStorage.length > 0) {
          if (leafId && completedStorage.includes(leafId)) return true;
        }
      } catch {}

      try {
        const commentedStorage = JSON.parse(localStorage.getItem('__ykt_commented_discussions') || '[]');
        if (Array.isArray(commentedStorage) && commentedStorage.length > 0) {
          if (leafId && commentedStorage.some((k) => String(k) === String(leafId))) return true;
        }
      } catch {}

      return false;
    }

    // 1. AI Workspace sidebar check (.nav-item-leaf-box)
    for (const doc of docs) {
      const rawBoxes = Array.from(doc.querySelectorAll('.nav-item-leaf-box'));
      const navItems = rawBoxes.length > 0 ? rawBoxes : Array.from(doc.querySelectorAll('.leaf-item'));
      if (navItems.length > 0) {
        const aiMatch = location.href.match(/\\/ai-workspace\\/lms-graph\\/(\\d+)/i);
        const aiClassroomId = aiMatch ? aiMatch[1] : '';
        if (aiClassroomId && (!window.__yktProgressCache || window.__yktProgressCache.classroomId !== aiClassroomId)) {
          try {
            const resp = await fetch('/c27/online_courseware/schedule/course/progress/?classroom_id=' + aiClassroomId, {
              credentials: 'include',
            });
            if (resp.ok) {
              const json = await resp.json();
              const list = [];
              const byId = {};
              function walkProgress(nodes) {
                if (!Array.isArray(nodes)) return;
                for (const node of nodes) {
                  if (!node || typeof node !== 'object') continue;
                  if (Array.isArray(node.section_leaf_list)) {
                    walkProgress(node.section_leaf_list);
                  } else if (Array.isArray(node.children)) {
                    walkProgress(node.children);
                  } else if (node.id !== undefined && node.progress !== undefined) {
                    const item = {
                      id: String(node.id),
                      name: String(node.name || '').replace(/\\s+/g, ' ').trim(),
                      leafType: node.leaf_type,
                      progress: Number(node.progress || 0),
                    };
                    list.push(item);
                    byId[item.id] = item;
                  }
                }
              }
              walkProgress(json?.data?.course_progress);
              if (list.length > 0) {
                window.__yktProgressCache = {
                  classroomId: aiClassroomId,
                  ts: Date.now(),
                  list,
                  byId,
                };
              }
            }
          } catch {}
        }

        const activeCache = window.__yktProgressCache;
        if (activeCache && Array.isArray(activeCache.list) && activeCache.list.length > 0) {
          yktApplyOrderedProgress(navItems, activeCache.list);
        }

        let activeIdx = navItems.findIndex((el) =>
          /active|current|is-active|selected/i.test((el.className || '') + ' ' + (el.firstElementChild?.className || '')) ||
          Boolean(el.querySelector('.is-active, .active'))
        );
        if (activeIdx === -1) {
          const m = location.href.match(/node_id=(\\d+)/i) || location.href.match(/\\/ai-workspace\\/lms-graph\\/\\d+\\/[^/?#]+\\/(\\d+)/i);
          if (m && m[1]) {
            activeIdx = navItems.findIndex((el) => el.getAttribute('data-ykt-leaf-id') === m[1]);
          }
        }

        let firstIncompleteIdx = -1;
        let firstIncompleteTitle = '';
        let firstIncompleteItem = null;

        // Sequential chapter progression: first unfinished enabled unit in natural catalog order
        // (a chapter's videos, then that chapter's discussions/homework, then the next chapter).
        for (let i = 0; i < navItems.length; i += 1) {
          const item = navItems[i];
          const text = (item.textContent || '').replace(/\\s+/g, ' ').trim();
          if (!text || isAiBoxDone(item)) continue;
          const isVideo = isVideoItem(item);
          const isDiscuss = isDiscussItem(item);
          const isHomework = isHomeworkItem(item);
          const isCourseware = isCoursewareItem(item);
          if (
            (isVideo && !config.enableVideo) ||
            (isDiscuss && !config.enableDiscussion) ||
            (isHomework && !config.enableHomework) ||
            (isCourseware && !config.enableCourseware)
          ) {
            continue;
          }
          if (!isVideo && !isDiscuss && !isHomework && !isCourseware) continue;
          if (isDiscuss) {
            const leafId = item.getAttribute('data-ykt-leaf-id');
            let alreadyCommented = false;
            try {
              const stored = JSON.parse(localStorage.getItem('__ykt_commented_discussions') || '[]');
              if (leafId && stored.some((id) => String(id) === String(leafId))) alreadyCommented = true;
            } catch {}
            if (alreadyCommented) continue;
          }
          firstIncompleteIdx = i;
          firstIncompleteTitle = text;
          firstIncompleteItem = item;
          break;
        }

        if (firstIncompleteIdx === -1) {
          return { ready: true, allCompleted: true, total: navItems.length };
        }

        const targetPct = firstIncompleteItem.getAttribute('data-ykt-leaf-pct');
        const pctLabel = targetPct !== null ? ' (当前进度 ' + targetPct + '%)' : '';
        const fullTitle = firstIncompleteTitle + pctLabel;

        if (firstIncompleteIdx === activeIdx) {
          return {
            ready: true,
            alreadyAtTarget: true,
            activeIdx,
            targetIdx: firstIncompleteIdx,
            total: navItems.length,
            title: fullTitle,
          };
        }

        firstIncompleteItem.scrollIntoView({ behavior: 'instant', block: 'center' });
        const clickTarget = firstIncompleteItem.querySelector('.leaf-item') || firstIncompleteItem.firstElementChild || firstIncompleteItem;
        if (clickTarget && typeof clickTarget.click === 'function') {
          clickTarget.click();
          return {
            ready: true,
            switched: true,
            activeIdx,
            targetIdx: firstIncompleteIdx,
            total: navItems.length,
            title: fullTitle,
          };
        }
      }
    }

    // 2. Pro LMS .leaf-detail in catalog
    for (const doc of docs) {
      const leaves = Array.from(doc.querySelectorAll('.leaf-detail')).filter(isVisible);
      if (leaves.length > 0) {
        let activeIdx = leaves.findIndex((el) => /active|current|is-active|selected/i.test(el.className || ''));
        let firstIncompleteIdx = -1;
        let firstIncompleteTitle = '';
        let firstIncompleteItem = null;

        function isLeafDone(leaf) {
          const pText = (leaf.querySelector('.progress-time')?.textContent || '').trim();
          if (pText.includes('已完成') || pText.includes('已读') || pText.includes('已提交') || pText.includes('100%')) {
            return true;
          }
          const useEl = leaf.querySelector('i svg use, i use');
          const href = (useEl ? (useEl.getAttribute('xlink:href') || useEl.getAttribute('href') || '') : '').toLowerCase();
          if (href.includes('wancheng') || href.includes('finish') || href.includes('gou') || href.includes('check')) return true;
          return false;
        }

        // Sequential chapter progression: first unfinished enabled leaf in catalog order
        for (let i = 0; i < leaves.length; i += 1) {
          const leaf = leaves[i];
          if (isLeafDone(leaf)) continue;
          const useEl = leaf.querySelector('i svg use, i use');
          const iconCls = leaf.querySelector('i')?.className || '';
          const href = ((useEl ? (useEl.getAttribute('xlink:href') || useEl.getAttribute('href') || '') : '') + ' ' + iconCls).toLowerCase();
          const text = (leaf.querySelector('.title')?.textContent || ('第' + (i + 1) + '节')).replace(/\\s+/g, ' ').trim();
          const isVideo = href.includes('shipin') || href.includes('video');
          const isHomework = href.includes('zuoye') || href.includes('homework');
          const isCourseware = href.includes('tuwen') || href.includes('kejian') || href.includes('courseware');
          const isDiscuss = href.includes('taolun') || href.includes('discuss');
          if (
            (isVideo && config.enableVideo) ||
            (isHomework && config.enableHomework) ||
            (isCourseware && config.enableCourseware) ||
            (isDiscuss && config.enableDiscussion)
          ) {
            firstIncompleteIdx = i;
            firstIncompleteTitle = text;
            firstIncompleteItem = leaf;
            break;
          }
        }

        if (firstIncompleteIdx === -1) {
          return { ready: true, allCompleted: true, total: leaves.length };
        }

        if (firstIncompleteIdx === activeIdx) {
          return {
            ready: true,
            alreadyAtTarget: true,
            activeIdx,
            targetIdx: firstIncompleteIdx,
            total: leaves.length,
            title: firstIncompleteTitle,
          };
        }

        firstIncompleteItem.scrollIntoView({ behavior: 'instant', block: 'center' });
        firstIncompleteItem.click();
        return {
          ready: true,
          switched: true,
          activeIdx,
          targetIdx: firstIncompleteIdx,
          total: leaves.length,
          title: firstIncompleteTitle,
        };
      }
    }

    return { ready: false, noSidebar: true };
  })()`;
}

function buildInstallSandboxScript(mode: 'directory' | 'homework'): string {
  return `(() => {
    const initialMode = ${JSON.stringify(mode)};

    const state = (window.__yktSandboxState = window.__yktSandboxState || {
      view: initialMode,
      activeTaskKey: null,
      tasks: {
        video: false,
        courseware: false,
        discuss: false,
        homework: false,
      },
      activeQuestionIdx: 0,
      questions: [
        {
          type: 'single',
          typeTag: '单选题',
          encrypted: true,
          stem: '1. 在操作系统中，死锁发生的四个必要条件不包括下列哪一项？',
          options: [
            { label: 'A', text: '互斥条件 (Mutual Exclusion)' },
            { label: 'B', text: '请求与保持条件 (Hold and Wait)' },
            { label: 'C', text: '可剥夺 / 可抢占条件 (Preemption)' },
            { label: 'D', text: '循环等待条件 (Circular Wait)' },
          ],
          correct: ['C'],
          selected: [],
          blanks: [],
          submitted: false,
        },
        {
          type: 'multiple',
          typeTag: '多选题',
          encrypted: false,
          stem: '2. 下列属于操作系统进程三种基本状态的有哪几项？',
          options: [
            { label: 'A', text: '就绪态 (Ready)' },
            { label: 'B', text: '运行/执行态 (Running)' },
            { label: 'C', text: '阻塞/等待态 (Blocked)' },
            { label: 'D', text: '静态编译态 (Compiled)' },
          ],
          correct: ['A', 'B', 'C'],
          selected: [],
          blanks: [],
          submitted: false,
        },
        {
          type: 'judge',
          typeTag: '判断题',
          encrypted: false,
          stem: '3. 进程是操作系统进行资源分配的基本单位，而线程是 CPU 调度和分派的基本单位。',
          options: [
            { label: '对', text: '正确' },
            { label: '错', text: '错误' },
          ],
          correct: ['对'],
          selected: [],
          blanks: [],
          submitted: false,
        },
        {
          type: 'blank',
          typeTag: '填空题',
          encrypted: false,
          stem: '4. TCP 协议通过 [第1空] 次握手建立连接，通过 [第2空] 次挥手释放连接。（请填写阿拉伯数字）',
          options: [],
          correct: ['3', '4'],
          selected: [],
          blanks: ['', ''],
          submitted: false,
        },
        {
          type: 'subjective',
          typeTag: '主观题',
          encrypted: false,
          stem: '5. 请用一句话简述数据结构中「栈 (Stack)」与「队列 (Queue)」在元素进出顺序上的核心区别。',
          options: [],
          correct: ['栈是后进先出(LIFO)，队列是先进先出(FIFO)'],
          selected: [],
          blanks: [''],
          submitted: false,
        },
      ],
    });

    state.view = initialMode;
    if (initialMode === 'homework') {
      for (const q of state.questions) {
        q.selected = [];
        q.blanks = q.blanks.map(() => '');
        q.submitted = false;
      }
      state.activeQuestionIdx = 0;
    } else if (initialMode === 'directory') {
      state.tasks = { video: false, courseware: false, discuss: false, homework: false };
      for (const q of state.questions) {
        q.selected = [];
        q.blanks = q.blanks.map(() => '');
        q.submitted = false;
      }
      state.activeQuestionIdx = 0;
    }

    let videoTimer = null;
    function stopVideoTimer() {
      if (videoTimer) {
        clearInterval(videoTimer);
        videoTimer = null;
      }
    }

    window.__yktSandboxReturnToDirectory = () => {
      if (!window.__yktSandboxState) return false;
      stopVideoTimer();
      if (state.activeTaskKey) {
        state.tasks[state.activeTaskKey] = true;
        state.activeTaskKey = null;
      }
      if (state.view !== 'directory') {
        state.view = 'directory';
        render();
        return true;
      }
      return false;
    };

    function render() {
      stopVideoTimer();
      document.head.innerHTML = \`
        <meta charset="utf-8" />
        <title>\${
          state.view === 'directory'
            ? '雨课堂 · 模拟课程学习日志'
            : state.view === 'video'
              ? '1.1 操作系统进程调度（模拟视频）'
              : '雨课堂 · 模拟章节作业联调靶场'
        }</title>
        <style>
          body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; background: #f4f6f9; color: #1f2733; }
          .sandbox-banner { background: linear-gradient(90deg, #1b4fd8, #2563eb); color: #fff; padding: 12px 20px; display: flex; justify-content: space-between; align-items: center; }
          .sandbox-banner h1 { margin: 0; font-size: 16px; }
          .sandbox-banner .sub { font-size: 12px; opacity: 0.9; }
          .sandbox-banner button { background: rgba(255,255,255,0.18); color: #fff; border: 1px solid rgba(255,255,255,0.4); border-radius: 6px; padding: 5px 10px; cursor: pointer; margin-left: 8px; }
          .viewContainer { max-width: 860px; margin: 18px auto; padding: 0 16px 40px; }
          .content-box { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px 18px; margin-bottom: 12px; display: flex; flex-direction: column; gap: 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
          .activity__wrap { display: flex; justify-content: space-between; align-items: center; cursor: pointer; padding: 6px 4px; border-radius: 6px; }
          .activity__wrap:hover { background: #f8fafc; }
          .left-row { display: flex; align-items: center; gap: 10px; }
          .tag { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 4px; background: #eff6ff; color: #1d4ed8; font-size: 12px; font-weight: 600; }
          .aside { font-size: 13px; font-weight: 600; padding: 3px 10px; border-radius: 99px; }
          .aside.done { background: #dcfce7; color: #15803d; }
          .aside.todo { background: #fef3c7; color: #b45309; }
          .ppt_img_box .check { display: inline-block; margin-top: 4px; padding: 5px 12px; background: #eff6ff; color: #1d4ed8; border-radius: 6px; font-size: 12px; cursor: pointer; font-weight: 600; }
          .inline-stage { margin-top: 10px; padding: 14px; background: #f8fafc; border-radius: 8px; border: 1px dashed #cbd5e1; }
          .swiper-wrapper { display: flex; gap: 10px; flex-wrap: wrap; }
          .swiper-slide { padding: 18px 20px; background: #fff; border: 2px solid #cbd5e1; border-radius: 8px; cursor: pointer; font-weight: 600; }
          .swiper-slide.read { border-color: #16a34a; background: #f0fdf4; color: #15803d; }
          .hw-shell { max-width: 860px; margin: 18px auto; padding: 0 16px 40px; }
          .order-bar { display: flex; gap: 8px; margin-bottom: 14px; background: #fff; padding: 12px 16px; border-radius: 10px; border: 1px solid #e2e8f0; align-items: center; }
          .subject-item.J_order { width: 34px; height: 34px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; border: 1px solid #cbd5e1; cursor: pointer; font-weight: 600; background: #fff; }
          .subject-item.J_order.active { border-color: #2563eb; background: #2563eb; color: #fff; }
          .subject-item.J_order.done { border-color: #16a34a; background: #dcfce7; color: #15803d; }
          .exercise-item { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 22px 24px; box-shadow: 0 2px 6px rgba(0,0,0,0.04); }
          .q-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
          .q-type { background: #eff6ff; color: #1d4ed8; font-weight: 600; padding: 3px 10px; border-radius: 6px; font-size: 13px; }
          .q-stem { font-size: 16px; font-weight: 600; line-height: 1.6; margin-bottom: 18px; color: #0f172a; }
          ul.opt-ul { list-style: none; padding: 0; margin: 0 0 18px; display: flex; flex-direction: column; gap: 10px; }
          ul.opt-ul li { border: 1px solid #cbd5e1; border-radius: 8px; padding: 11px 14px; cursor: pointer; display: flex; align-items: center; gap: 10px; transition: all 0.12s; background: #fff; }
          ul.opt-ul li.is-checked, ul.opt-ul li.selected { border-color: #2563eb; background: #eff6ff; color: #1e40af; font-weight: 600; }
          ul.opt-ul li.is-disabled { opacity: 0.75; cursor: not-allowed; }
          .blank-row { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
          .el-input__inner, .el-textarea__inner { width: 100%; max-width: 480px; padding: 9px 12px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 14px; }
          .el-button { padding: 8px 20px; border-radius: 6px; border: 1px solid #2563eb; background: #2563eb; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; }
          .el-button.is-disabled { background: #e2e8f0; border-color: #cbd5e1; color: #64748b; cursor: not-allowed; }
          .graded-banner { margin-top: 14px; padding: 10px 14px; border-radius: 8px; background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534; font-weight: 600; }
        </style>
      \`;

      if (state.view === 'directory') {
        try {
          history.replaceState(null, '', '/v2/web/studentLog/sandbox-101');
        } catch {}
        document.body.innerHTML = \`
          <div class="sandbox-banner">
            <div>
              <h1>🎯 雨课堂全流程刷课模拟靶场（V2 学习日志目录）</h1>
              <div class="sub">1:1 还原雨课堂 DOM 结构，无需真实在修课程即可直接点击右侧「🚀 启动自动刷课」测试全流程</div>
            </div>
            <div>
              <button id="btn-jump-hw">直接进入 5 题作业靶场 →</button>
            </div>
          </div>
          <div class="viewContainer">
            <div class="logs-list">
              <div class="content-box">
                <section class="activity__wrap" id="act-video">
                  <div class="left-row">
                    <span class="tag"><svg width="14" height="14"><use xlink:href="#icon-shipin"></use></svg>视频</span>
                    <span class="title">1.1 操作系统进程调度与死锁（模拟视频 6 秒）</span>
                  </div>
                  <div class="statistics-box">
                    <span class="aside \${state.tasks.video ? 'done' : 'todo'}">\${state.tasks.video ? '已完成' : '未完成'}</span>
                  </div>
                </section>
              </div>

              <div class="content-box">
                <section class="activity__wrap" id="act-ppt">
                  <div class="left-row">
                    <span class="tag"><svg width="14" height="14"><use xlink:href="#icon-kejian"></use></svg>课件</span>
                    <span class="title">1.2 虚拟内存与分页机制 PPT（共 4 页）</span>
                  </div>
                  <div class="statistics-box">
                    <span class="aside \${state.tasks.courseware ? 'done' : 'todo'}">\${state.tasks.courseware ? '已读' : '未读'}</span>
                  </div>
                </section>
                <div class="ppt_img_box">
                  <span class="check" id="btn-check-ppt">查看课件</span>
                </div>
                <div id="ppt-inline-holder"></div>
              </div>

              <div class="content-box">
                <section class="activity__wrap">
                  <div class="left-row">
                    <span class="tag"><svg width="14" height="14"><use xlink:href="#icon-piliang"></use></svg>批量</span>
                    <span class="title">1.3 课堂互动章节（含讨论区自动跟评）</span>
                  </div>
                  <div class="statistics-box">
                    <span class="aside \${state.tasks.discuss ? 'done' : 'todo'}">\${state.tasks.discuss ? '1/1' : '0/1'}</span>
                  </div>
                </section>
                <div class="leaf_list__wrap">
                  <div class="activity__wrap" id="act-discuss">
                    <div class="left-row">
                      <span class="tag"><svg width="14" height="14"><use xlink:href="#icon-taolun"></use></svg>讨论</span>
                      <span class="title">讨论：死锁的预防策略有哪些？</span>
                    </div>
                    <div class="statistics-box">
                      <span class="aside \${state.tasks.discuss ? 'done' : 'todo'}">\${state.tasks.discuss ? '已完成' : '未发言'}</span>
                    </div>
                  </div>
                </div>
                <div id="discuss-inline-holder"></div>
              </div>

              <div class="content-box">
                <section class="activity__wrap" id="act-hw">
                  <div class="left-row">
                    <span class="tag"><svg width="14" height="14"><use xlink:href="#icon-zuoye"></use></svg>作业</span>
                    <span class="title">1.4 第一章综合测验（单选/多选/判断/填空/主观 共 5 题）</span>
                  </div>
                  <div class="statistics-box">
                    <span class="aside \${state.tasks.homework ? 'done' : 'todo'}">\${state.tasks.homework ? '已完成' : '未完成'}</span>
                  </div>
                </section>
              </div>
            </div>
          </div>
        \`;

        document.getElementById('btn-jump-hw')?.addEventListener('click', () => {
          state.activeTaskKey = 'homework';
          state.view = 'homework';
          render();
        });
        document.getElementById('act-video')?.addEventListener('click', () => {
          state.activeTaskKey = 'video';
          state.view = 'video';
          render();
        });
        const openPpt = () => {
          state.activeTaskKey = 'courseware';
          const holder = document.getElementById('ppt-inline-holder');
          if (!holder) return;
          holder.innerHTML = \`
            <div class="inline-stage">
              <div style="margin-bottom:8px;font-weight:600;">📊 课件 PPT 预览（脚本将自动逐页点击翻阅）：</div>
              <div class="swiper-wrapper">
                <div class="swiper-slide">第 1 页：地址空间抽象</div>
                <div class="swiper-slide">第 2 页：页表与 TLB 快表</div>
                <div class="swiper-slide">第 3 页：缺页中断处理</div>
                <div class="swiper-slide">第 4 页：LRU 页面置换算法</div>
              </div>
            </div>
          \`;
          holder.querySelectorAll('.swiper-slide').forEach((s) => {
            s.addEventListener('click', () => s.classList.add('read'));
          });
        };
        document.getElementById('act-ppt')?.addEventListener('click', openPpt);
        document.getElementById('btn-check-ppt')?.addEventListener('click', openPpt);

        document.getElementById('act-discuss')?.addEventListener('click', () => {
          state.activeTaskKey = 'discuss';
          const holder = document.getElementById('discuss-inline-holder');
          if (!holder) return;
          holder.innerHTML = \`
            <div class="inline-stage" id="new_discuss">
              <div class="new_discuss_list" style="margin-bottom:10px;">
                <div style="font-size:12px;color:#64748b;">同学热评：</div>
                <div class="cont_detail" style="padding:6px 10px;background:#fff;border-radius:6px;margin-top:4px;">
                  可以通过破坏请求与保持条件、不可剥夺条件或循环等待条件（如资源按序分配法）来预防死锁。
                </div>
              </div>
              <textarea class="el-textarea__inner" rows="2" placeholder="输入讨论内容..."></textarea>
              <div style="margin-top:8px;">
                <button class="el-button submitComment" type="button">发表评论</button>
              </div>
            </div>
          \`;
        });

        document.getElementById('act-hw')?.addEventListener('click', () => {
          state.activeTaskKey = 'homework';
          state.view = 'homework';
          render();
        });
        return;
      }

      if (state.view === 'video') {
        try {
          history.replaceState(null, '', '/ai-workspace/lms-graph/sandbox-101/video/1001');
        } catch {}
        document.body.innerHTML = \`
          <div class="sandbox-banner">
            <div>
              <h1>🎬 1.1 操作系统进程调度与死锁（模拟视频播放页）</h1>
              <div class="sub">支持自动静音、倍速控制 (1x~4x)、防暂停检测与完成度回传</div>
            </div>
            <div>
              <button id="btn-back-dir">← 返回课程目录</button>
            </div>
          </div>
          <div class="hw-shell">
            <div class="exercise-item">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                <strong>正在播放课程视频</strong>
                <div class="progress-wrap"><span class="text" id="vid-progress">学习进度：0%</span></div>
              </div>
              <canvas id="vid-canvas" width="640" height="220" style="display:none;"></canvas>
              <video id="sandbox-video" controls autoplay muted style="width:100%;max-height:260px;background:#0f172a;border-radius:8px;"></video>
            </div>
          </div>
        \`;
        document.getElementById('btn-back-dir')?.addEventListener('click', () => {
          window.__yktSandboxReturnToDirectory();
        });
        const canvas = document.getElementById('vid-canvas');
        const video = document.getElementById('sandbox-video');
        const progText = document.getElementById('vid-progress');
        if (canvas instanceof HTMLCanvasElement && video instanceof HTMLVideoElement) {
          const ctx = canvas.getContext('2d');
          try {
            const stream = canvas.captureStream(15);
            video.srcObject = stream;
            video.play().catch(() => {});
          } catch {}
          let elapsed = 0;
          const totalSec = 6;
          videoTimer = setInterval(() => {
            const rate = video.playbackRate || 1;
            if (!video.paused) {
              elapsed = Math.min(totalSec, elapsed + 0.25 * rate);
            }
            const pct = Math.min(100, Math.round((elapsed / totalSec) * 100));
            if (ctx) {
              ctx.fillStyle = '#0f172a';
              ctx.fillRect(0, 0, canvas.width, canvas.height);
              ctx.fillStyle = '#38bdf8';
              ctx.font = 'bold 22px sans-serif';
              ctx.fillText('雨课堂模拟视频流 · 倍速 ' + rate + 'x', 28, 80);
              ctx.fillStyle = '#22c55e';
              ctx.fillRect(28, 120, ((canvas.width - 56) * pct) / 100, 24);
              ctx.fillStyle = '#ffffff';
              ctx.font = '16px sans-serif';
              ctx.fillText('播放进度：' + pct + '%', 28, 175);
            }
            if (progText) {
              progText.textContent = pct >= 100 ? '已完成 (100%)' : '学习进度：' + pct + '%';
            }
            if (pct >= 100) {
              stopVideoTimer();
            }
          }, 250);
        }
        return;
      }

      // Homework view
      try {
        history.replaceState(null, '', '/v2/web/studentCards/sandbox-101/homework-1');
      } catch {}
      const q = state.questions[state.activeQuestionIdx] || state.questions[0];
      const hasAnyInput =
        q.options.length > 0
          ? q.selected.length > 0
          : q.blanks.some((b) => b && b.trim().length > 0);
      const canSubmitNow = !q.submitted && hasAnyInput;

      document.body.innerHTML = \`
        <div class="sandbox-banner">
          <div>
            <h1>📝 雨课堂作业 AI 自动作答联调靶场（共 5 题全题型）</h1>
            <div class="sub">涵盖：单选题（含加密字体标识 + 未选前提交按钮默认禁用）、多选题（防双击反选）、判断题、多空填空题、主观简答题</div>
          </div>
          <div>
            <button id="btn-reset-hw">重置全部题目</button>
            <button id="btn-to-dir">切换至课程目录靶场</button>
          </div>
        </div>
        <div class="hw-shell">
          <div class="order-bar">
            <span style="font-size:13px;color:#64748b;margin-right:6px;">题号导航：</span>
            \${state.questions
              .map(
                (item, idx) => \`
              <div class="subject-item J_order \${idx === state.activeQuestionIdx ? 'active' : ''} \${item.submitted ? 'done' : ''}" data-q-idx="\${idx}">
                \${idx + 1}
              </div>
            \`,
              )
              .join('')}
          </div>

          <div class="exercise-item">
            <div class="q-header">
              <span class="q-type">\${q.typeTag}</span>
              <span style="font-size:12px;color:#64748b;">
                第 \${state.activeQuestionIdx + 1} / \${state.questions.length} 题
                \${q.encrypted ? ' · <span class="xuetangx-com-encrypted-font" style="color:#d97706;">[已启用 xuetangx 加密字体特征]</span>' : ''}
              </span>
            </div>

            <div class="q-stem \${q.encrypted ? 'xuetangx-com-encrypted-font' : ''}">\${q.stem}</div>

            \${
              q.options.length > 0
                ? \`<ul class="opt-ul">
                \${q.options
                  .map((opt) => {
                    const checked = q.selected.includes(opt.label);
                    const controlClass = q.type === 'multiple' ? 'el-checkbox' : 'el-radio';
                    return \`
                      <li class="\${checked ? 'is-checked selected' : ''} \${q.submitted ? 'is-disabled' : ''}" data-opt="\${opt.label}">
                        <label class="\${controlClass} \${checked ? 'is-checked' : ''} \${q.submitted ? 'is-disabled' : ''}">
                          <span class="\${controlClass}__input \${checked ? 'is-checked' : ''}"></span>
                          <span class="\${controlClass}__label"><strong>\${opt.label}.</strong> \${opt.text}</span>
                        </label>
                      </li>
                    \`;
                  })
                  .join('')}
              </ul>\`
                : ''
            }

            \${
              q.type === 'blank'
                ? q.blanks
                    .map(
                      (val, bIdx) => \`
                  <div class="blank-row">
                    <span>第 \${bIdx + 1} 空：</span>
                    <input type="text" class="el-input__inner" data-b-idx="\${bIdx}" value="\${val}" \${q.submitted ? 'disabled' : ''} placeholder="请输入第 \${bIdx + 1} 空答案" />
                  </div>
                \`,
                    )
                    .join('')
                : ''
            }

            \${
              q.type === 'subjective'
                ? \`
                <div class="blank-row">
                  <textarea class="el-textarea__inner" rows="3" data-b-idx="0" \${q.submitted ? 'disabled' : ''} placeholder="请输入主观题作答内容...">\${q.blanks[0] || ''}</textarea>
                </div>
              \`
                : ''
            }

            <div style="margin-top:18px;display:flex;align-items:center;gap:12px;">
              <button
                type="button"
                id="hw-submit-btn"
                class="el-button \${canSubmitNow ? 'el-button--primary' : 'el-button--info is-disabled is-plain'}"
                \${canSubmitNow ? '' : 'disabled'}
              >提交</button>
              <span style="font-size:12px;color:#64748b;">
                \${
                  q.submitted
                    ? '✅ 本题已提交'
                    : canSubmitNow
                      ? '已选择/填写答案，可点击提交'
                      : '（未选选项前提交按钮处于 is-disabled 状态，测试脚本不会误判跳过）'
                }
              </span>
            </div>

            \${
              q.submitted
                ? \`<div class="graded-banner">
                已提交 · 我的答案：【\${q.options.length > 0 ? q.selected.join(', ') : q.blanks.join(' | ')}】 · 参考标准答案：【\${q.correct.join(', ')}】
              </div>\`
                : ''
            }
          </div>
        </div>
      \`;

      document.getElementById('btn-reset-hw')?.addEventListener('click', () => {
        for (const item of state.questions) {
          item.selected = [];
          item.blanks = item.blanks.map(() => '');
          item.submitted = false;
        }
        state.activeQuestionIdx = 0;
        render();
      });

      document.getElementById('btn-to-dir')?.addEventListener('click', () => {
        state.view = 'directory';
        render();
      });

      document.querySelectorAll('.subject-item.J_order').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.getAttribute('data-q-idx'));
          if (Number.isFinite(idx)) {
            state.activeQuestionIdx = idx;
            render();
          }
        });
      });

      document.querySelectorAll('ul.opt-ul li').forEach((li) => {
        li.addEventListener('click', (e) => {
          e.stopPropagation();
          if (q.submitted) return;
          const label = li.getAttribute('data-opt');
          if (!label) return;
          if (q.type === 'multiple') {
            if (q.selected.includes(label)) {
              q.selected = q.selected.filter((x) => x !== label);
            } else {
              q.selected = [...q.selected, label].sort();
            }
          } else {
            q.selected = [label];
          }
          render();
        });
      });

      document.querySelectorAll('input.el-input__inner, textarea.el-textarea__inner').forEach((inp) => {
        const updateVal = () => {
          if (q.submitted) return;
          const bIdx = Number(inp.getAttribute('data-b-idx') || 0);
          q.blanks[bIdx] = inp.value;
          const submitBtn = document.getElementById('hw-submit-btn');
          const anyFilled = q.blanks.some((b) => b && b.trim().length > 0);
          if (submitBtn) {
            if (anyFilled) {
              submitBtn.removeAttribute('disabled');
              submitBtn.className = 'el-button el-button--primary';
            } else {
              submitBtn.setAttribute('disabled', 'true');
              submitBtn.className = 'el-button el-button--info is-disabled is-plain';
            }
          }
        };
        inp.addEventListener('input', updateVal);
        inp.addEventListener('change', updateVal);
      });

      document.getElementById('hw-submit-btn')?.addEventListener('click', () => {
        if (q.submitted) return;
        const ready =
          q.options.length > 0
            ? q.selected.length > 0
            : q.blanks.some((b) => b && b.trim().length > 0);
        if (!ready) return;
        q.submitted = true;
        render();
      });
    }

    render();
    return true;
  })()`;
}




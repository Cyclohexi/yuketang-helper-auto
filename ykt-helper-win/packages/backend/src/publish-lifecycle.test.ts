import { BrowserEnvironment, type ClassroomNotice } from '@ykt/contracts';
import { BrowserLessonCollector, YuketangActiveClient } from '@ykt/routing';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { createBackendRuntime } from './runtime.js';

describe('classroom publish lifecycle', () => {
  it.each([false, true])(
    'enforces the automatic forced-retry switch=%s before using the retry endpoint',
    async (enabled) => {
      const fixture = await createFixture();
      await fixture.loadPresentation();
      const session = fixture.runtime.lessons.getSession('7')!;
      session.unlockProblem(
        '11',
        '9',
        'slide-11',
        Date.now() - 4000,
        Date.now() - 1000,
        Date.now() - 4000,
      );
      await fixture.runtime.dataStore.updateSettings({
        llmAutoGenerate: true,
        llmManagedSubmit: true,
        autoForceRetryEnabled: enabled,
      });
      const submit = vi
        .spyOn(fixture.activeClient, 'submit')
        .mockResolvedValue(undefined);
      const result = fixture.runtime.activeLessons!.submitAnswer({
        problemId: '11',
        answer: ['A'],
        confirmedBy: 'agent',
        forceRetry: true,
      });
      if (enabled) {
        await expect(result).resolves.toMatchObject({
          status: 'submitted',
          route: 'retry',
        });
        expect(submit).toHaveBeenCalledWith(
          BrowserEnvironment.Standard,
          '7',
          expect.objectContaining({ route: 'retry' }),
        );
      } else {
        await expect(result).rejects.toThrow('自动强制补交未开启');
        expect(submit).not.toHaveBeenCalled();
      }
    },
  );

  it('also blocks implicit expired retries when automatic forced retry is off', async () => {
    const fixture = await createFixture();
    await fixture.loadPresentation();
    fixture.runtime.lessons
      .getSession('7')!
      .unlockProblem(
        '11',
        '9',
        'slide-11',
        Date.now() - 4000,
        Date.now() - 1000,
        Date.now() - 4000,
      );
    await fixture.runtime.dataStore.updateSettings({
      llmAutoGenerate: true,
      llmManagedSubmit: true,
      autoForceRetryEnabled: false,
    });
    const submit = vi.spyOn(fixture.activeClient, 'submit');
    await expect(
      fixture.runtime.activeLessons!.submitAnswer({
        problemId: '11',
        answer: ['A'],
        confirmedBy: 'agent',
      }),
    ).rejects.toThrow('自动强制补交未开启');
    expect(submit).not.toHaveBeenCalled();
  });

  it('announces lesson start once across repeated connections', async () => {
    const fixture = await createFixture();
    await fixture.runtime.facade.connectLesson(
      BrowserEnvironment.Standard,
      '7',
    );
    expect(
      fixture.notices.filter((notice) => notice.kind === 'lesson-started'),
    ).toHaveLength(1);
  });

  it('does not submit a loaded locked question through the agent', async () => {
    const fixture = await createFixture();
    await fixture.loadPresentation();
    expect((await fixture.runtime.facade.listProblems('7'))[0]?.status).toBe(
      'locked',
    );
    await expect(
      fixture.runtime.activeLessons!.submitAnswer({
        problemId: '11',
        answer: ['A'],
        confirmedBy: 'agent',
      }),
    ).rejects.toThrow('题目尚未发布');
  });

  it('discards pending publishes when the lesson ends before the presentation loads', async () => {
    const fixture = await createFixture();
    await fixture.publish('11');
    await fixture.finish();
    const noticesAtFinish = [...fixture.notices];

    await fixture.loadPresentation();

    expect(fixture.notices).toEqual(noticesAtFinish);
    expect(fixture.notices.at(-1)?.kind).toBe('lesson-finished');
    expect(fixture.runtime.lessons.getSession('7')?.lesson.status).toBe(
      'ended',
    );
    expect(await fixture.runtime.facade.listProblems('7')).toEqual([]);
  });

  it.each(['before', 'after'] as const)(
    'ignores late publishes received %s the presentation loads in an ended lesson',
    async (arrival) => {
      const fixture = await createFixture();
      await fixture.finish();
      const noticesAtFinish = [...fixture.notices];

      if (arrival === 'before') await fixture.publish('11');
      await fixture.loadPresentation();
      if (arrival === 'after') await fixture.publish('11');

      expect(fixture.notices).toEqual(noticesAtFinish);
      expect(await fixture.runtime.facade.listProblems('7')).toHaveLength(0);
    },
  );

  it('keeps already collected history after leaving a finished lesson', async () => {
    const fixture = await createFixture();
    await fixture.loadPresentation();
    await fixture.finish();

    expect(await fixture.runtime.facade.listProblems('7')).toHaveLength(2);
    expect(fixture.notices.at(-1)?.kind).toBe('lesson-finished');
  });

  it('stops an in-progress replay when the lesson ends between publishes', async () => {
    const fixture = await createFixture();
    await fixture.publish('11');
    await fixture.publish('12');
    const storage = fixture.runtime.dataStore;
    const appendLog = storage.appendLog.bind(storage);
    vi.spyOn(storage, 'appendLog').mockImplementation(async (entry) => {
      await appendLog(entry);
      if (
        entry.message === '已应用题目发布事件到状态机。' &&
        entry.details?.problemId === '11'
      ) {
        await fixture.finish();
      }
    });

    await fixture.loadPresentation();

    expect(fixture.notices.map((notice) => notice.kind)).toEqual([
      'lesson-started',
      'assessment-publish',
      'assessment-publish',
      'problem-start',
      'lesson-finished',
    ]);
    expect(await fixture.runtime.facade.listProblems('7')).toHaveLength(2);
  });
});

async function createFixture() {
  const notices: ClassroomNotice[] = [];
  const collector = new BrowserLessonCollector();
  const activeClient = new YuketangActiveClient({
    credentials: {
      load: async () => ({
        cookieHeader: 'session=fixture',
        bearerToken: null,
        userId: '42',
      }),
    },
    transport: {
      request: async () => ({
        status: 200,
        headers: {},
        body: {
          data: {
            onLessonClassrooms: [
              {
                lessonId: 7,
                classroomId: 8,
                presentationId: 9,
                title: 'Active lesson',
                status: 1,
              },
            ],
          },
        },
      }),
    },
    browserCollector: collector,
    socketFactory: () => {
      throw new Error('Browser collection must not create a classroom socket.');
    },
  });
  const runtime = createBackendRuntime({
    activeClient,
    onClassroomNotice: (notice) => notices.push(notice),
  });
  await runtime.start();
  onTestFinished(() => runtime.stop());
  await runtime.facade.refreshLessons(BrowserEnvironment.Standard);
  await runtime.facade.connectLesson(BrowserEnvironment.Standard, '7');
  await collector.observeWebSocket({
    requestId: 'browser-ws',
    direction: 'sent',
    payload: JSON.stringify({ op: 'hello', lessonid: 7 }),
  });

  const receive = (message: Record<string, unknown>) =>
    collector.observeWebSocket({
      requestId: 'browser-ws',
      direction: 'received',
      payload: JSON.stringify(message),
    });

  return {
    runtime,
    activeClient,
    notices,
    publish: (problemId: string) =>
      receive({ op: 'probleminfo', problemid: problemId }),
    finish: () => receive({ op: 'lessonfinished' }),
    loadPresentation: () =>
      collector.observeHttp({
        url: 'https://www.yuketang.cn/api/v3/lesson/presentation/fetch?presentation_id=9',
        statusCode: 200,
        body: JSON.stringify({
          data: {
            id: 9,
            title: 'Presentation',
            slides: ['11', '12'].map((problemId) => ({
              id: `slide-${problemId}`,
              problem: {
                problemId,
                problemType: 1,
                content: `Question ${problemId}`,
                options: ['One', 'Two'],
              },
            })),
          },
        }),
      }),
  };
}

import { describe, expect, it, vi } from 'vitest';
import {
  ProblemType,
  type AnswerProposal,
  type ProblemContext,
} from '@ykt/contracts';
import {
  ClassroomPreanalysis,
  type PreanalysisQuestion,
} from '../../apps/desktop/renderer/src/classroom-preanalysis';

describe('loaded classroom question preanalysis', () => {
  it('analyzes locked questions once and reuses the result after publication', async () => {
    const fixture = queue();
    const question = questionFor('1');
    await fixture.analysis.sync('lesson:model', [question]);
    await fixture.analysis.sync('lesson:model', [
      {
        ...question,
        problem: { ...question.problem, status: 'available', unlockedAt: 1000 },
      },
    ]);
    expect(fixture.analyze).toHaveBeenCalledOnce();
    expect(await fixture.analysis.result('1')).toMatchObject({
      status: 'ready',
    });
    expect(fixture.finished).toHaveBeenCalledWith(
      expect.objectContaining({ total: 1, succeeded: 1, failed: 0 }),
    );
  });

  it('bounds concurrent requests and deduplicates polls while reporting partial failures', async () => {
    const fixture = queue();
    const pending = deferred<AnswerProposal>();
    let active = 0;
    let peak = 0;
    fixture.analyze.mockImplementation(async ({ problem }) => {
      active++;
      peak = Math.max(active, peak);
      await pending.promise;
      active--;
      if (problem.id === '2') throw new Error('provider unavailable');
      return proposalFor(problem.id);
    });
    const questions = ['1', '2', '3'].map(questionFor);
    const first = fixture.analysis.sync('lesson:model', questions);
    await vi.waitFor(() => expect(fixture.analyze).toHaveBeenCalledTimes(2));
    await fixture.analysis.sync('lesson:model', questions);
    expect(fixture.analyze).toHaveBeenCalledTimes(2);
    pending.resolve(proposalFor('1'));
    await first;
    expect(peak).toBe(2);
    expect(fixture.analyze).toHaveBeenCalledTimes(3);
    expect(fixture.started).toHaveBeenCalledWith(
      expect.objectContaining({ total: 3 }),
    );
    expect(fixture.finished).toHaveBeenCalledWith(
      expect.objectContaining({ total: 3, succeeded: 2, failed: 1 }),
    );
    await fixture.analysis.sync('lesson:model', questions);
    expect(fixture.analyze).toHaveBeenCalledTimes(3);
  });

  it('reanalyzes changed content or slide images and counts an obsolete job as failed', async () => {
    const fixture = queue();
    const pending = deferred<AnswerProposal>();
    fixture.analyze.mockImplementationOnce(() => pending.promise);
    const old = questionFor('1');
    const first = fixture.analysis.sync('lesson:model', [old]);
    await vi.waitFor(() => expect(fixture.analyze).toHaveBeenCalledOnce());
    const oldResult = fixture.analysis.result('1');
    const next = fixture.analysis.sync('lesson:model', [
      { ...old, imageUrls: ['https://example.test/replaced.png'] },
    ]);
    expect(await oldResult).toBeUndefined();
    pending.resolve(proposalFor('1'));
    await Promise.all([first, next]);
    expect(
      fixture.finished.mock.calls.map(([batch]) => [
        batch.total,
        batch.succeeded,
        batch.failed,
      ]),
    ).toEqual([
      [1, 0, 1],
      [1, 1, 0],
    ]);
    expect(fixture.analyze).toHaveBeenCalledTimes(2);
    const ready = await fixture.analysis.result('1');
    expect(fixture.analysis.isCurrent('1', ready!)).toBe(true);
  });

  it('discards old results and completion notices when a lesson or model changes', async () => {
    const fixture = queue();
    const pending = deferred<AnswerProposal>();
    fixture.analyze.mockImplementationOnce(() => pending.promise);
    const first = fixture.analysis.sync('lesson:model-a', [questionFor('1')]);
    await vi.waitFor(() => expect(fixture.analyze).toHaveBeenCalledOnce());
    const oldResult = fixture.analysis.result('1');
    const next = fixture.analysis.sync('lesson:model-b', [questionFor('2')]);
    expect(await oldResult).toBeUndefined();
    pending.resolve(proposalFor('1'));
    await Promise.all([first, next]);
    expect(fixture.analysis.result('1')).toBeUndefined();
    expect(fixture.finished).toHaveBeenCalledOnce();
    expect(fixture.finished).toHaveBeenCalledWith(
      expect.objectContaining({ succeeded: 1, failed: 0 }),
    );
  });

  it('supports explicit retry of a failed question without analyzing answered questions', async () => {
    const fixture = queue();
    fixture.analyze.mockResolvedValueOnce(undefined);
    const question = questionFor('1');
    await fixture.analysis.sync('lesson:model', [
      question,
      {
        ...questionFor('2'),
        problem: { ...questionFor('2').problem, status: 'answered' },
      },
    ]);
    expect(fixture.analyze).toHaveBeenCalledOnce();
    expect(await fixture.analysis.result('1')).toBeUndefined();
    fixture.analysis.invalidate('1');
    await fixture.analysis.sync('lesson:model', [question]);
    expect(await fixture.analysis.result('1')).toMatchObject({
      status: 'ready',
    });
  });
});

function queue() {
  const analyze = vi.fn(
    async ({
      problem,
    }: PreanalysisQuestion): Promise<AnswerProposal | undefined> =>
      proposalFor(problem.id),
  );
  const started = vi.fn(async () => {});
  const finished = vi.fn(
    async (_batch: { total: number; succeeded: number; failed: number }) => {},
  );
  return {
    analyze,
    started,
    finished,
    analysis: new ClassroomPreanalysis({ analyze, started, finished }),
  };
}

function questionFor(id: string): PreanalysisQuestion {
  return {
    problem: {
      id,
      lessonId: 'lesson',
      presentationId: 'presentation',
      slideId: `slide-${id}`,
      type: ProblemType.SingleChoice,
      prompt: `Question ${id}`,
      options: ['One', 'Two'],
      blanks: [],
      result: null,
      status: 'locked',
      unlockedAt: null,
      deadlineAt: null,
    } satisfies ProblemContext,
    imageUrls: [`https://example.test/${id}.png`],
  };
}

function proposalFor(problemId: string): AnswerProposal {
  return {
    id: `proposal-${problemId}`,
    sessionId: 'session',
    problemId,
    status: 'ready',
    answer: ['A'],
    explanation: 'One',
    confidence: 0.8,
    failureReason: null,
    validationIssues: [],
    rawText: 'A',
    profileId: 'model',
    model: 'test',
    contextSources: [],
    createdAt: new Date().toISOString(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

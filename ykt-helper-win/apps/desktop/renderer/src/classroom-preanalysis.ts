import type { AnswerProposal, ProblemContext } from '@ykt/contracts';

export interface PreanalysisQuestion {
  readonly problem: ProblemContext;
  readonly imageUrls: readonly string[];
}

export interface PreanalysisBatch {
  readonly id: number;
  readonly lessonId: string;
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
}

interface AnalysisJob {
  question: PreanalysisQuestion;
  fingerprint: string;
  result: Promise<AnswerProposal | undefined>;
  resolve: (proposal: AnswerProposal | undefined) => void;
  proposal?: AnswerProposal;
}

/** Analyse loaded questions independently of their publication/submission. */
export class ClassroomPreanalysis {
  private context = '';
  private revision = 0;
  private nextBatchId = 1;
  private readonly jobs = new Map<string, AnalysisJob>();
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: {
      analyze: (
        question: PreanalysisQuestion,
        isCurrent: () => boolean,
      ) => Promise<AnswerProposal | undefined>;
      started: (batch: PreanalysisBatch) => Promise<void>;
      finished: (batch: PreanalysisBatch) => Promise<void>;
    },
  ) {}

  reset(): void {
    this.revision++;
    this.context = '';
    for (const job of this.jobs.values()) job.resolve(undefined);
    this.jobs.clear();
  }

  result(problemId: string): Promise<AnswerProposal | undefined> | undefined {
    return this.jobs.get(problemId)?.result;
  }

  isCurrent(problemId: string, proposal: AnswerProposal): boolean {
    return this.jobs.get(problemId)?.proposal === proposal;
  }

  invalidate(problemId: string): void {
    this.jobs.get(problemId)?.resolve(undefined);
    this.jobs.delete(problemId);
  }

  sync(
    context: string,
    questions: readonly PreanalysisQuestion[],
  ): Promise<void> {
    if (this.context !== context) {
      this.reset();
      this.context = context;
    }
    const revision = this.revision;
    const pending: AnalysisJob[] = [];
    const currentIds = new Set(questions.map(({ problem }) => problem.id));
    for (const [id, job] of this.jobs) {
      if (!currentIds.has(id)) {
        job.resolve(undefined);
        this.jobs.delete(id);
      }
    }
    for (const question of questions) {
      const { problem, imageUrls } = question;
      if (problem.status !== 'locked' && problem.status !== 'available')
        continue;
      const fingerprint = JSON.stringify([
        problem.type,
        problem.prompt,
        problem.options,
        problem.blanks,
        problem.presentationId,
        problem.slideId,
        imageUrls,
      ]);
      const previous = this.jobs.get(problem.id);
      if (previous?.fingerprint === fingerprint) continue;
      previous?.resolve(undefined);
      let resolve!: AnalysisJob['resolve'];
      const result = new Promise<AnswerProposal | undefined>((done) => {
        resolve = done;
      });
      const job = { question, fingerprint, result, resolve };
      this.jobs.set(problem.id, job);
      pending.push(job);
    }
    if (!pending.length) return Promise.resolve();
    const batch = {
      id: this.nextBatchId++,
      lessonId: pending[0]!.question.problem.lessonId,
      total: pending.length,
      succeeded: 0,
      failed: 0,
    };
    const execute = async () => {
      if (revision !== this.revision) return;
      await this.options.started(batch).catch(() => {});
      let cursor = 0;
      const worker = async () => {
        while (cursor < pending.length && revision === this.revision) {
          const job = pending[cursor++]!;
          if (this.jobs.get(job.question.problem.id) !== job) {
            batch.failed++;
            continue;
          }
          let proposal: AnswerProposal | undefined;
          try {
            proposal = await this.options.analyze(
              job.question,
              () =>
                revision === this.revision &&
                this.jobs.get(job.question.problem.id) === job,
            );
          } catch {
            /* A failed question must not prevent the rest of the batch. */
          }
          if (
            revision !== this.revision ||
            this.jobs.get(job.question.problem.id) !== job
          ) {
            job.resolve(undefined);
            batch.failed++;
            continue;
          }
          if (proposal) job.proposal = proposal;
          if (proposal?.status === 'ready' && proposal.answer)
            batch.succeeded++;
          else batch.failed++;
          job.resolve(proposal);
        }
      };
      // Limit provider requests; a poll or another presentation cannot duplicate
      // an in-flight job. Publication status is deliberately not a cache key.
      await Promise.all([worker(), worker()]);
      if (revision === this.revision)
        await this.options.finished(batch).catch(() => {});
    };
    const task = this.tail.then(execute);
    this.tail = task.catch(() => {});
    return task;
  }
}

import { describe, expect, it } from 'vitest';

import { getRealtimeEvent } from './services/classroom-events.js';

describe('classroom realtime events', () => {
  it('retains lesson start/end and assessment events while discarding other publishes', () => {
    expect(getRealtimeEvent({ op: 'lessonStarted' })).toEqual({
      kind: 'lessonstarted',
    });
    expect(getRealtimeEvent({ op: 'lessonfinished' })).toEqual({
      kind: 'lessonfinished',
    });
    expect(
      getRealtimeEvent({ op: 'publishquiz', quiz: { id: 'quiz-1' } }),
    ).toMatchObject({
      kind: 'publish',
      notice: { kind: 'assessment-publish' },
    });
    expect(getRealtimeEvent({ op: 'publishactivity' })).toBeNull();
  });

  it('normalizes object and scalar problem publish messages', () => {
    expect(
      getRealtimeEvent({
        op: 'unlockproblem',
        problem: { problemId: 11, pres: 9 },
      }),
    ).toMatchObject({
      kind: 'unlockproblem',
      problem: { problemId: 11, pres: 9 },
    });
    expect(
      getRealtimeEvent({
        op: 'unlockproblem',
        problem: 12,
        pres: 9,
        sid: 10,
        limit: 60,
      }),
    ).toMatchObject({
      kind: 'unlockproblem',
      problem: { prob: 12, pres: 9, sid: 10, limit: 60 },
    });
  });

  it('reports courseware publication but ignores display and page events', () => {
    expect(
      getRealtimeEvent({
        op: 'publishpresentation',
        presentation: { id: 7, title: '新课件' },
      }),
    ).toMatchObject({
      kind: 'publish',
      notice: { kind: 'courseware-publish', detail: '新课件' },
    });
    expect(
      getRealtimeEvent({ op: 'presentationdisplay', presentation: 7 }),
    ).toBeNull();
    expect(getRealtimeEvent({ op: 'slidechanged', slide: 2 })).toBeNull();
  });
});

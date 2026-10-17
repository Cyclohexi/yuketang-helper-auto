import { BrowserEnvironment } from '@ykt/contracts';
import { describe, expect, it } from 'vitest';

import { YuketangActiveClient } from './active/client.js';
import { hostAdapterFor, normalizeTimestamp } from './active/host-adapter.js';
import { BrowserLessonCollector } from './active/browser-lesson-collector.js';
import { FetchHttpTransport } from './active/http-transport.js';
import {
  LessonWebSocketManager,
  type LessonSocket,
} from './active/lesson-websocket.js';
import { SessionManager } from './active/session-manager.js';
import { NetworkRecorder } from './recorder.js';

describe('M4 active routing', () => {
  it('uses one fixed adapter per environment and normalizes timestamps', () => {
    expect(hostAdapterFor(BrowserEnvironment.Standard).checkinUrl).toBe(
      'https://www.yuketang.cn/api/v3/lesson/checkin',
    );
    expect(hostAdapterFor(BrowserEnvironment.Pro).webSocketUrl).toBe(
      'wss://pro.yuketang.cn/wsapp/',
    );
    expect(hostAdapterFor(BrowserEnvironment.Changjiang).origin).toBe(
      'https://changjiang.yuketang.cn',
    );
    expect(
      hostAdapterFor(BrowserEnvironment.Standard).answerUrl.endsWith(
        '/api/v3/lesson/problem/answer',
      ),
    ).toBe(true);
    expect(
      hostAdapterFor(BrowserEnvironment.Standard).retryUrl.endsWith(
        '/api/v3/lesson/problem/retry',
      ),
    ).toBe(true);
    expect(
      hostAdapterFor(BrowserEnvironment.Standard).parseLessons({
        result: [{ lesson_id: 8, status: '1' }],
      }),
    ).toMatchObject([{ id: '8', status: 'active' }]);
    expect(
      hostAdapterFor(BrowserEnvironment.Standard).parseUser({
        data: { user_info: { user_id: 42, name: 'Student' } },
      }),
    ).toEqual({ id: '42', name: 'Student' });
    expect(normalizeTimestamp(1_700_000_000)).toBe(1_700_000_000_000);
    expect(normalizeTimestamp(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(
      hostAdapterFor(BrowserEnvironment.Standard).parseCheckin(
        { data: { lessonToken: 'token', expiresIn: 2 } },
        1000,
      ).expiresAt,
    ).toBe(3000);
  });

  it('treats entries from the on-lesson endpoint as active without a status field', () => {
    expect(
      hostAdapterFor(BrowserEnvironment.Pro).parseLessons({
        data: {
          onLessonClassrooms: [{ lessonId: 'lesson-without-status' }],
        },
      }),
    ).toMatchObject([{ id: 'lesson-without-status', status: 'active' }]);
  });

  it('manages browser credentials, Set-Auth and lesson token expiry', async () => {
    let now = 1000;
    const savedTokens: (string | null)[] = [];
    const sessions = new SessionManager(
      {
        load: async () => ({
          cookieHeader: 'session=abc',
          bearerToken: 'browser-token',
          userId: '42',
        }),
        saveBearerToken: async (_environment, value) => {
          savedTokens.push(value);
        },
      },
      () => now,
    );
    expect(await sessions.headers(BrowserEnvironment.Standard)).toMatchObject({
      cookie: 'session=abc',
      authorization: 'Bearer browser-token',
    });
    await sessions.captureResponse(BrowserEnvironment.Standard, {
      status: 200,
      headers: { 'Set-Auth': 'fresh-token' },
      body: {},
    });
    expect(savedTokens).toEqual(['fresh-token']);
    sessions.setLessonToken(BrowserEnvironment.Standard, 'lesson-1', {
      lessonToken: 'lesson-token',
      expiresAt: 2000,
    });
    expect(
      await sessions.headers(BrowserEnvironment.Standard, 'lesson-1'),
    ).toMatchObject({
      authorization: 'Bearer fresh-token',
      'lesson-token': 'lesson-token',
    });
    now = 2000;
    expect(sessions.lessonToken('lesson-1')).toBeNull();
    await sessions.captureResponse(BrowserEnvironment.Standard, {
      status: 401,
      headers: {},
      body: {},
    });
    expect(savedTokens).toEqual(['fresh-token', null]);
  });

  it('adopts updated browser localStorage bearer tokens and sends source=5 on checkin', async () => {
    let browserToken = 'old-lesson-jwt';
    const sessions = new SessionManager({
      load: async () => ({
        cookieHeader: 'sessionid=123',
        bearerToken: browserToken,
        userId: '42',
      }),
    });
    expect(await sessions.headers(BrowserEnvironment.Changjiang)).toMatchObject({
      authorization: 'Bearer old-lesson-jwt',
    });

    browserToken = 'new-lesson-jwt';
    expect(await sessions.headers(BrowserEnvironment.Changjiang)).toMatchObject({
      authorization: 'Bearer new-lesson-jwt',
    });

    const requests: { url: string; body: string | null; headers: Readonly<Record<string, string>> }[] = [];
    const client = new YuketangActiveClient({
      credentials: {
        load: async () => ({
          cookieHeader: 'sessionid=123',
          bearerToken: browserToken,
          userId: '42',
        }),
      },
      transport: {
        request: async (req) => {
          requests.push({ url: req.url, body: req.body, headers: req.headers });
          return {
            status: 200,
            headers: { 'set-auth': 'refreshed-lesson-jwt' },
            body: { code: 0, data: { lessonToken: 'refreshed-lesson-jwt' } },
          };
        },
      },
    });

    await client.checkin(BrowserEnvironment.Changjiang, 'lesson-new', 'classroom-1');
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({
      source: 5,
      lessonId: 'lesson-new',
    });
  });

  it('reconnects while deduplicating messages across sockets', () => {
    const sockets: FakeSocket[] = [];
    let reconnect: (() => void) | undefined;
    const received: unknown[] = [];
    const manager = new LessonWebSocketManager(
      () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      undefined,
      {
        setTimeout: (callback) => {
          reconnect = callback;
          return callback;
        },
        clearTimeout: () => undefined,
      },
      10,
    );
    manager.connect({
      environment: BrowserEnvironment.Standard,
      lessonId: 'lesson-1',
      lessonToken: 'token',
      userId: '42',
      onMessage: (message) => received.push(message),
    });
    sockets[0]?.open();
    expect(JSON.parse(sockets[0]?.sent[0] ?? '{}')).toMatchObject({
      op: 'hello',
      lessonid: 'lesson-1',
      auth: 'token',
    });

    sockets[0]?.message('{"eventId":"event-1","op":"unlockproblem"}');
    sockets[0]?.message('{"eventId":"event-1","op":"unlockproblem"}');
    sockets[0]?.serverClose();
    reconnect?.();
    sockets[1]?.message('{"eventId":"event-1","op":"unlockproblem"}');
    sockets[1]?.message('{"eventId":"event-2","op":"lessonfinished"}');

    expect(sockets).toHaveLength(2);
    expect(received).toHaveLength(2);
    manager.closeAll();
    expect(sockets[1]?.closed).toBe(true);
  });

  it('marks and redacts active HTTP traffic in the shared recorder', async () => {
    const recorder = new NetworkRecorder();
    const transport = new FetchHttpTransport(
      recorder,
      async () =>
        new Response(JSON.stringify({ lessonToken: 'response-secret' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await transport.request({
      method: 'POST',
      url: 'https://www.yuketang.cn/api/v3/lesson/checkin',
      headers: { authorization: 'Bearer request-secret' },
      body: '{"lessonId":"1"}',
    });

    expect(recorder.entries[0]).toMatchObject({
      kind: 'http',
      source: 'active',
      requestHeaders: { authorization: '[REDACTED]' },
    });
    expect(JSON.stringify(recorder.entries[0])).not.toContain(
      'response-secret',
    );
  });

  it('routes presentation responses by browser tab when two lessons are active', async () => {
    const collector = new BrowserLessonCollector();
    const first: unknown[] = [];
    const second: unknown[] = [];
    collector.watchLesson(
      BrowserEnvironment.Changjiang,
      'lesson-1',
      null,
      (observation) => {
        first.push(observation);
      },
    );
    collector.watchLesson(
      BrowserEnvironment.Changjiang,
      'lesson-2',
      null,
      (observation) => {
        second.push(observation);
      },
    );
    collector.observeNavigation(
      'tab-2',
      'https://changjiang.yuketang.cn/lesson/fullscreen/v3/lesson-2/exercise/9',
    );

    await collector.observeHttp({
      url: 'https://changjiang.yuketang.cn/api/v3/lesson/presentation/fetch?presentation_id=presentation-2',
      statusCode: 200,
      contextId: 'tab-2',
      body: JSON.stringify({
        data: {
          id: 'presentation-2',
          slides: [
            {
              id: 'slide-2',
              problem: {
                problemId: 'problem-2',
                problemType: 1,
                content: '1+1=',
                options: ['1', '2', '3', '4'],
              },
            },
          ],
        },
      }),
    });

    expect(first).toEqual([]);
    expect(second).toEqual([
      expect.objectContaining({
        type: 'presentation',
        presentation: expect.objectContaining({
          id: 'presentation-2',
          lessonId: 'lesson-2',
        }),
      }),
    ]);
  });
});

class FakeSocket implements LessonSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.();
  }

  message(data: string): void {
    this.onmessage?.({ data });
  }

  serverClose(): void {
    this.onclose?.();
  }
}

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import type { NetworkEntry } from '@ykt/contracts';
import {
  sanitizeHeaders,
  sanitizeText,
  sanitizeUnknown,
  sanitizeUrl,
} from '@ykt/routing';

export interface PersistentNetworkArchiveOptions {
  readonly retentionDays?: number;
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly flushDelayMs?: number;
}

export interface PersistentNetworkArchiveStats {
  readonly entries: number;
  readonly bytes: number;
  readonly oldestTimestamp: string | null;
  readonly newestTimestamp: string | null;
}

interface ArchiveRow {
  payload: string;
}

interface StatsRow {
  entries: number;
  bytes: number;
  oldest_timestamp: string | null;
  newest_timestamp: string | null;
}

interface PendingEntry {
  capturedAt: string;
  kind: NetworkEntry['kind'];
  source: NetworkEntry['source'];
  payload: string;
  bytes: number;
}

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_MAX_ENTRIES = 250_000;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_FLUSH_DELAY_MS = 500;
const PRUNE_AFTER_WRITES = 1_000;

/**
 * A bounded, credential-redacted archive of background browser captures.
 *
 * It deliberately uses a separate database from application settings so a
 * large capture cannot affect configuration, cached lessons or API keys.
 */
export class PersistentNetworkArchive {
  readonly #database: DatabaseSync;
  readonly #insert: StatementSync;
  readonly #retentionDays: number;
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  readonly #flushDelayMs: number;
  readonly #pending: PendingEntry[] = [];
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  #writesSincePrune = 0;
  #closed = false;

  constructor(path: string, options: PersistentNetworkArchiveOptions = {}) {
    mkdirSync(dirname(path), { recursive: true });
    this.#retentionDays = positiveInteger(
      options.retentionDays,
      DEFAULT_RETENTION_DAYS,
    );
    this.#maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES);
    this.#maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);
    this.#flushDelayMs = positiveInteger(
      options.flushDelayMs,
      DEFAULT_FLUSH_DELAY_MS,
    );
    this.#database = new DatabaseSync(path);
    this.#database.exec(
      'PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;',
    );
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS network_capture_entries (
        archive_id INTEGER PRIMARY KEY AUTOINCREMENT,
        captured_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        payload TEXT NOT NULL,
        payload_bytes INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS network_capture_entries_timestamp
        ON network_capture_entries(captured_at);
      CREATE INDEX IF NOT EXISTS network_capture_entries_kind
        ON network_capture_entries(kind, captured_at);
    `);
    this.#insert = this.#database.prepare(`
      INSERT INTO network_capture_entries(
        captured_at, kind, source, payload, payload_bytes
      ) VALUES (?, ?, ?, ?, ?)
    `);
    this.prune();
  }

  append(entry: NetworkEntry): void {
    if (this.#closed) return;
    const safeEntry = sanitizeEntry(entry);
    const payload = JSON.stringify(safeEntry);
    this.#pending.push({
      capturedAt: safeEntry.timestamp,
      kind: safeEntry.kind,
      source: safeEntry.source,
      payload,
      bytes: Buffer.byteLength(payload),
    });
    if (this.#pending.length >= 100) {
      this.flush();
      return;
    }
    if (this.#flushTimer) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      try {
        this.flush();
      } catch (error) {
        console.error('Unable to persist network capture batch.', error);
      }
    }, this.#flushDelayMs);
    this.#flushTimer.unref?.();
  }

  flush(): void {
    if (this.#closed || this.#pending.length === 0) return;
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    const batch = this.#pending.splice(0);
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      for (const entry of batch) {
        this.#insert.run(
          entry.capturedAt,
          entry.kind,
          entry.source,
          entry.payload,
          entry.bytes,
        );
      }
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      this.#pending.unshift(...batch);
      throw error;
    }
    this.#writesSincePrune += batch.length;
    if (this.#writesSincePrune >= PRUNE_AFTER_WRITES) this.prune();
  }

  listRecent(limit = 200): readonly NetworkEntry[] {
    this.flush();
    const safeLimit = Math.max(1, Math.min(10_000, Math.trunc(limit)));
    const rows = this.#database
      .prepare(
        `SELECT payload FROM network_capture_entries
         ORDER BY archive_id DESC LIMIT ?`,
      )
      .all(safeLimit) as unknown as ArchiveRow[];
    return rows.map((row) => JSON.parse(row.payload) as NetworkEntry).reverse();
  }

  stats(): PersistentNetworkArchiveStats {
    this.flush();
    const row = this.#database
      .prepare(
        `SELECT COUNT(*) AS entries,
                COALESCE(SUM(payload_bytes), 0) AS bytes,
                MIN(captured_at) AS oldest_timestamp,
                MAX(captured_at) AS newest_timestamp
         FROM network_capture_entries`,
      )
      .get() as unknown as StatsRow;
    return {
      entries: Number(row.entries),
      bytes: Number(row.bytes),
      oldestTimestamp: row.oldest_timestamp,
      newestTimestamp: row.newest_timestamp,
    };
  }

  close(): void {
    if (this.#closed) return;
    this.flush();
    this.prune();
    this.#closed = true;
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    this.#flushTimer = null;
    this.#database.close();
  }

  private prune(): void {
    const cutoff = new Date(
      Date.now() - this.#retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    this.#database
      .prepare('DELETE FROM network_capture_entries WHERE captured_at < ?')
      .run(cutoff);
    this.#database
      .prepare(
        `
        DELETE FROM network_capture_entries
        WHERE archive_id NOT IN (
          SELECT archive_id FROM network_capture_entries
          ORDER BY archive_id DESC LIMIT ?
        )
      `,
      )
      .run(this.#maxEntries);
    this.#database
      .prepare(
        `
        DELETE FROM network_capture_entries
        WHERE archive_id IN (
          SELECT archive_id FROM (
            SELECT archive_id,
                   SUM(payload_bytes) OVER (
                     ORDER BY archive_id DESC
                     ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                   ) AS retained_bytes
            FROM network_capture_entries
          )
          WHERE retained_bytes > ?
        )
      `,
      )
      .run(this.#maxBytes);
    this.#writesSincePrune = 0;
  }
}

function sanitizeEntry(entry: NetworkEntry): NetworkEntry {
  const base = {
    id: sanitizeText(entry.id),
    sequence: entry.sequence,
    timestamp: entry.timestamp,
    source: entry.source,
  };
  if (entry.kind === 'http') {
    return {
      ...base,
      kind: 'http',
      phase: entry.phase,
      requestId: sanitizeText(entry.requestId),
      method: sanitizeText(entry.method),
      url: sanitizeUrl(entry.url),
      resourceType: sanitizeText(entry.resourceType),
      statusCode: entry.statusCode,
      durationMs: entry.durationMs,
      requestHeaders: sanitizeHeaders(entry.requestHeaders),
      requestBody:
        entry.requestBody === null ? null : sanitizeText(entry.requestBody),
      responseHeaders: sanitizeHeaders(entry.responseHeaders),
      body:
        entry.body === null
          ? null
          : entry.bodyEncoding === 'base64'
            ? `[OMITTED BASE64 BODY: ${entry.body.length} characters]`
            : sanitizeText(entry.body),
      bodyEncoding: entry.bodyEncoding,
      error: entry.error === null ? null : sanitizeText(entry.error),
    };
  }
  if (entry.kind === 'websocket') {
    return {
      ...base,
      kind: 'websocket',
      requestId: sanitizeText(entry.requestId),
      url: sanitizeUrl(entry.url),
      direction: entry.direction,
      opcode: entry.opcode,
      payload: entry.payload === null ? null : sanitizeText(entry.payload),
      error: entry.error === null ? null : sanitizeText(entry.error),
    };
  }
  return {
    ...base,
    kind: 'domain',
    eventType: sanitizeText(entry.eventType),
    summary: sanitizeText(entry.summary),
    normalizerId: sanitizeText(entry.normalizerId),
    sourceEntryId: sanitizeText(entry.sourceEntryId),
    data: sanitizeUnknown(entry.data),
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value <= 0
    ? fallback
    : Math.trunc(value);
}

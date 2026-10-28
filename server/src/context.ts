import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import type { Queue } from './jobs/queue.js';
import type { Realtime } from './realtime.js';

export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
}

export interface AppContext {
  config: Config;
  db: Db;
  queue: Queue;
  realtime: Realtime;
  log: Logger | FastifyBaseLogger;
  /** Injectable fetch: tests replace it to fake the Graph API / Claude API. */
  fetch: typeof fetch;
}

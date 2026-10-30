import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import jwt from 'jsonwebtoken';
import { Server as IOServer } from 'socket.io';
import type { Config } from './config.js';
import type { AppContext } from './context.js';
import { createDb, type Db } from './db/index.js';
import { jobGiveUpHandlers, jobHandlers } from './jobs/handlers.js';
import { Queue } from './jobs/queue.js';
import { Worker } from './jobs/worker.js';
import { readCookie, verifyToken } from './lib/auth.js';
import { AppError } from './lib/errors.js';
import { createWebhookFetch } from './lib/net.js';
import { Realtime } from './realtime.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { broadcastRoutes } from './routes/broadcasts.js';
import { channelRoutes, metaWebhookRoutes } from './routes/channels.js';
import { contactRoutes } from './routes/contacts.js';
import { crmRoutes } from './routes/crm.js';
import { COOKIE, SESSION_DAYS, SESSION_FRESH } from './routes/helpers.js';
import { integrationRoutes } from './routes/integrations.js';
import { invitationRoutes } from './routes/invitations.js';
import { miscRoutes } from './routes/misc.js';
import { templateRoutes } from './routes/templates.js';
import { workspaceRoutes } from './routes/workspace.js';

/** Node's timers hold 32-bit delays: a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** How often open sockets are checked against their sessions (see Realtime.sweepSessions). */
const SESSION_SWEEP_MS = 60_000;

export interface BuiltApp {
  app: FastifyInstance;
  ctx: AppContext;
  worker: Worker;
  close(): Promise<void>;
}

export async function buildApp(config: Config, opts: { db?: Db; fetch?: typeof fetch; logger?: boolean } = {}): Promise<BuiltApp> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel },
    bodyLimit: 12 * 1024 * 1024,
    trustProxy: config.trustProxy as any,
  });
  const db =
    opts.db ??
    (await createDb({
      databaseUrl: config.databaseUrl,
      dataDir: config.dataDir,
      onIdleError: (err) => app.log.warn({ err: err.message }, 'database connection lost'),
    }));
  const queue = new Queue(db);
  const realtime = new Realtime();
  const ctx: AppContext = {
    config,
    db,
    queue,
    realtime,
    log: app.log,
    fetch: opts.fetch ?? fetch,
    webhookFetch: opts.fetch ?? createWebhookFetch(config.allowPrivateWebhooks),
  };
  const worker = new Worker(ctx, jobHandlers, { onGiveUp: jobGiveUpHandlers });

  // JSON parser that keeps the raw body for Meta's signature check and accepts empty bodies.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body: Buffer, done) => {
    if (req.url.startsWith('/webhooks/')) (req as any).rawBody = body;
    if (!body.length) return done(null, {});
    try {
      done(null, JSON.parse(body.toString('utf8')));
    } catch {
      const err = new AppError(400, 'INVALID_JSON', 'El cuerpo de la petición no es JSON válido');
      done(err as any, undefined);
    }
  });

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 } });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err?.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: { code: err.code ?? 'BAD_REQUEST', message: err.message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Error interno del servidor' } });
  });

  app.get('/health', async () => {
    await db.query('SELECT 1');
    return { ok: true, db: db.kind };
  });

  await authRoutes(app, ctx);
  await workspaceRoutes(app, ctx);
  await invitationRoutes(app, ctx);
  await channelRoutes(app, ctx);
  await metaWebhookRoutes(app, ctx);
  await crmRoutes(app, ctx);
  await contactRoutes(app, ctx);
  await templateRoutes(app, ctx);
  await broadcastRoutes(app, ctx);
  await miscRoutes(app, ctx);
  await integrationRoutes(app, ctx);
  await adminRoutes(app, ctx);

  // Web app (React build) with SPA fallback.
  if (config.webDistDir && fs.existsSync(path.join(config.webDistDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: config.webDistDir, wildcard: false });
    const indexHtml = fs.readFileSync(path.join(config.webDistDir, 'index.html'), 'utf8');
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== 'GET' || /^\/(api|webhooks|socket\.io)\//.test(req.url)) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Ruta no encontrada' } });
      }
      return reply.type('text/html').send(indexHtml);
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Ruta no encontrada' } }));
  }

  // Realtime (Socket.IO on the same port). Rooms live in this process: run a single replica.
  const io = new IOServer(app.server, { path: '/socket.io', serveClient: false });
  // 'unauthorized' means the session is over (the client signs out once /api/auth/me agrees);
  // 'unavailable' is a passing failure (e.g. the database is restarting) that the client retries.
  io.use(async (socket, next) => {
    const token = readCookie(socket.handshake.headers.cookie, COOKIE);
    const payload = token && verifyToken(config.jwtSecret, token);
    if (!payload) return next(new Error('unauthorized'));
    let rowExpiresAt: number | undefined;
    try {
      const { rows } = await db.query<{ expires_ms: number }>(
        `SELECT extract(epoch FROM s.created_at + interval '${SESSION_DAYS} days')::float8 * 1000 AS expires_ms
         FROM sessions s JOIN users u ON u.id = s.user_id AND u.password_version = s.password_version
         WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL AND ${SESSION_FRESH}`,
        [payload.sid, payload.uid],
      );
      rowExpiresAt = rows[0]?.expires_ms;
    } catch {
      return next(new Error('unavailable'));
    }
    if (rowExpiresAt === undefined) return next(new Error('unauthorized'));
    // A connection is no license to outlive the session: it ends when the token or the row does.
    const exp = (jwt.decode(token) as { exp?: unknown } | null)?.exp;
    socket.data.userId = payload.uid;
    socket.data.sid = payload.sid;
    socket.data.expiresAt = Math.min(rowExpiresAt, typeof exp === 'number' ? exp * 1000 : Infinity);
    next();
  });
  io.on('connection', (socket) => {
    // Lets logout/password changes reach this connection (Realtime.endSessions / evictUser).
    socket.join([`user:${socket.data.userId}`, `sid:${socket.data.sid}`]);
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const armExpiry = () => {
      const left = socket.data.expiresAt - Date.now();
      if (left <= 0) return realtime.endSocket(socket);
      // Longer delays overflow Node's 32-bit timers (they fire at once): wait in steps.
      expiry = setTimeout(armExpiry, Math.min(left, MAX_TIMER_MS));
    };
    socket.on('disconnect', () => clearTimeout(expiry));
    armExpiry();
    socket.on('join', async (workspaceId: string, rawAck?: unknown) => {
      // Clients choose the arguments: never call something that is not a function.
      const ack = typeof rawAck === 'function' ? (rawAck as (r: { ok: boolean }) => void) : undefined;
      try {
        if (typeof workspaceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(workspaceId)) return ack?.({ ok: false });
        // Rights are read, then rooms joined. Revocations commit first and evict after: if one that
        // concerns this join evicted while we were reading, what we read may predate it, so read again.
        const { userId, sid } = socket.data;
        const evictions = realtime.watchEvictions([`ws:${workspaceId}`, `ws:${workspaceId}:u:${userId}`, `user:${userId}`, `sid:${sid}`]);
        type Rights = { role: string | null; visibility: string | null; is_superadmin: boolean; ws_exists: boolean; ws_active: boolean | null };
        let r: Rights | undefined;
        let settled = false;
        try {
          for (let attempt = 0; ; attempt++) {
            const epoch = evictions.count();
            const { rows } = await db.query<Rights>(
              `SELECT m.role, w.settings->>'agent_visibility' AS visibility, u.is_superadmin, w.id IS NOT NULL AS ws_exists, w.is_active AS ws_active
               FROM users u JOIN sessions s ON s.id = $3 AND s.user_id = u.id AND s.revoked_at IS NULL AND s.password_version = u.password_version
                 AND ${SESSION_FRESH}
               LEFT JOIN workspaces w ON w.id = $1
               LEFT JOIN memberships m ON m.workspace_id = w.id AND m.user_id = u.id AND m.is_active
               WHERE u.id = $2`,
              [workspaceId, userId, sid],
            );
            if (evictions.count() === epoch) {
              r = rows[0];
              settled = true;
              break;
            }
            if (attempt >= 4) break; // rights keep changing: refuse, the client may retry
          }
        } finally {
          evictions.release();
        }
        // Nothing awaited since the check above: an eviction from now on finds this socket in its rooms.
        if (!socket.connected) return;
        if (settled && !r && !socket.data.renewed) {
          // The session is over (expired, revoked, deleted) although nothing ended this socket.
          ack?.({ ok: false });
          return realtime.endSocket(socket);
        }
        if (!r || !r.ws_exists || (!r.is_superadmin && (!r.role || !r.ws_active))) {
          // A refused switch must not leave the socket listening to the previous workspace either.
          for (const room of socket.rooms) if (room.startsWith('ws:')) socket.leave(room);
          return ack?.({ ok: false });
        }
        for (const room of socket.rooms) if (room.startsWith('ws:')) socket.leave(room);
        // Same rule as requireWs: the instance operator is an owner everywhere.
        const role = r.is_superadmin ? 'owner' : r.role;
        if (role === 'agent' && r.visibility === 'assigned') {
          socket.join([`ws:${workspaceId}:restricted`, `ws:${workspaceId}:u:${socket.data.userId}`]);
        } else {
          socket.join(role === 'agent' ? [`ws:${workspaceId}`] : [`ws:${workspaceId}`, `ws:${workspaceId}:admins`]);
        }
        ack?.({ ok: true });
      } catch {
        // As a refusal: a failed switch must not leave the socket listening to the previous workspace.
        for (const room of socket.rooms) if (room.startsWith('ws:')) socket.leave(room);
        ack?.({ ok: false });
      }
    });
  });
  realtime.io = io;
  realtime.liveSessions = async (sids) => {
    const { rows } = await db.query<{ id: string }>(
      `SELECT s.id FROM sessions s JOIN users u ON u.id = s.user_id AND u.password_version = s.password_version
       WHERE s.id = ANY($1::uuid[]) AND s.revoked_at IS NULL AND ${SESSION_FRESH}`,
      [sids],
    );
    return new Set(rows.map((r) => r.id));
  };
  // A database hiccup skips one round: the next one checks again.
  const sweep = setInterval(() => void realtime.sweepSessions().catch(() => {}), SESSION_SWEEP_MS);
  sweep.unref();
  realtime.resolveAssignee = async (contactId) => {
    const { rows } = await db.query<{ assigned_user_id: string | null }>(`SELECT assigned_user_id FROM contacts WHERE id = $1`, [contactId]);
    // A contact deleted meanwhile is unknown, not unassigned: restricted agents get nothing about it.
    return rows[0] ? rows[0].assigned_user_id : undefined;
  };

  return {
    app,
    ctx,
    worker,
    async close() {
      await worker.stop();
      clearInterval(sweep);
      io.close();
      await app.close();
      await db.close();
    },
  };
}

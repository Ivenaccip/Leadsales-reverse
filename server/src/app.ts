import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { Server as IOServer } from 'socket.io';
import type { Config } from './config.js';
import type { AppContext } from './context.js';
import { createDb, type Db } from './db/index.js';
import { jobHandlers } from './jobs/handlers.js';
import { Queue } from './jobs/queue.js';
import { Worker } from './jobs/worker.js';
import { readCookie, verifyToken } from './lib/auth.js';
import { AppError } from './lib/errors.js';
import { Realtime } from './realtime.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { broadcastRoutes } from './routes/broadcasts.js';
import { channelRoutes, metaWebhookRoutes } from './routes/channels.js';
import { contactRoutes } from './routes/contacts.js';
import { crmRoutes } from './routes/crm.js';
import { COOKIE } from './routes/helpers.js';
import { integrationRoutes } from './routes/integrations.js';
import { miscRoutes } from './routes/misc.js';
import { templateRoutes } from './routes/templates.js';
import { workspaceRoutes } from './routes/workspace.js';

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
    trustProxy: true,
  });
  const db = opts.db ?? (await createDb({ databaseUrl: config.databaseUrl, dataDir: config.dataDir }));
  const queue = new Queue(db);
  const realtime = new Realtime();
  const ctx: AppContext = { config, db, queue, realtime, log: app.log, fetch: opts.fetch ?? fetch };
  const worker = new Worker(ctx, jobHandlers);

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

  // Realtime (Socket.IO on the same port).
  const io = new IOServer(app.server, { path: '/socket.io', serveClient: false });
  io.use(async (socket, next) => {
    const token = readCookie(socket.handshake.headers.cookie, COOKIE);
    const payload = token ? verifyToken(config.jwtSecret, token) : null;
    if (!payload) return next(new Error('unauthorized'));
    socket.data.userId = payload.uid;
    next();
  });
  io.on('connection', (socket) => {
    socket.on('join', async (workspaceId: string, ack?: (r: { ok: boolean }) => void) => {
      try {
        if (typeof workspaceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(workspaceId)) return ack?.({ ok: false });
        const { rows } = await db.query<{ role: string | null; visibility: string | null; is_superadmin: boolean }>(
          `SELECT m.role, w.settings->>'agent_visibility' AS visibility, u.is_superadmin
           FROM users u JOIN workspaces w ON w.id = $1
           LEFT JOIN memberships m ON m.workspace_id = w.id AND m.user_id = u.id AND m.is_active
           WHERE u.id = $2`,
          [workspaceId, socket.data.userId],
        );
        const r = rows[0];
        if (!r || (!r.role && !r.is_superadmin)) return ack?.({ ok: false });
        for (const room of socket.rooms) if (room.startsWith('ws:')) socket.leave(room);
        if (r.role === 'agent' && r.visibility === 'assigned') {
          socket.join([`ws:${workspaceId}:restricted`, `ws:${workspaceId}:u:${socket.data.userId}`]);
        } else {
          socket.join(`ws:${workspaceId}`);
        }
        ack?.({ ok: true });
      } catch {
        ack?.({ ok: false });
      }
    });
  });
  realtime.io = io;
  realtime.resolveAssignee = async (contactId) => {
    const { rows } = await db.query<{ assigned_user_id: string | null }>(`SELECT assigned_user_id FROM contacts WHERE id = $1`, [contactId]);
    return rows[0] ? rows[0].assigned_user_id : null;
  };

  return {
    app,
    ctx,
    worker,
    async close() {
      await worker.stop();
      io.close();
      await app.close();
      await db.close();
    },
  };
}

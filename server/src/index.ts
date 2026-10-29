import fs from 'node:fs';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

// Local runs: read .env from the working directory (Docker passes variables directly).
if (fs.existsSync('.env')) process.loadEnvFile('.env');

const config = loadConfig();
const built = await buildApp(config);
built.worker.start();

await built.app.listen({ port: config.port, host: config.host });
built.app.log.info(
  `LeadLibre listo en ${config.publicUrl} — base de datos: ${built.ctx.db.kind} — webhook de Meta: ${config.publicUrl}/webhooks/whatsapp`,
);
if (!config.webDistDir) built.app.log.warn('No se encontró web/dist: corre "npm run build" para servir la interfaz.');
// Realtime events (Socket.IO rooms) live in each process: users connected to one replica would
// not see what happens in another. Only one instance per database is supported (PGlite cannot be shared).
if (built.ctx.db.kind === 'postgres') {
  built.worker
    .liveReplicas()
    .then((others) => {
      if (!others.length) return;
      built.app.log.warn(
        `Otra instancia de LeadLibre usa esta misma base de datos (${others.join(', ')}). Solo se admite una réplica: ` +
          'los eventos en tiempo real no pasan de una instancia a otra. Deja una sola corriendo.',
      );
    })
    .catch((err) => built.app.log.debug({ err }, 'replica check failed'));
}

let closing = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    if (closing) return;
    closing = true;
    built.app.log.info(`${sig} recibido, cerrando...`);
    // Docker kills the process 10 s after SIGTERM: stop claiming, give running jobs 7 s, and
    // put the unfinished ones back in the queue so the next start runs them right away.
    await built.worker.stop(7000).catch(() => {});
    await built.close().catch(() => {});
    process.exit(0);
  });
}

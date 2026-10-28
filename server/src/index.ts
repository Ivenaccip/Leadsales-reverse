import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const built = await buildApp(config);
built.worker.start();

await built.app.listen({ port: config.port, host: config.host });
built.app.log.info(
  `LeadLibre listo en ${config.publicUrl} — base de datos: ${built.ctx.db.kind} — webhook de Meta: ${config.publicUrl}/webhooks/whatsapp`,
);
if (!config.webDistDir) built.app.log.warn('No se encontró web/dist: corre "npm run build" para servir la interfaz.');

let closing = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    if (closing) return;
    closing = true;
    built.app.log.info(`${sig} recibido, cerrando...`);
    await built.close().catch(() => {});
    process.exit(0);
  });
}

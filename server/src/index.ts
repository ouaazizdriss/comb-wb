import { config } from './config.ts';
import { migrate } from './db/migrate.ts';
import { initClassifier } from './targets/classify.ts';
import { startJobs, stopJobs } from './core/jobs.ts';
import { buildApp } from './app.ts';
import { meta } from './db/meta.ts';

async function main(): Promise<void> {
  await migrate((m) => console.log(m));
  await initClassifier();
  const app = await buildApp();
  await startJobs();
  await app.listen({ host: config.HOST, port: config.PORT });
  console.log(`Comb listening on http://${config.HOST}:${config.PORT}`);

  const shutdown = async () => {
    await app.close().catch(() => {});
    await stopJobs();
    await meta.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('fatal:', e.message);
  process.exit(1);
});

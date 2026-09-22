// HTTP entry point for a hosted deployment.
import { createApp } from "./app.ts";
import { config, setupProblems } from "./config.ts";

createApp().listen(config.port, () => {
  console.log(`[energi ${new Date().toISOString()}] listening on http://0.0.0.0:${config.port}, public URL ${config.baseUrl}`);
  const problems = setupProblems();
  if (problems.length) console.log("[energi] warnings:", problems);
});

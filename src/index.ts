// MUST be first: boots OpenTelemetry before any app module (incl. express) loads.
import { shutdownOtel, otelStatus } from "./otel";
import { createServer } from "./server";
import { config, llmEnabled } from "./config";
import { langfuse, langfuseEnabled } from "./lib/langfuse";

const app = createServer();

// Flush buffered telemetry (Langfuse + OTel) before the process exits.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await Promise.allSettled([langfuse.shutdownAsync(), shutdownOtel()]);
    process.exit(0);
  });
}

app.listen(config.port, () => {
  console.log(`ct-viz-agent listening on http://localhost:${config.port}`);
  console.log(`  interpreter: ${llmEnabled() ? `LLM (${config.openAiModel})` : "deterministic fallback (no OPENAI_API_KEY)"}`);
  console.log(`  langfuse:    ${langfuseEnabled ? "enabled (tracing live requests)" : "dry-run (no LANGFUSE_* keys — eval scores logged to console)"}`);
  console.log(`  otel:        ${otelStatus}`);
  console.log(`  POST /query   { "query": "...", ...optional fields }`);
  console.log(`  demo UI       http://localhost:${config.port}/demo`);
});

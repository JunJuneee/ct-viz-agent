/**
 * OpenTelemetry app-level tracing.
 *
 * MUST be imported FIRST in the process (it is the first import in index.ts) so
 * the auto-instrumentations can patch `http`/`express`/`undici` before those
 * modules are required by the rest of the app.
 *
 * Opt-in, mirroring the Langfuse dry-run philosophy:
 *   - OTEL_ENABLED=true (or any OTEL_EXPORTER_OTLP_ENDPOINT set) -> tracing on.
 *   - With an OTLP endpoint  -> spans exported via OTLP (e.g. bundled Jaeger).
 *   - Without one            -> spans printed to the console (zero infra).
 *   - Neither set            -> no-op, no overhead.
 *
 * This is complementary to Langfuse (v3): Langfuse captures LLM semantics
 * (prompt/cost/eval scores); OTel captures the request/infra trace — the inbound
 * POST /query span and its child outbound calls (ClinicalTrials.gov + OpenAI).
 */
import "./config"; // ensure dotenv has populated process.env
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { SpanStatusCode, trace } from "@opentelemetry/api";

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();

/** Tracing is on when explicitly enabled, or when an OTLP endpoint is given. */
export const otelEnabled =
  process.env.OTEL_ENABLED?.trim() === "true" || !!endpoint;

let sdk: NodeSDK | undefined;

if (otelEnabled) {
  // The SDK reads OTEL_SERVICE_NAME for the service identity; default it.
  if (!process.env.OTEL_SERVICE_NAME) process.env.OTEL_SERVICE_NAME = "ct-viz-agent";

  // OTLP exporter reads OTEL_EXPORTER_OTLP_ENDPOINT (+ _HEADERS) from the env.
  const processor: SpanProcessor = endpoint
    ? new BatchSpanProcessor(new OTLPTraceExporter())
    : new SimpleSpanProcessor(new ConsoleSpanExporter());

  sdk = new NodeSDK({
    spanProcessors: [processor],
    instrumentations: [
      getNodeAutoInstrumentations({
        // fs spans are extremely noisy and irrelevant here.
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });
  sdk.start();
}

/** Flush + stop the tracer (called from the process shutdown handler). */
export async function shutdownOtel(): Promise<void> {
  await sdk?.shutdown().catch(() => {});
}

/** One-line status string for the startup banner. */
export const otelStatus = otelEnabled
  ? `enabled (${endpoint ? `OTLP -> ${endpoint}` : "console exporter (no OTLP endpoint)"})`
  : "disabled (set OTEL_ENABLED=true)";

const tracer = trace.getTracer("ct-viz-agent");

/**
 * Wrap an async stage in a child span (named pipeline steps: interpret, fetch,
 * aggregate). No-op when tracing is disabled, so call sites stay clean.
 */
export async function withSpan<T>(
  name: string,
  fn: () => Promise<T>,
  attributes?: Record<string, string | number | boolean>,
): Promise<T> {
  if (!otelEnabled) return fn();
  return tracer.startActiveSpan(name, async (span) => {
    try {
      if (attributes) span.setAttributes(attributes);
      return await fn();
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}

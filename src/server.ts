import path from "path";
import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import { ZodError } from "zod";
import { RequestSchema, RequestInput } from "./schemas/request";
import { runAgent } from "./pipeline";
import { CtgovError } from "./clinicaltrials/client";
import { llmEnabled } from "./config";

export function createServer(): express.Express {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "256kb" }));

  // Serve the optional demo UI from /demo.
  app.use("/demo", express.static(path.join(__dirname, "..", "demo")));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", interpreter: llmEnabled() ? "llm" : "fallback-rules" });
  });

  app.post("/query", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = RequestSchema.parse(req.body);
      const result = await runAgent(input);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // Server-Sent Events: streams the LLM interpretation, live fetch progress,
  // and the final result. Uses GET + query params so EventSource can connect.
  app.get("/query/stream", async (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Stop work if the client disconnects mid-stream.
    let aborted = false;
    req.on("close", () => {
      aborted = true;
    });

    try {
      const input = RequestSchema.parse(coerceQueryParams(req.query));
      await runAgent(input, (e) => {
        if (!aborted) send(e.type, e);
      });
      if (!aborted) send("done", { ok: true });
    } catch (err) {
      if (err instanceof ZodError) {
        send("error", {
          error: "invalid_request",
          details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        });
      } else if (err instanceof CtgovError) {
        send("error", { error: "clinicaltrials_api_error", message: err.message });
      } else {
        send("error", { error: "internal_error", message: String(err) });
      }
    } finally {
      res.end();
    }
  });

  // Centralised error handling with meaningful status codes.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      return res.status(400).json({
        error: "invalid_request",
        details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    if (err instanceof CtgovError) {
      return res.status(502).json({ error: "clinicaltrials_api_error", message: err.message });
    }
    console.error("Unhandled error:", err);
    return res.status(500).json({ error: "internal_error", message: String(err) });
  });

  return app;
}

/** Coerce SSE GET query-string params into the RequestInput shape before Zod. */
function coerceQueryParams(q: Request["query"]): Partial<RequestInput> {
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.length ? v : undefined;
  const num = (v: unknown): number | undefined => {
    const n = Number(v);
    return typeof v === "string" && v.length && Number.isFinite(n) ? n : undefined;
  };
  const arr = (v: unknown): string[] | undefined =>
    Array.isArray(v)
      ? (v as string[])
      : typeof v === "string" && v.length
        ? v.split(",").map((s) => s.trim())
        : undefined;

  const out: Record<string, unknown> = {};
  out.query = str(q.query);
  for (const k of ["drug_name", "condition", "sponsor", "country", "study_type", "visualization_type"]) {
    const v = str(q[k]);
    if (v !== undefined) out[k] = v;
  }
  const startYear = num(q.start_year);
  if (startYear !== undefined) out.start_year = startYear;
  const endYear = num(q.end_year);
  if (endYear !== undefined) out.end_year = endYear;
  const status = arr(q.status);
  if (status) out.status = status;
  const phase = arr(q.trial_phase);
  if (phase) out.trial_phase = phase.length === 1 ? phase[0] : phase;
  return out as Partial<RequestInput>;
}

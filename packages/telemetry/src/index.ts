// @mole/telemetry (T16): OpenTelemetry spans for mole check, the daemon and MCP tool calls, only when MOLE_OTEL=1.
// Off (the default): this module imports nothing from OpenTelemetry, every span helper just runs its function, and no
// socket is opened. On: startTelemetry() lazily imports the SDK + OTLP/HTTP JSON exporter and sends to
// OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, else OTEL_EXPORTER_OTLP_ENDPOINT + /v1/traces, else http://127.0.0.1:4318/v1/traces.
// Callers must await shutdownTelemetry() before the process exits (it flushes).
import type { Span, Tracer } from '@opentelemetry/api';

export type Attrs = Record<string, string | number | boolean | undefined>;
export type SetAttrs = (a: Attrs) => void;

/** OTel GenAI semantic-convention attribute names used here (execute_tool spans) + error.type */
export const GEN_AI = {
  operation: 'gen_ai.operation.name',
  toolName: 'gen_ai.tool.name',
  toolCallId: 'gen_ai.tool.call.id',
  errorType: 'error.type',
  mcpMethod: 'mcp.method.name',
} as const;

export const DEFAULT_ENDPOINT = 'http://127.0.0.1:4318';

interface State {
  tracer: Tracer;
  api: typeof import('@opentelemetry/api');
  shutdown: () => Promise<void>;
}

let state: State | undefined;
let loaded = false;

export function telemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MOLE_OTEL === '1';
}

/** true once the OpenTelemetry SDK has been imported in this process (never while MOLE_OTEL is unset) */
export function sdkLoaded(): boolean {
  return loaded;
}

function tracesUrl(env: NodeJS.ProcessEnv): string {
  if (env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) return env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  return `${(env.OTEL_EXPORTER_OTLP_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/+$/, '')}/v1/traces`;
}

/** start the SDK for this process when MOLE_OTEL=1; returns whether spans will be exported. Idempotent. */
export async function startTelemetry(service: string): Promise<boolean> {
  if (!telemetryEnabled()) return false;
  if (state) return true;
  loaded = true;
  const [api, { TracerProvider, BatchSpanProcessor }, { AsyncLocalStorageContextManager }, { OTLPTraceExporter }, { resourceFromAttributes }, { ATTR_SERVICE_NAME }] = await Promise.all([
    import('@opentelemetry/api'),
    import('@opentelemetry/sdk-trace'),
    import('@opentelemetry/context-async-hooks'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/resources'),
    import('@opentelemetry/semantic-conventions'),
  ]);
  const exporter = new OTLPTraceExporter({ url: tracesUrl(process.env) });
  const provider = new TracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: service }),
    // short delay: long-lived processes (daemon, MCP server) export within ~0.5 s; short ones flush on shutdown
    spanProcessors: [new BatchSpanProcessor({ exporter, scheduledDelayMillis: 500 })],
  });
  api.context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  api.trace.setGlobalTracerProvider(provider);
  state = {
    api,
    tracer: provider.getTracer('mole'),
    shutdown: async () => {
      await provider.forceFlush().catch(() => undefined);
      await provider.shutdown().catch(() => undefined);
    },
  };
  return true;
}

/** flush and stop the SDK (no-op when off). Bounded: an unreachable collector cannot hang the CLI past ~3 s. */
export async function shutdownTelemetry(): Promise<void> {
  const s = state;
  if (!s) return;
  state = undefined;
  await Promise.race([s.shutdown(), new Promise((r) => setTimeout(r, 3000).unref())]);
}

const clean = (a: Attrs): Record<string, string | number | boolean> => Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)) as Record<string, string | number | boolean>;

function fail(span: Span, s: State, e: unknown): void {
  span.recordException(e instanceof Error ? e : String(e));
  span.setAttribute(GEN_AI.errorType, e instanceof Error ? e.name : typeof e);
  span.setStatus({ code: s.api.SpanStatusCode.ERROR, message: e instanceof Error ? e.message : String(e) });
}

/** run fn inside a span (child of the active one); fn may add attributes via set() */
export async function withSpan<T>(name: string, attrs: Attrs, fn: (set: SetAttrs) => Promise<T> | T): Promise<T> {
  const s = state;
  if (!s) return fn(() => undefined);
  return s.tracer.startActiveSpan(name, { attributes: clean(attrs) }, async (span) => {
    try {
      return await fn((a) => span.setAttributes(clean(a)));
    } catch (e) {
      fail(span, s, e);
      throw e;
    } finally {
      span.end();
    }
  });
}

export function withSpanSync<T>(name: string, attrs: Attrs, fn: (set: SetAttrs) => T): T {
  const s = state;
  if (!s) return fn(() => undefined);
  return s.tracer.startActiveSpan(name, { attributes: clean(attrs) }, (span) => {
    try {
      return fn((a) => span.setAttributes(clean(a)));
    } catch (e) {
      fail(span, s, e);
      throw e;
    } finally {
      span.end();
    }
  });
}

/** OTel GenAI convention for a tool call: span `execute_tool {tool}`, gen_ai.operation.name=execute_tool, gen_ai.tool.name */
export function executeTool<T>(tool: string, attrs: Attrs, fn: (set: SetAttrs) => Promise<T> | T): Promise<T> {
  return withSpan(`execute_tool ${tool}`, { [GEN_AI.operation]: 'execute_tool', [GEN_AI.toolName]: tool, ...attrs }, fn);
}

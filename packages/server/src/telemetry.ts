// In-memory OpenTelemetry tracer for the server's own spans (R0 prior-art.md §9: GenAI
// span-naming convention `{operation} {target}`). Separate from @mole/telemetry's OTLP
// exporter (which needs a real collector endpoint) so the M25/done-when "in-memory exporter
// test" works with no network and no collector process (non-goal: never start Docker).
import { trace } from '@opentelemetry/api';
import { TracerProvider, SimpleSpanProcessor, InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

export { InMemorySpanExporter };

export interface Telemetry {
  exporter: InMemorySpanExporter;
  withSpan<T>(name: string, attrs: Record<string, unknown>, fn: () => Promise<T>): Promise<T>;
  shutdown(): Promise<void>;
}

/** GenAI-style span name: `{operation} {target}` (R0 §9), used for every webhook/job/MCP stage. */
export function initTelemetry(service = 'mole-server'): Telemetry {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: service }),
    spanProcessors: [new SimpleSpanProcessor({ exporter })],
  });
  trace.setGlobalTracerProvider(provider);
  const tracer = provider.getTracer('mole-server');
  return {
    exporter,
    async withSpan<T>(name: string, attrs: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
      return tracer.startActiveSpan(name, { attributes: attrs as any }, async (span: any) => {
        try {
          return await fn();
        } catch (e) {
          span.recordException(e instanceof Error ? e : String(e));
          throw e;
        } finally {
          span.end();
        }
      });
    },
    async shutdown() {
      await provider.shutdown();
    },
  };
}

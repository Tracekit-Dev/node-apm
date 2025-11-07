import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import * as api from '@opentelemetry/api';

export interface TracekitConfig {
  apiKey: string;
  endpoint?: string;
  serviceName?: string;
  enabled?: boolean;
  sampleRate?: number;
}

export class TracekitClient {
  private provider: NodeTracerProvider;
  private tracer: api.Tracer;
  private config: Required<TracekitConfig>;

  constructor(config: TracekitConfig) {
    this.config = {
      endpoint: config.endpoint || 'https://app.tracekit.dev/v1/traces',
      serviceName: config.serviceName || 'node-app',
      enabled: config.enabled ?? true,
      sampleRate: config.sampleRate ?? 1.0,
      apiKey: config.apiKey,
    };

    // Create resource with service name
    const resource = new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: this.config.serviceName,
    });

    // Initialize tracer provider
    this.provider = new NodeTracerProvider({
      resource,
    });

    if (this.config.enabled) {
      // Configure OTLP exporter
      const exporter = new OTLPTraceExporter({
        url: this.config.endpoint,
        headers: {
          'X-API-Key': this.config.apiKey,
        },
      });

      // Use batch processor for better performance
      this.provider.addSpanProcessor(new BatchSpanProcessor(exporter));

      // Register the provider
      this.provider.register();
    }

    this.tracer = api.trace.getTracer('@tracekit/node-apm', '1.0.0');
  }

  startTrace(operationName: string, attributes: Record<string, any> = {}): api.Span {
    return this.tracer.startSpan(operationName, {
      kind: api.SpanKind.SERVER,
      attributes: this.normalizeAttributes(attributes),
    });
  }

  startSpan(
    operationName: string,
    parentSpan?: api.Span | null,
    attributes: Record<string, any> = {}
  ): api.Span {
    const options: api.SpanOptions = {
      kind: api.SpanKind.INTERNAL,
      attributes: this.normalizeAttributes(attributes),
    };

    if (parentSpan) {
      const ctx = api.trace.setSpan(api.context.active(), parentSpan);
      return this.tracer.startSpan(operationName, options, ctx);
    }

    return this.tracer.startSpan(operationName, options);
  }

  endSpan(span: api.Span, finalAttributes: Record<string, any> = {}, status?: string): void {
    // Add final attributes
    if (Object.keys(finalAttributes).length > 0) {
      span.setAttributes(this.normalizeAttributes(finalAttributes));
    }

    // Set status
    if (status === 'ERROR') {
      span.setStatus({ code: api.SpanStatusCode.ERROR });
    } else if (status === 'OK') {
      span.setStatus({ code: api.SpanStatusCode.OK });
    }

    span.end();
  }

  addEvent(span: api.Span, name: string, attributes: Record<string, any> = {}): void {
    span.addEvent(name, this.normalizeAttributes(attributes));
  }

  recordException(span: api.Span, error: Error): void {
    span.recordException(error);
    span.setStatus({
      code: api.SpanStatusCode.ERROR,
      message: error.message,
    });
  }

  async flush(): Promise<void> {
    await this.provider.forceFlush();
  }

  async shutdown(): Promise<void> {
    await this.provider.shutdown();
  }

  isEnabled(): boolean {
    return this.config.enabled && !!this.config.apiKey;
  }

  shouldSample(): boolean {
    return Math.random() < this.config.sampleRate;
  }

  getTracer(): api.Tracer {
    return this.tracer;
  }

  private normalizeAttributes(attributes: Record<string, any>): Record<string, api.AttributeValue> {
    const normalized: Record<string, api.AttributeValue> = {};
    for (const [key, value] of Object.entries(attributes)) {
      if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      ) {
        normalized[key] = value;
      } else if (Array.isArray(value)) {
        normalized[key] = value.map(String);
      } else {
        normalized[key] = String(value);
      }
    }
    return normalized;
  }
}

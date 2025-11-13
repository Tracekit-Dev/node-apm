import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import * as api from '@opentelemetry/api';
import { SnapshotClient } from './snapshot-client';

export interface TracekitConfig {
  apiKey: string;
  endpoint?: string;
  serviceName?: string;
  enabled?: boolean;
  sampleRate?: number;
  enableCodeMonitoring?: boolean;
}

export class TracekitClient {
  private provider: NodeTracerProvider;
  private tracer: api.Tracer;
  private config: Required<TracekitConfig>;
  private snapshotClient?: SnapshotClient;

  constructor(config: TracekitConfig) {
    this.config = {
      endpoint: config.endpoint || 'https://app.tracekit.dev/v1/traces',
      serviceName: config.serviceName || 'node-app',
      enabled: config.enabled ?? true,
      sampleRate: config.sampleRate ?? 1.0,
      enableCodeMonitoring: config.enableCodeMonitoring ?? false,
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

    // Initialize snapshot client if enabled
    if (this.config.enableCodeMonitoring) {
      this.snapshotClient = new SnapshotClient(
        this.config.apiKey,
        this.config.endpoint.replace('/v1/traces', ''),
        this.config.serviceName
      );
      this.snapshotClient.start();
    }
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
    // Format stack trace for code discovery BEFORE recording exception
    let formattedStackTrace = '';
    if (error.stack) {
      formattedStackTrace = this.formatStackTrace(error.stack);
    }
    
    // Record exception as an event with formatted stack trace
    span.addEvent('exception', {
      'exception.type': error.constructor.name,
      'exception.message': error.message,
      'exception.stacktrace': formattedStackTrace, // For code discovery
    });
    
    // Also use standard OpenTelemetry exception recording
    span.recordException(error);
    
    span.setStatus({
      code: api.SpanStatusCode.ERROR,
      message: error.message,
    });
  }

  // Format stack trace for code discovery
  private formatStackTrace(stack: string): string {
    const lines = stack.split('\n');
    const formatted: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      // Skip the error message line (first line)
      if (i === 0 && !line.startsWith('at ')) {
        continue;
      }

      // Parse Node.js stack trace format: "at FunctionName (file:line:col)" or "at file:line:col"
      const match = line.match(/at\s+(?:([^\s]+)\s+\()?([^:]+):(\d+):\d+\)?/);
      
      if (match) {
        const functionName = match[1] || '';
        const file = match[2];
        const lineNumber = match[3];
        
        // Format as "function at file:line" (consistent with PHP/Laravel)
        if (functionName && functionName !== 'anonymous') {
          formatted.push(`${functionName} at ${file}:${lineNumber}`);
        } else {
          formatted.push(`${file}:${lineNumber}`);
        }
      }
    }

    return formatted.join('\n');
  }

  async flush(): Promise<void> {
    await this.provider.forceFlush();
  }

  async shutdown(): Promise<void> {
    // Stop snapshot client first
    if (this.snapshotClient) {
      this.snapshotClient.stop();
    }

    // Shutdown tracing provider
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

  // Expose snapshot client
  getSnapshotClient(): SnapshotClient | undefined {
    return this.snapshotClient;
  }

  // Convenience method for capturing snapshots
  async captureSnapshot(label: string, variables: Record<string, any> = {}): Promise<void> {
    if (this.snapshotClient) {
      await this.snapshotClient.checkAndCaptureWithContext(label, variables);
    }
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

import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  SpanProcessor,
  ReadableSpan,
} from '@opentelemetry/sdk-trace-node';
import * as api from '@opentelemetry/api';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch';
import { SnapshotClient } from './snapshot-client';
import * as https from 'https';
import * as http from 'http';

/**
 * Span processor that sends traces to TraceKit Local UI in development mode
 */
class LocalUISpanProcessor implements SpanProcessor {
  private localUIAvailable: boolean = false;
  private checkedHealth: boolean = false;
  private batchedSpans: ReadableSpan[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private readonly LOCAL_UI_URL = 'http://localhost:9999';
  private readonly BATCH_TIMEOUT_MS = 1000;
  private readonly MAX_BATCH_SIZE = 100;

  async detectLocalUI(): Promise<boolean> {
    if (this.checkedHealth) {
      return this.localUIAvailable;
    }

    return new Promise((resolve) => {
      const req = http.request(
        `${this.LOCAL_UI_URL}/api/health`,
        {
          method: 'GET',
          timeout: 500,
        },
        (res) => {
          this.localUIAvailable = res.statusCode === 200;
          this.checkedHealth = true;
          if (this.localUIAvailable) {
            console.log('🔍 Local UI detected at http://localhost:9999');
          }
          resolve(this.localUIAvailable);
        }
      );

      req.on('error', () => {
        this.localUIAvailable = false;
        this.checkedHealth = true;
        resolve(false);
      });

      req.on('timeout', () => {
        req.destroy();
        this.localUIAvailable = false;
        this.checkedHealth = true;
        resolve(false);
      });

      req.end();
    });
  }

  onStart(span: api.Span): void {
    // No-op
  }

  onEnd(span: ReadableSpan): void {
    // Only process in development mode
    if (process.env.NODE_ENV !== 'development') {
      return;
    }

    // Add to batch
    this.batchedSpans.push(span);

    // If batch is full, send immediately
    if (this.batchedSpans.length >= this.MAX_BATCH_SIZE) {
      this.flushBatch();
    } else if (!this.batchTimer) {
      // Schedule batch send
      this.batchTimer = setTimeout(() => {
        this.flushBatch();
      }, this.BATCH_TIMEOUT_MS);
    }
  }

  private async flushBatch(): Promise<void> {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    if (this.batchedSpans.length === 0) {
      return;
    }

    // Check if local UI is available
    const isAvailable = await this.detectLocalUI();
    if (!isAvailable) {
      this.batchedSpans = [];
      return;
    }

    // Convert spans to OTLP format
    const resourceSpans = this.convertSpansToOTLP(this.batchedSpans);
    const payload = JSON.stringify(resourceSpans);
    this.batchedSpans = [];

    // Send to local UI (fire and forget)
    this.sendToLocalUI(payload);
  }

  private sendToLocalUI(payload: string): void {
    const req = http.request(
      `${this.LOCAL_UI_URL}/v1/traces`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 1000,
      },
      (res) => {
        // Consume response to free up socket
        res.resume();
      }
    );

    req.on('error', () => {
      // Silently fail if local UI is not available
    });

    req.on('timeout', () => {
      req.destroy();
    });

    req.write(payload);
    req.end();
  }

  private convertSpansToOTLP(spans: ReadableSpan[]): any {
    // Group spans by resource
    const resourceSpansMap = new Map<string, any>();

    for (const span of spans) {
      const resourceKey = JSON.stringify(span.resource.attributes);

      if (!resourceSpansMap.has(resourceKey)) {
        resourceSpansMap.set(resourceKey, {
          resource: {
            attributes: this.convertAttributes(span.resource.attributes),
          },
          scopeSpans: [],
        });
      }

      const resourceSpans = resourceSpansMap.get(resourceKey);

      // Find or create scope spans
      let scopeSpan = resourceSpans.scopeSpans.find(
        (ss: any) => ss.scope?.name === span.instrumentationLibrary.name
      );

      if (!scopeSpan) {
        scopeSpan = {
          scope: {
            name: span.instrumentationLibrary.name,
            version: span.instrumentationLibrary.version,
          },
          spans: [],
        };
        resourceSpans.scopeSpans.push(scopeSpan);
      }

      // Add span
      scopeSpan.spans.push(this.convertSpan(span));
    }

    return {
      resourceSpans: Array.from(resourceSpansMap.values()),
    };
  }

  private convertSpan(span: ReadableSpan): any {
    return {
      traceId: span.spanContext().traceId,
      spanId: span.spanContext().spanId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      kind: span.kind,
      startTimeUnixNano: String(span.startTime[0] * 1e9 + span.startTime[1]),
      endTimeUnixNano: String(span.endTime[0] * 1e9 + span.endTime[1]),
      attributes: this.convertAttributes(span.attributes),
      events: span.events.map((event) => ({
        timeUnixNano: String(event.time[0] * 1e9 + event.time[1]),
        name: event.name,
        attributes: this.convertAttributes(event.attributes || {}),
      })),
      status: {
        code: span.status.code,
        message: span.status.message,
      },
    };
  }

  private convertAttributes(attributes: any): any[] {
    return Object.entries(attributes).map(([key, value]) => ({
      key,
      value: this.convertValue(value),
    }));
  }

  private convertValue(value: any): any {
    if (typeof value === 'string') {
      return { stringValue: value };
    } else if (typeof value === 'number') {
      if (Number.isInteger(value)) {
        return { intValue: String(value) };
      }
      return { doubleValue: value };
    } else if (typeof value === 'boolean') {
      return { boolValue: value };
    } else if (Array.isArray(value)) {
      return {
        arrayValue: {
          values: value.map((v) => this.convertValue(v)),
        },
      };
    }
    return { stringValue: String(value) };
  }

  async forceFlush(): Promise<void> {
    await this.flushBatch();
  }

  async shutdown(): Promise<void> {
    await this.flushBatch();
  }
}

export interface TracekitConfig {
  apiKey: string;
  endpoint?: string;
  serviceName?: string;
  enabled?: boolean;
  sampleRate?: number;
  enableCodeMonitoring?: boolean;
  autoInstrumentHttpClient?: boolean;
  /**
   * Map hostnames to service names for peer.service attribute
   * Useful for mapping localhost URLs to actual service names
   * Example: { 'localhost:8082': 'go-test-app', 'localhost:8084': 'node-test-app' }
   */
  serviceNameMappings?: Record<string, string>;
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
      autoInstrumentHttpClient: config.autoInstrumentHttpClient ?? true,
      apiKey: config.apiKey,
      serviceNameMappings: config.serviceNameMappings ?? {},
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
      // Configure OTLP exporter for cloud
      const exporter = new OTLPTraceExporter({
        url: this.config.endpoint,
        headers: {
          'X-API-Key': this.config.apiKey,
        },
      });

      // Use batch processor for better performance
      this.provider.addSpanProcessor(new BatchSpanProcessor(exporter));

      // Add local UI processor in development mode
      if (process.env.NODE_ENV === 'development') {
        this.provider.addSpanProcessor(new LocalUISpanProcessor());
      }

      // Register the provider
      this.provider.register();

      // Auto-instrument HTTP clients for CLIENT span creation
      if (this.config.autoInstrumentHttpClient) {
        registerInstrumentations({
          tracerProvider: this.provider,
          instrumentations: [
            // Auto-instrument http/https modules
            new HttpInstrumentation({
              requireParentforOutgoingSpans: true,
              requireParentforIncomingSpans: false,
              requestHook: (span, request) => {
                // Extract service name from URL and set peer.service for outgoing requests
                // ClientRequest has hostname/host properties
                if ('hostname' in request || 'host' in request) {
                  const hostname = (request as any).hostname || (request as any).host;
                  if (hostname) {
                    const serviceName = this.extractServiceName(hostname);
                    span.setAttribute('peer.service', serviceName);
                  }
                }
              },
            }),
            // Auto-instrument fetch API (Node 18+)
            new FetchInstrumentation({}),
          ],
        });
      }
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

  /**
   * Start a SERVER span, properly inheriting from the active context
   * This is used by middleware to create spans that are children of incoming trace context
   */
  startServerSpan(operationName: string, attributes: Record<string, any> = {}): api.Span {
    return this.tracer.startSpan(
      operationName,
      {
        kind: api.SpanKind.SERVER,
        attributes: this.normalizeAttributes(attributes),
      },
      api.context.active() // Use active context which includes parent from traceparent
    );
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

  private extractServiceName(hostname: string): string {
    // First, check if there's a configured mapping for this hostname
    // This allows mapping localhost:port to actual service names
    if (this.config.serviceNameMappings[hostname]) {
      return this.config.serviceNameMappings[hostname];
    }

    // Also check without port
    const hostWithoutPort = hostname.split(':')[0];
    if (this.config.serviceNameMappings[hostWithoutPort]) {
      return this.config.serviceNameMappings[hostWithoutPort];
    }

    // Extract service name from hostname for service-to-service mapping
    // Examples:
    //   "payment-service" -> "payment-service"
    //   "payment.internal.svc.cluster.local" -> "payment"
    //   "api.example.com" -> "api.example.com"

    if (hostname.includes('.svc.cluster.local')) {
      // Kubernetes service: payment.internal.svc.cluster.local -> payment
      return hostname.split('.')[0];
    }

    if (hostname.includes('.internal')) {
      // Internal service: payment.internal -> payment
      return hostname.split('.')[0];
    }

    // Default: use full hostname (strip port if present)
    return hostWithoutPort;
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

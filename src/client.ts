import axios, { AxiosInstance } from 'axios';

export interface TracekitConfig {
  apiKey: string;
  endpoint?: string;
  serviceName?: string;
  enabled?: boolean;
  sampleRate?: number;
}

export interface SpanAttributes {
  [key: string]: string | number | boolean;
}

interface Span {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: string;
  startTime: bigint;
  endTime: bigint | null;
  attributes: SpanAttributes;
  status: string;
  events: Array<{
    name: string;
    timestamp: bigint;
    attributes: SpanAttributes;
  }>;
}

export class TracekitClient {
  private httpClient: AxiosInstance;
  private config: Required<TracekitConfig>;
  private currentSpans: Map<string, Span> = new Map();
  private currentTraceId: string | null = null;
  private rootSpanId: string | null = null;

  constructor(config: TracekitConfig) {
    this.config = {
      endpoint: config.endpoint || 'https://tracekit.dev/v1/traces',
      serviceName: config.serviceName || 'node-app',
      enabled: config.enabled ?? true,
      sampleRate: config.sampleRate ?? 1.0,
      apiKey: config.apiKey,
    };

    this.httpClient = axios.create({
      baseURL: this.config.endpoint,
      timeout: 5000,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': this.config.apiKey,
      },
    });
  }

  startTrace(operationName: string, attributes: SpanAttributes = {}): string {
    this.currentTraceId = this.generateId(16);
    this.rootSpanId = this.generateId(8);

    const span: Span = {
      traceId: this.currentTraceId,
      spanId: this.rootSpanId,
      parentSpanId: null,
      name: operationName,
      kind: 'SERVER',
      startTime: this.currentTimeNanos(),
      endTime: null,
      attributes: {
        ...attributes,
        'service.name': this.config.serviceName,
      },
      status: 'UNSET',
      events: [],
    };

    this.currentSpans.set(this.rootSpanId, span);
    return this.rootSpanId;
  }

  startSpan(
    operationName: string,
    parentSpanId: string | null = null,
    attributes: SpanAttributes = {}
  ): string {
    if (!this.currentTraceId) {
      return this.startTrace(operationName, attributes);
    }

    const spanId = this.generateId(8);
    const parent = parentSpanId || this.rootSpanId;

    const span: Span = {
      traceId: this.currentTraceId,
      spanId,
      parentSpanId: parent,
      name: operationName,
      kind: 'INTERNAL',
      startTime: this.currentTimeNanos(),
      endTime: null,
      attributes: {
        ...attributes,
        'service.name': this.config.serviceName,
      },
      status: 'UNSET',
      events: [],
    };

    this.currentSpans.set(spanId, span);
    return spanId;
  }

  endSpan(
    spanId: string,
    finalAttributes: SpanAttributes = {},
    status: string = 'OK'
  ): void {
    const span = this.currentSpans.get(spanId);
    if (!span) return;

    span.endTime = this.currentTimeNanos();
    span.status = status;
    span.attributes = { ...span.attributes, ...finalAttributes };
  }

  addEvent(spanId: string, name: string, attributes: SpanAttributes = {}): void {
    const span = this.currentSpans.get(spanId);
    if (!span) return;

    span.events.push({
      name,
      timestamp: this.currentTimeNanos(),
      attributes,
    });
  }

  recordException(spanId: string, error: Error): void {
    const span = this.currentSpans.get(spanId);
    if (!span) return;

    span.status = 'ERROR';
    span.events.push({
      name: 'exception',
      timestamp: this.currentTimeNanos(),
      attributes: {
        'exception.type': error.name,
        'exception.message': error.message,
        'exception.stacktrace': error.stack || '',
      },
    });
  }

  async flush(): Promise<void> {
    if (this.currentSpans.size === 0) return;

    try {
      const payload = this.buildOTLPPayload();

      await this.httpClient.post('', payload);
    } catch (error) {
      console.warn('TraceKit: Failed to send traces', error);
    } finally {
      this.currentSpans.clear();
      this.currentTraceId = null;
      this.rootSpanId = null;
    }
  }

  isEnabled(): boolean {
    return this.config.enabled && !!this.config.apiKey;
  }

  shouldSample(): boolean {
    return Math.random() < this.config.sampleRate;
  }

  getCurrentTraceId(): string | null {
    return this.currentTraceId;
  }

  getRootSpanId(): string | null {
    return this.rootSpanId;
  }

  private buildOTLPPayload(): any {
    const spans = Array.from(this.currentSpans.values()).map((span) => ({
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      kind: span.kind,
      startTimeUnixNano: span.startTime.toString(),
      endTimeUnixNano: (span.endTime || this.currentTimeNanos()).toString(),
      attributes: this.formatAttributes(span.attributes),
      status: {
        code: span.status === 'OK' ? 1 : span.status === 'ERROR' ? 2 : 0,
      },
      events: span.events.map((event) => ({
        name: event.name,
        timeUnixNano: event.timestamp.toString(),
        attributes: this.formatAttributes(event.attributes),
      })),
    }));

    return {
      resourceSpans: [
        {
          resource: {
            attributes: this.formatAttributes({
              'service.name': this.config.serviceName,
            }),
          },
          scopeSpans: [
            {
              scope: {
                name: '@tracekit/node-apm',
                version: '1.0.0',
              },
              spans,
            },
          ],
        },
      ],
    };
  }

  private formatAttributes(attributes: SpanAttributes): any[] {
    return Object.entries(attributes).map(([key, value]) => ({
      key,
      value: this.formatValue(value),
    }));
  }

  private formatValue(value: string | number | boolean): any {
    if (typeof value === 'string') {
      return { stringValue: value };
    } else if (typeof value === 'number') {
      return Number.isInteger(value)
        ? { intValue: value }
        : { doubleValue: value };
    } else if (typeof value === 'boolean') {
      return { boolValue: value };
    }
    return { stringValue: String(value) };
  }

  private generateId(bytes: number): string {
    const hex = '0123456789abcdef';
    let result = '';
    for (let i = 0; i < bytes * 2; i++) {
      result += hex[Math.floor(Math.random() * 16)];
    }
    return result;
  }

  private currentTimeNanos(): bigint {
    const [seconds, nanos] = process.hrtime();
    return BigInt(seconds) * BigInt(1_000_000_000) + BigInt(nanos);
  }
}

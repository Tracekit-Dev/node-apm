import { MetricsExporter } from './metrics-exporter';

export interface MetricDataPoint {
  name: string;
  tags: Record<string, string>;
  value: number;
  timestamp: number; // milliseconds
  type: 'counter' | 'gauge' | 'histogram';
}

/**
 * MetricsBuffer collects metrics and flushes them periodically
 */
export class MetricsBuffer {
  private data: MetricDataPoint[] = [];
  private exporter: MetricsExporter;
  private flushTimer?: NodeJS.Timeout;
  private readonly maxSize = 100;
  private readonly flushInterval = 10000; // 10 seconds
  private isShuttingDown = false;

  constructor(endpoint: string, apiKey: string, serviceName: string) {
    this.exporter = new MetricsExporter(endpoint, apiKey, serviceName);
  }

  start(): void {
    this.scheduleFlush();
  }

  add(dataPoint: MetricDataPoint): void {
    if (this.isShuttingDown) {
      return;
    }

    this.data.push(dataPoint);

    // Flush immediately if buffer is full
    if (this.data.length >= this.maxSize) {
      this.flush();
    }
  }

  private scheduleFlush(): void {
    if (this.isShuttingDown) {
      return;
    }

    this.flushTimer = setTimeout(() => {
      this.flush();
      this.scheduleFlush();
    }, this.flushInterval);
  }

  private async flush(): Promise<void> {
    if (this.data.length === 0) {
      return;
    }

    const toExport = this.data;
    this.data = [];

    try {
      await this.exporter.export(toExport);
    } catch (error) {
      // Log error but don't crash
      console.error('Failed to export metrics:', error);
    }
  }

  async shutdown(): Promise<void> {
    this.isShuttingDown = true;

    // Clear scheduled flush
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }

    // Final flush
    await this.flush();
  }
}

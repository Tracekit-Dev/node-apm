import { MetricsBuffer, MetricDataPoint } from './metrics-buffer';

/**
 * Counter tracks monotonically increasing values
 */
export interface Counter {
  inc(): void;
  add(value: number): void;
}

/**
 * Gauge tracks point-in-time values
 */
export interface Gauge {
  set(value: number): void;
  inc(): void;
  dec(): void;
}

/**
 * Histogram tracks value distributions
 */
export interface Histogram {
  record(value: number): void;
}

/**
 * Internal Counter implementation
 */
class CounterImpl implements Counter {
  constructor(
    private name: string,
    private tags: Record<string, string>,
    private buffer: MetricsBuffer
  ) {}

  inc(): void {
    this.add(1);
  }

  add(value: number): void {
    if (value < 0) {
      return; // Counters must be monotonic
    }

    this.buffer.add({
      name: this.name,
      tags: this.tags,
      value,
      timestamp: Date.now(),
      type: 'counter',
    });
  }
}

/**
 * Internal Gauge implementation
 */
class GaugeImpl implements Gauge {
  private value: number = 0;

  constructor(
    private name: string,
    private tags: Record<string, string>,
    private buffer: MetricsBuffer
  ) {}

  set(value: number): void {
    this.value = value;
    this.buffer.add({
      name: this.name,
      tags: this.tags,
      value,
      timestamp: Date.now(),
      type: 'gauge',
    });
  }

  inc(): void {
    this.value++;
    this.buffer.add({
      name: this.name,
      tags: this.tags,
      value: this.value,
      timestamp: Date.now(),
      type: 'gauge',
    });
  }

  dec(): void {
    this.value--;
    this.buffer.add({
      name: this.name,
      tags: this.tags,
      value: this.value,
      timestamp: Date.now(),
      type: 'gauge',
    });
  }
}

/**
 * Internal Histogram implementation
 */
class HistogramImpl implements Histogram {
  constructor(
    private name: string,
    private tags: Record<string, string>,
    private buffer: MetricsBuffer
  ) {}

  record(value: number): void {
    this.buffer.add({
      name: this.name,
      tags: this.tags,
      value,
      timestamp: Date.now(),
      type: 'histogram',
    });
  }
}

/**
 * MetricsRegistry manages all metrics
 */
export class MetricsRegistry {
  private counters = new Map<string, CounterImpl>();
  private gauges = new Map<string, GaugeImpl>();
  private histograms = new Map<string, HistogramImpl>();
  private buffer: MetricsBuffer;

  constructor(endpoint: string, apiKey: string, serviceName: string) {
    this.buffer = new MetricsBuffer(endpoint, apiKey, serviceName);
    this.buffer.start();
  }

  counter(name: string, tags: Record<string, string> = {}): Counter {
    const key = this.metricKey(name, tags);

    let counter = this.counters.get(key);
    if (!counter) {
      counter = new CounterImpl(name, { ...tags }, this.buffer);
      this.counters.set(key, counter);
    }

    return counter;
  }

  gauge(name: string, tags: Record<string, string> = {}): Gauge {
    const key = this.metricKey(name, tags);

    let gauge = this.gauges.get(key);
    if (!gauge) {
      gauge = new GaugeImpl(name, { ...tags }, this.buffer);
      this.gauges.set(key, gauge);
    }

    return gauge;
  }

  histogram(name: string, tags: Record<string, string> = {}): Histogram {
    const key = this.metricKey(name, tags);

    let histogram = this.histograms.get(key);
    if (!histogram) {
      histogram = new HistogramImpl(name, { ...tags }, this.buffer);
      this.histograms.set(key, histogram);
    }

    return histogram;
  }

  async shutdown(): Promise<void> {
    await this.buffer.shutdown();
  }

  private metricKey(name: string, tags: Record<string, string>): string {
    if (Object.keys(tags).length === 0) {
      return name;
    }

    // Simple key format: name{k1=v1,k2=v2}
    const tagPairs = Object.entries(tags)
      .sort(([a], [b]) => a.localeCompare(b)) // Sort for consistency
      .map(([k, v]) => `${k}=${v}`)
      .join(',');

    return `${name}{${tagPairs}}`;
  }
}

/**
 * No-op implementations for when metrics are disabled
 */
class NoopCounter implements Counter {
  inc(): void {}
  add(_value: number): void {}
}

class NoopGauge implements Gauge {
  set(_value: number): void {}
  inc(): void {}
  dec(): void {}
}

class NoopHistogram implements Histogram {
  record(_value: number): void {}
}

export const noopCounter = new NoopCounter();
export const noopGauge = new NoopGauge();
export const noopHistogram = new NoopHistogram();

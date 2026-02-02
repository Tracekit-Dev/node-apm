import * as https from 'https';
import * as http from 'http';
import { MetricDataPoint } from './metrics-buffer';

/**
 * MetricsExporter sends metrics to the backend in OTLP format
 */
export class MetricsExporter {
  private endpoint: string;
  private apiKey: string;
  private serviceName: string;

  constructor(endpoint: string, apiKey: string, serviceName: string) {
    this.endpoint = endpoint;
    this.apiKey = apiKey;
    this.serviceName = serviceName;
  }

  async export(dataPoints: MetricDataPoint[]): Promise<void> {
    if (dataPoints.length === 0) {
      return;
    }

    const payload = this.toOTLP(dataPoints);
    const body = JSON.stringify(payload);

    return new Promise((resolve, reject) => {
      const url = new URL(this.endpoint);
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;

      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-API-Key': this.apiKey,
        },
      };

      const req = lib.request(options, (res) => {
        res.resume(); // Consume response

        if (res.statusCode === 200) {
          resolve();
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.write(body);
      req.end();
    });
  }

  private toOTLP(dataPoints: MetricDataPoint[]): any {
    // Group by name and type
    const grouped = new Map<string, MetricDataPoint[]>();

    for (const dp of dataPoints) {
      const key = `${dp.name}:${dp.type}`;
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push(dp);
    }

    // Build metrics array
    const metrics: any[] = [];

    for (const [key, dps] of grouped.entries()) {
      const [name, type] = key.split(':');

      // Convert data points
      const otlpDataPoints = dps.map((dp) => ({
        attributes: Object.entries(dp.tags).map(([k, v]) => ({
          key: k,
          value: { stringValue: v },
        })),
        timeUnixNano: String(dp.timestamp * 1_000_000), // Convert ms to ns
        asDouble: dp.value,
      }));

      // Create metric based on type
      let metric: any;
      if (type === 'counter') {
        metric = {
          name,
          sum: {
            dataPoints: otlpDataPoints,
            aggregationTemporality: 2, // DELTA
            isMonotonic: true,
          },
        };
      } else {
        // gauge or histogram
        metric = {
          name,
          gauge: {
            dataPoints: otlpDataPoints,
          },
        };
      }

      metrics.push(metric);
    }

    return {
      resourceMetrics: [
        {
          resource: {
            attributes: [
              {
                key: 'service.name',
                value: {
                  stringValue: this.serviceName,
                },
              },
            ],
          },
          scopeMetrics: [
            {
              scope: {
                name: 'tracekit',
              },
              metrics,
            },
          ],
        },
      ],
    };
  }
}

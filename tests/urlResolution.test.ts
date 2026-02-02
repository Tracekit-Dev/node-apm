import { resolveEndpoint, extractBaseURL } from '../src/client';

describe('resolveEndpoint', () => {
  // Just host cases
  it('should resolve just host with SSL', () => {
    const result = resolveEndpoint('app.tracekit.dev', '/v1/traces', true);
    expect(result).toBe('https://app.tracekit.dev/v1/traces');
  });

  it('should resolve just host without SSL', () => {
    const result = resolveEndpoint('localhost:8081', '/v1/traces', false);
    expect(result).toBe('http://localhost:8081/v1/traces');
  });

  it('should resolve just host with trailing slash', () => {
    const result = resolveEndpoint('app.tracekit.dev/', '/v1/metrics', true);
    expect(result).toBe('https://app.tracekit.dev/v1/metrics');
  });

  // Host with scheme cases
  it('should resolve http with host only', () => {
    const result = resolveEndpoint('http://localhost:8081', '/v1/traces', true);
    expect(result).toBe('http://localhost:8081/v1/traces');
  });

  it('should resolve https with host only', () => {
    const result = resolveEndpoint('https://app.tracekit.dev', '/v1/metrics', false);
    expect(result).toBe('https://app.tracekit.dev/v1/metrics');
  });

  it('should resolve http with host and trailing slash', () => {
    const result = resolveEndpoint('http://localhost:8081/', '/v1/traces', true);
    expect(result).toBe('http://localhost:8081/v1/traces');
  });

  // Full URL cases
  it('should resolve full URL with standard path', () => {
    const result = resolveEndpoint('http://localhost:8081/v1/traces', '/v1/traces', true);
    expect(result).toBe('http://localhost:8081/v1/traces');
  });

  it('should resolve full URL with custom path', () => {
    const result = resolveEndpoint('http://localhost:8081/custom/path', '/v1/traces', true);
    expect(result).toBe('http://localhost:8081/custom/path');
  });

  it('should resolve full URL with trailing slash', () => {
    const result = resolveEndpoint('https://app.tracekit.dev/api/v2/', '/v1/traces', false);
    expect(result).toBe('https://app.tracekit.dev/api/v2');
  });

  // Edge cases
  it('should resolve empty path for snapshots', () => {
    const result = resolveEndpoint('app.tracekit.dev', '', true);
    expect(result).toBe('https://app.tracekit.dev');
  });

  it('should resolve http with empty path', () => {
    const result = resolveEndpoint('http://localhost:8081', '', true);
    expect(result).toBe('http://localhost:8081');
  });

  it('should resolve http with trailing slash and empty path', () => {
    const result = resolveEndpoint('http://localhost:8081/', '', true);
    expect(result).toBe('http://localhost:8081');
  });

  it('should extract base from full URL for snapshots (http)', () => {
    const result = resolveEndpoint('http://localhost:8081/v1/traces', '', true);
    expect(result).toBe('http://localhost:8081');
  });

  it('should extract base from full URL for snapshots (https)', () => {
    const result = resolveEndpoint('https://app.tracekit.dev/v1/traces', '', false);
    expect(result).toBe('https://app.tracekit.dev');
  });
});

describe('extractBaseURL', () => {
  it('should extract base URL from traces endpoint (http)', () => {
    const result = extractBaseURL('http://localhost:8081/v1/traces');
    expect(result).toBe('http://localhost:8081');
  });

  it('should extract base URL from traces endpoint (https)', () => {
    const result = extractBaseURL('https://app.tracekit.dev/v1/traces');
    expect(result).toBe('https://app.tracekit.dev');
  });

  it('should extract base URL from metrics endpoint', () => {
    const result = extractBaseURL('https://app.tracekit.dev/v1/metrics');
    expect(result).toBe('https://app.tracekit.dev');
  });

  it('should keep custom path URLs as-is', () => {
    const result = extractBaseURL('http://localhost:8081/custom');
    expect(result).toBe('http://localhost:8081/custom');
  });

  it('should keep custom base path URLs as-is', () => {
    const result = extractBaseURL('http://localhost:8081/api');
    expect(result).toBe('http://localhost:8081/api');
  });

  it('should extract from api/v1/traces path', () => {
    const result = extractBaseURL('https://app.tracekit.dev/api/v1/traces');
    expect(result).toBe('https://app.tracekit.dev');
  });

  it('should extract from api/v1/metrics path', () => {
    const result = extractBaseURL('https://app.tracekit.dev/api/v1/metrics');
    expect(result).toBe('https://app.tracekit.dev');
  });

  it('should return as-is when no path component', () => {
    const result = extractBaseURL('https://app.tracekit.dev');
    expect(result).toBe('https://app.tracekit.dev');
  });

  it('should return as-is when no scheme', () => {
    const result = extractBaseURL('app.tracekit.dev/v1/traces');
    expect(result).toBe('app.tracekit.dev/v1/traces');
  });
});

describe('Endpoint Resolution Integration Tests', () => {
  interface TestConfig {
    endpoint: string;
    tracesPath?: string;
    metricsPath?: string;
    useSSL: boolean;
  }

  interface ExpectedEndpoints {
    traces: string;
    metrics: string;
    snapshots: string;
  }

  const testCases: Array<{
    name: string;
    config: TestConfig;
    expected: ExpectedEndpoints;
  }> = [
    {
      name: 'default production config',
      config: {
        endpoint: 'app.tracekit.dev',
        useSSL: true,
      },
      expected: {
        traces: 'https://app.tracekit.dev/v1/traces',
        metrics: 'https://app.tracekit.dev/v1/metrics',
        snapshots: 'https://app.tracekit.dev',
      },
    },
    {
      name: 'local development',
      config: {
        endpoint: 'localhost:8080',
        useSSL: false,
      },
      expected: {
        traces: 'http://localhost:8080/v1/traces',
        metrics: 'http://localhost:8080/v1/metrics',
        snapshots: 'http://localhost:8080',
      },
    },
    {
      name: 'custom paths',
      config: {
        endpoint: 'app.tracekit.dev',
        tracesPath: '/api/v2/traces',
        metricsPath: '/api/v2/metrics',
        useSSL: true,
      },
      expected: {
        traces: 'https://app.tracekit.dev/api/v2/traces',
        metrics: 'https://app.tracekit.dev/api/v2/metrics',
        snapshots: 'https://app.tracekit.dev',
      },
    },
    {
      name: 'full URLs provided',
      config: {
        endpoint: 'http://localhost:8081/custom',
        useSSL: true, // Should be ignored
      },
      expected: {
        traces: 'http://localhost:8081/custom',
        metrics: 'http://localhost:8081/custom',
        snapshots: 'http://localhost:8081/custom',
      },
    },
    {
      name: 'trailing slash handling',
      config: {
        endpoint: 'http://localhost:8081/',
        useSSL: false,
      },
      expected: {
        traces: 'http://localhost:8081/v1/traces',
        metrics: 'http://localhost:8081/v1/metrics',
        snapshots: 'http://localhost:8081',
      },
    },
    {
      name: 'full URL with path - snapshots extract base',
      config: {
        endpoint: 'http://localhost:8081/v1/traces',
        useSSL: true, // Should be ignored
      },
      expected: {
        traces: 'http://localhost:8081/v1/traces',
        metrics: 'http://localhost:8081/v1/traces',
        snapshots: 'http://localhost:8081', // Should extract base URL
      },
    },
  ];

  testCases.forEach(({ name, config, expected }) => {
    it(`should handle: ${name}`, () => {
      // Set defaults like SDK does
      const tracesPath = config.tracesPath || '/v1/traces';
      const metricsPath = config.metricsPath || '/v1/metrics';

      // Resolve endpoints
      const tracesEndpoint = resolveEndpoint(config.endpoint, tracesPath, config.useSSL);
      const metricsEndpoint = resolveEndpoint(config.endpoint, metricsPath, config.useSSL);
      const snapshotEndpoint = resolveEndpoint(config.endpoint, '', config.useSSL);

      expect(tracesEndpoint).toBe(expected.traces);
      expect(metricsEndpoint).toBe(expected.metrics);
      expect(snapshotEndpoint).toBe(expected.snapshots);
    });
  });
});

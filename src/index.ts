import { TracekitClient, TracekitConfig } from './client';
import { createExpressMiddleware } from './middleware/express';
import { SnapshotClient } from './snapshot-client';

let globalClient: TracekitClient | null = null;

/**
 * Initialize TraceKit APM
 */
export function init(config: TracekitConfig): TracekitClient {
  globalClient = new TracekitClient(config);
  return globalClient;
}

/**
 * Get Express middleware
 */
export function middleware() {
  if (!globalClient) {
    throw new Error(
      'TraceKit not initialized. Call tracekit.init() first.'
    );
  }
  return createExpressMiddleware(globalClient, globalClient.getSnapshotClient());
}

/**
 * Get the global client instance
 */
export function getClient(): TracekitClient {
  if (!globalClient) {
    throw new Error(
      'TraceKit not initialized. Call tracekit.init() first.'
    );
  }
  return globalClient;
}

// Export types
export { TracekitClient, TracekitConfig } from './client';
export { SnapshotClient } from './snapshot-client';
export { createExpressMiddleware, getCurrentSpan } from './middleware/express';

// Re-export OpenTelemetry types for convenience
export { Span, Context } from '@opentelemetry/api';

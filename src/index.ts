import { TracekitClient, TracekitConfig } from './client';
import { createExpressMiddleware } from './middleware/express';

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
  return createExpressMiddleware(globalClient);
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
export { TracekitClient, TracekitConfig, SpanAttributes } from './client';
export { createExpressMiddleware } from './middleware/express';

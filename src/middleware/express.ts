import { AsyncLocalStorage } from 'async_hooks';
import { Request, Response, NextFunction } from 'express';
import { TracekitClient } from '../client';
import { SnapshotClient } from '../snapshot-client';
import * as api from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

// AsyncLocalStorage for request context
const requestContextStorage = new AsyncLocalStorage<Record<string, any>>();

// W3C Trace Context propagator for extracting traceparent header
const propagator = new W3CTraceContextPropagator();

export function createExpressMiddleware(client: TracekitClient, snapshotClient?: SnapshotClient) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Check if tracing is enabled
    if (!client.isEnabled() || !client.shouldSample()) {
      return next();
    }

    const startTime = Date.now();

    // Get operation name from route
    const operationName = getOperationName(req);

    // Extract trace context from incoming request headers (W3C Trace Context)
    // This enables distributed tracing - the span will be linked to the parent trace
    const parentContext = propagator.extract(
      api.context.active(),
      req.headers,
      {
        get(carrier: any, key: string): string | undefined {
          return carrier[key.toLowerCase()];
        },
        keys(carrier: any): string[] {
          return Object.keys(carrier);
        },
      }
    );

    // Start trace within the parent context (if any)
    // This ensures the new span is a child of the incoming trace
    const span = api.context.with(parentContext, () => {
      return client.startServerSpan(operationName, {
        'http.method': req.method,
        'http.url': req.originalUrl || req.url,
        'http.route': (req.route?.path as string) || req.path,
        'http.user_agent': req.get('user-agent') || '',
        'http.client_ip': getClientIp(req),
      });
    });

    // Store span in request for nested spans
    (req as any).__tracekitSpan = span;

    // Extract request context for snapshots
    const requestContext = {
      method: req.method,
      path: req.path,
      url: req.originalUrl,
      ip: getClientIp(req),
      user_agent: req.get('user-agent') || '',
      query: req.query,
      headers: filterHeaders(req.headers),
    };

    // Store in AsyncLocalStorage for snapshot access
    requestContextStorage.run(requestContext, () => {
      // Capture response
      const originalSend = res.send;
      let responseSent = false;

      res.send = function (body: any): Response {
        if (!responseSent) {
          responseSent = true;
          const durationMs = Date.now() - startTime;

          client.endSpan(
            span,
            {
              'http.status_code': res.statusCode,
              'http.duration_ms': durationMs,
            },
            res.statusCode >= 400 ? 'ERROR' : 'OK'
          );
        }

        return originalSend.call(this, body);
      };

      // Handle errors
      try {
        next();
      } catch (error) {
        if (error instanceof Error) {
          client.recordException(span, error);
          client.endSpan(span, {}, 'ERROR');
        }
        throw error;
      }
    });
  };
}

// Helper to get current span from request
export function getCurrentSpan(req: Request): api.Span | null {
  return (req as any).__tracekitSpan || null;
}

// Helper to get request context from any code
export function getRequestContext(): Record<string, any> | undefined {
  return requestContextStorage.getStore();
}

function getOperationName(req: Request): string {
  // Use route name if available
  if (req.route?.path) {
    return `${req.method} ${req.route.path}`;
  }

  // Fall back to path
  return `${req.method} ${req.path}`;
}

/**
 * Extract client IP address from HTTP request.
 * Checks X-Forwarded-For, X-Real-IP headers (for proxied requests)
 * and falls back to socket.remoteAddress.
 *
 * This function is automatically used by the TraceKit middleware to add
 * client IP to all traces for DDoS detection and traffic analysis.
 *
 * @param req - Express Request object
 * @returns Client IP address or empty string if not found
 */
export function getClientIp(req: Request): string {
  return (
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    (req.headers['x-real-ip'] as string) ||
    req.socket.remoteAddress ||
    ''
  );
}

function filterHeaders(headers: any): Record<string, string> {
  const filtered: Record<string, string> = {};
  const allowlist = ['content-type', 'content-length', 'host', 'user-agent', 'referer'];

  for (const key of allowlist) {
    if (headers[key]) {
      filtered[key] = headers[key];
    }
  }

  return filtered;
}

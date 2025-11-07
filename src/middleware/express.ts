import { Request, Response, NextFunction } from 'express';
import { TracekitClient } from '../client';
import * as api from '@opentelemetry/api';

export function createExpressMiddleware(client: TracekitClient) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Check if tracing is enabled
    if (!client.isEnabled() || !client.shouldSample()) {
      return next();
    }

    const startTime = Date.now();

    // Get operation name from route
    const operationName = getOperationName(req);

    // Start trace
    const span = client.startTrace(operationName, {
      'http.method': req.method,
      'http.url': req.originalUrl || req.url,
      'http.route': (req.route?.path as string) || req.path,
      'http.user_agent': req.get('user-agent') || '',
      'http.client_ip': getClientIp(req),
    });

    // Store span in request for nested spans
    (req as any).__tracekitSpan = span;

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
  };
}

// Helper to get current span from request
export function getCurrentSpan(req: Request): api.Span | null {
  return (req as any).__tracekitSpan || null;
}

function getOperationName(req: Request): string {
  // Use route name if available
  if (req.route?.path) {
    return `${req.method} ${req.route.path}`;
  }

  // Fall back to path
  return `${req.method} ${req.path}`;
}

function getClientIp(req: Request): string {
  return (
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    (req.headers['x-real-ip'] as string) ||
    req.socket.remoteAddress ||
    ''
  );
}

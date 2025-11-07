import { Request, Response, NextFunction } from 'express';
import { TracekitClient } from '../client';

export function createExpressMiddleware(client: TracekitClient) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Check if tracing is enabled
    if (!client.isEnabled() || !client.shouldSample()) {
      return next();
    }

    const startTime = process.hrtime();

    // Get operation name from route
    const operationName = getOperationName(req);

    // Start trace
    const spanId = client.startTrace(operationName, {
      'http.method': req.method,
      'http.url': req.originalUrl || req.url,
      'http.route': (req.route?.path as string) || req.path,
      'http.user_agent': req.get('user-agent') || '',
      'http.client_ip': getClientIp(req),
    });

    // Capture response
    const originalSend = res.send;
    let responseSent = false;

    res.send = function (body: any): Response {
      if (!responseSent) {
        responseSent = true;
        const [seconds, nanos] = process.hrtime(startTime);
        const durationMs = seconds * 1000 + nanos / 1_000_000;

        client.endSpan(
          spanId,
          {
            'http.status_code': res.statusCode,
            'http.duration_ms': Math.round(durationMs),
          },
          res.statusCode >= 400 ? 'ERROR' : 'OK'
        );

        // Flush traces asynchronously
        client.flush().catch((err) => {
          console.warn('TraceKit: Failed to flush traces', err);
        });
      }

      return originalSend.call(this, body);
    };

    // Handle errors
    try {
      next();
    } catch (error) {
      if (error instanceof Error) {
        client.recordException(spanId, error);
        client.endSpan(spanId, {}, 'ERROR');
        client.flush().catch(() => {});
      }
      throw error;
    }
  };
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

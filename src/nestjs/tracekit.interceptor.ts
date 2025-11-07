import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Inject,
} from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { TracekitClient } from '../client';

@Injectable()
export class TracekitInterceptor implements NestInterceptor {
  constructor(
    @Inject('TRACEKIT_CLIENT') private readonly client: TracekitClient
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    // Check if HTTP request
    if (context.getType() !== 'http') {
      return next.handle();
    }

    // Check if tracing is enabled
    if (!this.client.isEnabled() || !this.client.shouldSample()) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();

    const startTime = process.hrtime();

    // Get operation name from route
    const handler = context.getHandler().name;
    const controller = context.getClass().name;
    const operationName = `${controller}.${handler}`;

    // Start trace
    const spanId = this.client.startTrace(operationName, {
      'http.method': request.method,
      'http.url': request.url,
      'http.route': request.route?.path || request.url,
      'http.user_agent': request.get('user-agent') || '',
      'http.client_ip': this.getClientIp(request),
      'nestjs.controller': controller,
      'nestjs.handler': handler,
    });

    return next.handle().pipe(
      tap(() => {
        // Success
        const [seconds, nanos] = process.hrtime(startTime);
        const durationMs = seconds * 1000 + nanos / 1_000_000;

        this.client.endSpan(
          spanId,
          {
            'http.status_code': response.statusCode,
            'http.duration_ms': Math.round(durationMs),
          },
          response.statusCode >= 400 ? 'ERROR' : 'OK'
        );

        // Flush traces asynchronously
        this.client.flush().catch((err) => {
          console.warn('TraceKit: Failed to flush traces', err);
        });
      }),
      catchError((error) => {
        // Error
        const [seconds, nanos] = process.hrtime(startTime);
        const durationMs = seconds * 1000 + nanos / 1_000_000;

        this.client.recordException(spanId, error);
        this.client.endSpan(
          spanId,
          {
            'http.duration_ms': Math.round(durationMs),
          },
          'ERROR'
        );

        this.client.flush().catch(() => {});

        return throwError(() => error);
      })
    );
  }

  private getClientIp(request: any): string {
    return (
      request.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      request.headers['x-real-ip'] ||
      request.socket.remoteAddress ||
      ''
    );
  }
}

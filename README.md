# TraceKit APM for Node.js

Zero-config distributed tracing and performance monitoring for Express and NestJS applications.

[![npm version](https://img.shields.io/npm/v/@tracekit/node-apm.svg)](https://www.npmjs.com/package/@tracekit/node-apm)
[![Downloads](https://img.shields.io/npm/dm/@tracekit/node-apm.svg)](https://www.npmjs.com/package/@tracekit/node-apm)
[![License](https://img.shields.io/npm/l/@tracekit/node-apm.svg)](https://www.npmjs.com/package/@tracekit/node-apm)

## Features

- **Zero Configuration** - Works out of the box with sensible defaults
- **Automatic Instrumentation** - No code changes needed
- **Express Support** - Simple middleware integration
- **NestJS Support** - Module and interceptor-based tracing
- **TypeScript First** - Full type definitions included
- **HTTP Request Tracing** - Track every request, route, and handler
- **Database Tracing** - Automatic query instrumentation for PostgreSQL, MySQL, MongoDB, Redis
- **Client IP Capture** - Automatic IP detection for DDoS & traffic analysis
- **Error Tracking** - Capture exceptions with full context
- **Code Monitoring** - Live debugging with breakpoints and variable inspection
- **Metrics API** - Counter, Gauge, and Histogram metrics with automatic OTLP export
- **Low Overhead** - < 5% performance impact

## Installation

```bash
npm install @tracekit/node-apm
```

## Quick Start

### Express

```javascript
const express = require('express');
const tracekit = require('@tracekit/node-apm');

const app = express();

// Initialize TraceKit
tracekit.init({
  apiKey: process.env.TRACEKIT_API_KEY,
  serviceName: 'my-express-app',
});

// Add middleware (must be before routes)
app.use(tracekit.middleware());

// Your routes
app.get('/', (req, res) => {
  res.send('Hello World!');
});

app.listen(3000);
```

### Express (TypeScript)

```typescript
import express from 'express';
import * as tracekit from '@tracekit/node-apm';

const app = express();

// Initialize TraceKit
tracekit.init({
  apiKey: process.env.TRACEKIT_API_KEY!,
  serviceName: 'my-express-app',
});

// Add middleware
app.use(tracekit.middleware());

// Your routes
app.get('/', (req, res) => {
  res.send('Hello World!');
});

app.listen(3000);
```

### NestJS

```typescript
// app.module.ts
import { Module } from '@nestjs/common';
import { TracekitModule } from '@tracekit/node-apm/nestjs';

@Module({
  imports: [
    TracekitModule.forRoot({
      apiKey: process.env.TRACEKIT_API_KEY!,
      serviceName: 'my-nestjs-app',
    }),
  ],
})
export class AppModule {}
```

That's it! Your app is now automatically traced.

## Local Development

Debug your application locally without creating a cloud account using TraceKit Local UI.

### Quick Start

```bash
# Install Local UI globally
npm install -g @tracekit/local-ui

# Start it
tracekit-local
```

The Local UI will start at `http://localhost:9999` and automatically open in your browser.

### How It Works

When running in development mode (`NODE_ENV=development`), the SDK automatically:

1. Detects if Local UI is running at `http://localhost:9999`
2. Sends traces to both Local UI and cloud (if API key is present)
3. Falls back gracefully if Local UI is not available

**No code changes needed!** Just set `NODE_ENV=development`:

```bash
export NODE_ENV=development
export TRACEKIT_API_KEY=your-key  # Optional - works without it!
node app.js
```

You'll see traces appear in real-time at `http://localhost:9999`.

### Features

- Real-time trace viewing in your browser
- Works completely offline
- No cloud account required
- Zero configuration
- Automatic cleanup (1000 traces max, 1 hour retention)

### Local-Only Development

To use Local UI without cloud sending:

```bash
# Don't set TRACEKIT_API_KEY
export NODE_ENV=development
node app.js
```

Traces will only go to Local UI.

### Disabling Local UI

To disable automatic Local UI detection:

```bash
export NODE_ENV=production
# or don't run Local UI
```

### Learn More

- GitHub: [https://github.com/Tracekit-Dev/local-debug-ui](https://github.com/Tracekit-Dev/local-debug-ui)
- npm: [@tracekit/local-ui](https://www.npmjs.com/package/@tracekit/local-ui)

## Code Monitoring (Live Debugging)

TraceKit includes production-safe code monitoring for live debugging without redeployment.

### Enable Code Monitoring

```typescript
import * as tracekit from '@tracekit/node-apm';

// Enable code monitoring
const client = tracekit.init({
  apiKey: process.env.TRACEKIT_API_KEY!,
  serviceName: 'my-app',
  enableCodeMonitoring: true,  // Enable live debugging
});
```

### Add Debug Points

Add checkpoints anywhere in your code to capture variable state and stack traces:

```typescript
// In any service or controller
app.post('/checkout', async (req, res) => {
  const cart = req.body.cart;
  const userId = req.body.userId;

  // Capture snapshot at this point
  await client.captureSnapshot('checkout-validation', {
    userId,
    cartItems: cart.items.length,
    totalAmount: cart.total,
  });

  // Process payment...
  const result = await processPayment(cart);

  // Another checkpoint
  await client.captureSnapshot('payment-complete', {
    userId,
    paymentId: result.paymentId,
    success: result.success,
  });

  res.json(result);
});
```

### Automatic Breakpoint Management

- **Auto-Registration**: First call to `captureSnapshot()` automatically creates breakpoints in TraceKit
- **Smart Matching**: Breakpoints match by function name + label (stable across code changes)
- **Background Sync**: SDK polls for active breakpoints every 30 seconds
- **Production Safe**: No performance impact when breakpoints are inactive

### View Captured Data

Snapshots include:
- **Variables**: Local variables at capture point
- **Stack Trace**: Full call stack with file/line numbers
- **Request Context**: HTTP method, URL, headers, query params
- **Execution Time**: When the snapshot was captured

### NestJS Usage

```typescript
import { Injectable, Inject } from '@nestjs/common';
import { SnapshotClient } from '@tracekit/node-apm';

@Injectable()
export class PaymentService {
  constructor(
    @Inject('TRACEKIT_SNAPSHOT_CLIENT')
    private snapshotClient?: SnapshotClient
  ) {}

  async processPayment(order: Order) {
    // Automatic snapshot capture
    await this.snapshotClient?.checkAndCaptureWithContext('payment-processing', {
      orderId: order.id,
      amount: order.amount,
    });

    // ... payment logic
  }
}
```

Get your API key at [https://app.tracekit.dev](https://app.tracekit.dev)

## Metrics

TraceKit APM includes a powerful metrics API for tracking application performance and business metrics.

### Metric Types

TraceKit supports three types of metrics:

- **Counter**: Monotonically increasing values (requests, errors, events)
- **Gauge**: Point-in-time values that can go up or down (active connections, queue size)
- **Histogram**: Value distributions (request duration, payload sizes)

### Basic Usage

```typescript
import * as tracekit from '@tracekit/node-apm';

const client = tracekit.init({
  apiKey: process.env.TRACEKIT_API_KEY!,
  serviceName: 'my-app',
});

// Create metrics
const requestCounter = client.counter('http.requests.total', {
  service: 'my-app'
});

const activeRequestsGauge = client.gauge('http.requests.active', {
  service: 'my-app'
});

const requestDurationHistogram = client.histogram('http.request.duration', {
  unit: 'ms'
});

// Use metrics in your handlers
app.use((req, res, next) => {
  const startTime = Date.now();

  activeRequestsGauge.inc();

  res.on('finish', () => {
    requestCounter.inc();
    activeRequestsGauge.dec();

    const duration = Date.now() - startTime;
    requestDurationHistogram.record(duration);
  });

  next();
});
```

### Counter

Counters track monotonically increasing values:

```typescript
const counter = client.counter('events.processed', { type: 'order' });

// Increment by 1
counter.inc();

// Add custom amount
counter.add(5);
```

### Gauge

Gauges track values that can increase or decrease:

```typescript
const gauge = client.gauge('queue.size', { queue: 'orders' });

// Set to specific value
gauge.set(42);

// Increment
gauge.inc();

// Decrement
gauge.dec();
```

### Histogram

Histograms track distributions of values:

```typescript
const histogram = client.histogram('api.response.size', { unit: 'bytes' });

// Record a value
histogram.record(1024);
histogram.record(2048);
```

### Express Example

```typescript
import express from 'express';
import * as tracekit from '@tracekit/node-apm';

const app = express();
const client = tracekit.init({
  apiKey: process.env.TRACEKIT_API_KEY!,
  serviceName: 'express-app',
});

app.use(tracekit.middleware());

// Initialize metrics
const requestCounter = client.counter('http.requests.total');
const activeRequests = client.gauge('http.requests.active');
const requestDuration = client.histogram('http.request.duration', { unit: 'ms' });
const errorCounter = client.counter('http.errors.total');

// Metrics middleware
app.use((req, res, next) => {
  const start = Date.now();
  activeRequests.inc();

  res.on('finish', () => {
    requestCounter.inc();
    activeRequests.dec();
    requestDuration.record(Date.now() - start);

    if (res.statusCode >= 400) {
      errorCounter.inc();
    }
  });

  next();
});

app.get('/', (req, res) => {
  res.send('Hello World');
});

app.listen(3000);
```

### NestJS Example

```typescript
import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import * as tracekit from '@tracekit/node-apm';

@Injectable()
export class MetricsMiddleware implements NestMiddleware {
  private requestCounter = tracekit.getClient().counter('http.requests.total');
  private activeRequests = tracekit.getClient().gauge('http.requests.active');
  private requestDuration = tracekit.getClient().histogram('http.request.duration', { unit: 'ms' });

  use(req: Request, res: Response, next: NextFunction) {
    const start = Date.now();
    this.activeRequests.inc();

    res.on('finish', () => {
      this.requestCounter.inc();
      this.activeRequests.dec();
      this.requestDuration.record(Date.now() - start);
    });

    next();
  }
}
```

### Tags

Add tags to metrics for dimensional analysis:

```typescript
const counter = client.counter('api.requests', {
  service: 'payment-api',
  region: 'us-east-1',
  environment: 'production'
});

counter.inc();
```

### Common Use Cases

#### HTTP Request Tracking

```typescript
const requests = client.counter('http.requests', { method: 'POST', endpoint: '/api/orders' });
const duration = client.histogram('http.duration', { endpoint: '/api/orders' });
const errors = client.counter('http.errors', { code: '500' });
```

#### Database Metrics

```typescript
const queries = client.counter('db.queries', { operation: 'SELECT' });
const queryDuration = client.histogram('db.query.duration', { unit: 'ms' });
const connections = client.gauge('db.connections.active');
```

#### Business Metrics

```typescript
const orders = client.counter('orders.created');
const revenue = client.histogram('orders.amount', { unit: 'usd' });
const inventory = client.gauge('inventory.stock', { product: 'laptop' });
```

### Metric Export

Metrics are automatically buffered and exported in batches:

- **Buffer size**: 100 metrics
- **Flush interval**: 10 seconds
- **Endpoint**: Automatically resolved to `/v1/metrics`

Metrics are sent to TraceKit using OTLP format and appear in your dashboard with full dimensional analysis.

## Configuration

### Basic Configuration

```typescript
import * as tracekit from '@tracekit/node-apm';

tracekit.init({
  // Required: Your TraceKit API key
  apiKey: process.env.TRACEKIT_API_KEY,

  // Optional: Service name (default: 'node-app')
  serviceName: 'my-service',

  // Optional: TraceKit endpoint (default: 'https://app.tracekit.dev/v1/traces')
  endpoint: 'https://app.tracekit.dev/v1/traces',

  // Optional: Enable/disable tracing (default: true)
  enabled: process.env.NODE_ENV !== 'development',

  // Optional: Sample rate 0.0-1.0 (default: 1.0 = 100%)
  sampleRate: 0.5, // Trace 50% of requests

  // Optional: Enable live code debugging (default: false)
  enableCodeMonitoring: true, // Enable breakpoints and snapshots

  // Optional: Map hostnames to service names for service graph
  serviceNameMappings: {
    'localhost:8082': 'payment-service',
    'localhost:8083': 'user-service',
  },
});
```

### NestJS Async Configuration

```typescript
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TracekitModule } from '@tracekit/node-apm/nestjs';

@Module({
  imports: [
    ConfigModule.forRoot(),
    TracekitModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        apiKey: config.get('TRACEKIT_API_KEY')!,
        serviceName: config.get('APP_NAME', 'my-app'),
        enabled: config.get('NODE_ENV') !== 'development',
        enableCodeMonitoring: config.get('TRACEKIT_CODE_MONITORING_ENABLED', false),
      }),
    }),
  ],
})
export class AppModule {}
```

## Automatic Service Discovery

TraceKit automatically instruments **outgoing HTTP calls** to create service dependency graphs. This enables you to see which services talk to each other in your distributed system.

### How It Works

When your service makes an HTTP request to another service:

1. ✅ TraceKit creates a **CLIENT span** for the outgoing request
2. ✅ Trace context is automatically injected into request headers (`traceparent`)
3. ✅ The receiving service creates a **SERVER span** linked to your CLIENT span
4. ✅ TraceKit maps the dependency: **YourService → TargetService**

### Supported HTTP Clients

TraceKit automatically instruments these HTTP libraries:

- ✅ **`http`** / **`https`** (Node.js built-in modules)
- ✅ **`fetch`** (Node 18+ native fetch API)
- ✅ **`axios`** (works via http module)
- ✅ **`node-fetch`** (works via http module)
- ✅ **`got`**, **`superagent`**, etc. (work via http module)

**Zero configuration required!** Just make HTTP calls as normal:

```typescript
import axios from 'axios';
import fetch from 'node-fetch';

// All of these automatically create CLIENT spans:
await fetch('http://payment-service/charge');
await axios.get('http://inventory-service/check');
http.get('http://user-service/profile/123', callback);
```

### Service Name Detection

TraceKit intelligently extracts service names from URLs:

| URL | Extracted Service Name |
|-----|------------------------|
| `http://payment-service:3000` | `payment-service` |
| `http://payment.internal` | `payment` |
| `http://payment.svc.cluster.local` | `payment` |
| `https://api.example.com` | `api.example.com` |

This works seamlessly with:
- Kubernetes service names
- Internal DNS names
- Docker Compose service names
- External APIs

### Custom Service Name Mappings

For local development or when service names can't be inferred from hostnames, use `serviceNameMappings`:

```typescript
tracekit.init({
  apiKey: process.env.TRACEKIT_API_KEY,
  serviceName: 'my-service',
  // Map localhost URLs to actual service names
  serviceNameMappings: {
    'localhost:8082': 'payment-service',
    'localhost:8083': 'user-service',
    'localhost:8084': 'inventory-service',
    'localhost:5001': 'analytics-service',
  },
});

// Now requests to localhost:8082 will show as "payment-service" in the service graph
const response = await fetch('http://localhost:8082/charge');
// -> Creates CLIENT span with peer.service = "payment-service"
```

This is especially useful when:
- Running microservices locally on different ports
- Using Docker Compose with localhost networking
- Testing distributed tracing in development

### Viewing Service Dependencies

Visit your TraceKit dashboard to see:

- **Service Map**: Visual graph showing which services call which
- **Service List**: Table of all services with health metrics
- **Service Detail**: Deep dive on individual services with upstream/downstream dependencies

### Disabling Auto-Instrumentation

If you need to disable automatic HTTP client instrumentation:

```typescript
tracekit.init({
  apiKey: process.env.TRACEKIT_API_KEY,
  autoInstrumentHttpClient: false, // Disable auto-instrumentation
});
```

## What Gets Traced?

### Incoming HTTP Requests (SERVER spans)

Every HTTP request to your service is automatically traced with:

- Route path and HTTP method
- Request URL and query parameters
- HTTP status code
- Request duration
- User agent and client IP
- Controller and handler names (NestJS)

### Outgoing HTTP Requests (CLIENT spans)

Every HTTP request from your service is automatically traced with:

- Target URL and HTTP method
- HTTP status code
- Request duration
- `peer.service` attribute for service dependency mapping

### Database Queries (CLIENT spans)

All database operations are automatically traced with zero configuration:

**PostgreSQL** (`pg` library):
- SQL query statements
- Query parameters
- Database name
- Response time

**MySQL** (`mysql`/`mysql2` libraries):
- SQL query statements
- Query parameters
- Database name
- Response time

**MongoDB**:
- Collection operations (find, insert, update, delete)
- Query filters
- Database and collection names
- Response time

**Redis**:
- Commands (GET, SET, HGET, etc.)
- Keys accessed
- Response time

Example trace hierarchy:
```
GET /users/:id (kind: Server)
  ├─ SELECT * FROM users WHERE id = $1 (kind: Client, db.system: postgresql)
  ├─ GET user:123:cache (kind: Client, db.system: redis)
  └─ INSERT INTO audit_logs... (kind: Client, db.system: postgresql)
```

### Errors and Exceptions

All exceptions are automatically captured with:

- Exception type and message
- Full stack trace
- Request context
- Handler information

## Advanced Usage

### Manual Tracing (Express)

```typescript
import { getClient } from '@tracekit/node-apm';

app.get('/custom', async (req, res) => {
  const client = getClient();

  const span = client.startSpan('my-operation', null, {
    'user.id': req.user?.id,
    'custom.attribute': 'value',
  });

  try {
    const result = await doSomething();

    client.endSpan(span, {
      'result.count': result.length,
    });

    res.json(result);
  } catch (error) {
    client.recordException(span, error as Error);
    client.endSpan(span, {}, 'ERROR');
    throw error;
  }
});
```

### Manual Tracing (NestJS)

```typescript
import { Injectable, Inject } from '@nestjs/common';
import { TracekitClient } from '@tracekit/node-apm/nestjs';

@Injectable()
export class MyService {
  constructor(
    @Inject('TRACEKIT_CLIENT') private tracekit: TracekitClient
  ) {}

  async doSomething() {
    const span = this.tracekit.startSpan('custom-operation', null, {
      'operation.type': 'database',
    });

    try {
      const result = await this.database.query();

      this.tracekit.endSpan(span, {
        'rows.count': result.length,
      });

      return result;
    } catch (error) {
      this.tracekit.recordException(span, error as Error);
      this.tracekit.endSpan(span, {}, 'ERROR');
      throw error;
    }
  }
}
```

## Environment-Based Configuration

### Disable tracing in development

```typescript
tracekit.init({
  apiKey: process.env.TRACEKIT_API_KEY!,
  enabled: process.env.NODE_ENV === 'production',
});
```

### Sample only 10% of requests

```typescript
tracekit.init({
  apiKey: process.env.TRACEKIT_API_KEY!,
  sampleRate: 0.1, // Trace 10% of requests
});
```

## Performance

TraceKit APM is designed to have minimal performance impact:

- **< 5% overhead** on average request time
- Asynchronous trace sending (doesn't block responses)
- Automatic batching and compression
- Configurable sampling for high-traffic apps

## TypeScript Support

Full TypeScript support with type definitions included:

```typescript
import { TracekitClient, TracekitConfig, Span } from '@tracekit/node-apm';

const config: TracekitConfig = {
  apiKey: 'your-key',
  serviceName: 'my-app',
};

const attributes: Record<string, any> = {
  'user.id': 123,
  'request.path': '/api/users',
};

// Using the client
const client = new TracekitClient(config);
const span: Span = client.startSpan('my-operation', null, attributes);
```

## Requirements

- Node.js 16.x or higher
- Express 4.x or 5.x (for Express support)
- NestJS 10.x (for NestJS support)

## Examples

### Express Example

```javascript
const express = require('express');
const tracekit = require('@tracekit/node-apm');

const app = express();

tracekit.init({
  apiKey: process.env.TRACEKIT_API_KEY,
  serviceName: 'express-example',
});

app.use(tracekit.middleware());

app.get('/users', async (req, res) => {
  const users = await db.getUsers();
  res.json(users);
});

app.listen(3000);
```

### NestJS Example

```typescript
// main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(3000);
}
bootstrap();

// app.module.ts
import { Module } from '@nestjs/common';
import { TracekitModule } from '@tracekit/node-apm/nestjs';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    TracekitModule.forRoot({
      apiKey: process.env.TRACEKIT_API_KEY!,
      serviceName: 'nestjs-example',
    }),
    UsersModule,
  ],
})
export class AppModule {}

// users.controller.ts
import { Controller, Get } from '@nestjs/common';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private usersService: UsersService) {}

  @Get()
  findAll() {
    return this.usersService.findAll();
  }
}
```

## Support

- Documentation: [https://app.tracekit.dev/docs](https://app.tracekit.dev/docs)
- Issues: [https://github.com/Tracekit-Dev/node-apm/issues](https://github.com/Tracekit-Dev/node-apm/issues)
- Email: support@tracekit.dev

## License

MIT License. See [LICENSE](LICENSE) for details.

## Credits

Built with ❤️ by the TraceKit team.

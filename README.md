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
- **Error Tracking** - Capture exceptions with full context
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

Get your API key at [https://tracekit.dev](https://tracekit.dev)

## Configuration

### Basic Configuration

```typescript
import * as tracekit from '@tracekit/node-apm';

tracekit.init({
  // Required: Your TraceKit API key
  apiKey: process.env.TRACEKIT_API_KEY,

  // Optional: Service name (default: 'node-app')
  serviceName: 'my-service',

  // Optional: TraceKit endpoint (default: 'https://tracekit.dev/v1/traces')
  endpoint: 'https://tracekit.dev/v1/traces',

  // Optional: Enable/disable tracing (default: true)
  enabled: process.env.NODE_ENV !== 'development',

  // Optional: Sample rate 0.0-1.0 (default: 1.0 = 100%)
  sampleRate: 0.5, // Trace 50% of requests
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
      }),
    }),
  ],
})
export class AppModule {}
```

## What Gets Traced?

### HTTP Requests

Every HTTP request is automatically traced with:

- Route path and HTTP method
- Request URL and query parameters
- HTTP status code
- Request duration
- User agent and client IP
- Controller and handler names (NestJS)

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

  const spanId = client.startSpan('my-operation', null, {
    'user.id': req.user?.id,
    'custom.attribute': 'value',
  });

  try {
    const result = await doSomething();

    client.endSpan(spanId, {
      'result.count': result.length,
    });

    res.json(result);
  } catch (error) {
    client.recordException(spanId, error as Error);
    client.endSpan(spanId, {}, 'ERROR');
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
    const spanId = this.tracekit.startSpan('custom-operation', null, {
      'operation.type': 'database',
    });

    try {
      const result = await this.database.query();

      this.tracekit.endSpan(spanId, {
        'rows.count': result.length,
      });

      return result;
    } catch (error) {
      this.tracekit.recordException(spanId, error as Error);
      this.tracekit.endSpan(spanId, {}, 'ERROR');
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
import { TracekitClient, TracekitConfig, SpanAttributes } from '@tracekit/node-apm';

const config: TracekitConfig = {
  apiKey: 'your-key',
  serviceName: 'my-app',
};

const attributes: SpanAttributes = {
  'user.id': 123,
  'request.path': '/api/users',
};
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

- Documentation: [https://docs.tracekit.dev](https://docs.tracekit.dev)
- Issues: [https://github.com/tracekit/node-apm/issues](https://github.com/tracekit/node-apm/issues)
- Email: support@tracekit.dev

## License

MIT License. See [LICENSE](LICENSE) for details.

## Credits

Built with ❤️ by the TraceKit team.

import { Module, DynamicModule, Global, OnModuleDestroy } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TracekitClient, TracekitConfig } from '../client';
import { TracekitInterceptor } from './tracekit.interceptor';

@Global()
@Module({})
export class TracekitModule implements OnModuleDestroy {
  static forRoot(config: TracekitConfig): DynamicModule {
    const client = new TracekitClient(config);
    const snapshotClient = client.getSnapshotClient();

    const clientProvider = {
      provide: 'TRACEKIT_CLIENT',
      useValue: client,
    };

    const snapshotClientProvider = {
      provide: 'TRACEKIT_SNAPSHOT_CLIENT',
      useValue: snapshotClient,
    };

    const interceptorProvider = {
      provide: APP_INTERCEPTOR,
      useClass: TracekitInterceptor,
    };

    return {
      module: TracekitModule,
      providers: [clientProvider, snapshotClientProvider, interceptorProvider, TracekitInterceptor],
      exports: ['TRACEKIT_CLIENT', 'TRACEKIT_SNAPSHOT_CLIENT'],
    };
  }

  static forRootAsync(options: {
    useFactory: (...args: any[]) => Promise<TracekitConfig> | TracekitConfig;
    inject?: any[];
  }): DynamicModule {
    const clientProvider = {
      provide: 'TRACEKIT_CLIENT',
      useFactory: async (...args: any[]) => {
        const config = await options.useFactory(...args);
        return new TracekitClient(config);
      },
      inject: options.inject || [],
    };

    const snapshotClientProvider = {
      provide: 'TRACEKIT_SNAPSHOT_CLIENT',
      useFactory: async (...args: any[]) => {
        const config = await options.useFactory(...args);
        const client = new TracekitClient(config);
        return client.getSnapshotClient();
      },
      inject: options.inject || [],
    };

    const interceptorProvider = {
      provide: APP_INTERCEPTOR,
      useClass: TracekitInterceptor,
    };

    return {
      module: TracekitModule,
      providers: [clientProvider, snapshotClientProvider, interceptorProvider, TracekitInterceptor],
      exports: ['TRACEKIT_CLIENT', 'TRACEKIT_SNAPSHOT_CLIENT'],
    };
  }

  async onModuleDestroy() {
    // Cleanup handled by TracekitClient.shutdown()
  }
}

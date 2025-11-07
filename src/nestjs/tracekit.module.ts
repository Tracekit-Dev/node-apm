import { Module, DynamicModule, Global } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TracekitClient, TracekitConfig } from '../client';
import { TracekitInterceptor } from './tracekit.interceptor';

@Global()
@Module({})
export class TracekitModule {
  static forRoot(config: TracekitConfig): DynamicModule {
    const clientProvider = {
      provide: 'TRACEKIT_CLIENT',
      useFactory: () => {
        return new TracekitClient(config);
      },
    };

    const interceptorProvider = {
      provide: APP_INTERCEPTOR,
      useClass: TracekitInterceptor,
    };

    return {
      module: TracekitModule,
      providers: [clientProvider, interceptorProvider, TracekitInterceptor],
      exports: ['TRACEKIT_CLIENT'],
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

    const interceptorProvider = {
      provide: APP_INTERCEPTOR,
      useClass: TracekitInterceptor,
    };

    return {
      module: TracekitModule,
      providers: [clientProvider, interceptorProvider, TracekitInterceptor],
      exports: ['TRACEKIT_CLIENT'],
    };
  }
}

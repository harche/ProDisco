import * as grpc from '@grpc/grpc-js';
import type {
  SandboxServiceServer,
  ExecuteRequest,
  ExecuteResponse,
  HealthCheckRequest,
  HealthCheckResponse,
} from '../generated/sandbox.js';
import { Executor } from './executor.js';
import { CacheManager } from './cache-manager.js';

export interface SandboxServiceConfig {
  prometheusUrl?: string;
  cacheDir?: string;
}

/**
 * Create the gRPC service handlers for SandboxService.
 */
export function createSandboxService(config: SandboxServiceConfig = {}): SandboxServiceServer {
  const executor = new Executor({ prometheusUrl: config.prometheusUrl });
  const cacheManager = new CacheManager({ cacheDir: config.cacheDir });

  return {
    execute: async (
      call: grpc.ServerUnaryCall<ExecuteRequest, ExecuteResponse>,
      callback: grpc.sendUnaryData<ExecuteResponse>
    ) => {
      const request = call.request;
      const timeoutMs = request.timeoutMs ?? 30000;

      let code: string;
      let cachedScriptName: string | undefined;

      // Handle oneof source
      if (request.source?.$case === 'code') {
        code = request.source.code;
      } else if (request.source?.$case === 'cached') {
        const cached = cacheManager.find(request.source.cached);
        if (!cached) {
          callback(null, {
            success: false,
            output: '',
            error: `Cached "${request.source.cached}" not found`,
            executionTimeMs: '0',
            cachedAs: undefined,
          });
          return;
        }
        code = cached.code;
        cachedScriptName = cached.filename;
      } else {
        callback(null, {
          success: false,
          output: '',
          error: 'Either code or cached must be provided',
          executionTimeMs: '0',
          cachedAs: undefined,
        });
        return;
      }

      // Execute the code
      const result = await executor.execute(code, timeoutMs);

      // Cache successful new executions
      let cachedAs: string | undefined;
      if (result.success && !cachedScriptName) {
        cachedAs = await cacheManager.cache(code);
      }

      callback(null, {
        success: result.success,
        output: result.output,
        error: result.error,
        executionTimeMs: String(result.executionTimeMs),
        cachedAs: cachedAs ?? cachedScriptName,
      });
    },

    healthCheck: async (
      _call: grpc.ServerUnaryCall<HealthCheckRequest, HealthCheckResponse>,
      callback: grpc.sendUnaryData<HealthCheckResponse>
    ) => {
      callback(null, {
        healthy: true,
        kubernetesContext: executor.getKubernetesContext(),
      });
    },
  };
}

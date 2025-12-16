/**
 * Tests for the PrometheusClient
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PrometheusClient } from '../client.js';

describe('PrometheusClient', () => {
  let client: PrometheusClient;

  beforeEach(() => {
    client = new PrometheusClient({
      endpoint: 'http://prometheus:9090',
    });
  });

  describe('constructor', () => {
    it('creates client with endpoint', () => {
      const c = new PrometheusClient({
        endpoint: 'http://localhost:9090',
      });

      expect(c.getEndpoint()).toBe('http://localhost:9090');
    });

    it('uses default timeout if not specified', () => {
      const c = new PrometheusClient({
        endpoint: 'http://localhost:9090',
      });

      expect(c).toBeDefined();
    });

    it('accepts custom timeout', () => {
      const c = new PrometheusClient({
        endpoint: 'http://localhost:9090',
        timeout: 60000,
      });

      expect(c).toBeDefined();
    });
  });

  describe('getEndpoint', () => {
    it('returns the configured endpoint', () => {
      expect(client.getEndpoint()).toBe('http://prometheus:9090');
    });
  });

  describe('isHealthy', () => {
    it('returns false when Prometheus is unreachable', async () => {
      // This will fail because there's no actual Prometheus server
      const healthy = await client.isHealthy();

      expect(healthy).toBe(false);
    });
  });
});

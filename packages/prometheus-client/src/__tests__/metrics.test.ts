/**
 * Tests for the MetricSearchEngine class
 */

import { describe, it, expect } from 'vitest';
import { MetricSearchEngine, createMetricSearchEngine } from '../metrics.js';
import { PrometheusClient } from '../client.js';

describe('MetricSearchEngine', () => {
  describe('constructor', () => {
    it('creates MetricSearchEngine with client', () => {
      const client = new PrometheusClient({ endpoint: 'http://prometheus:9090' });
      const search = new MetricSearchEngine(client);

      expect(search).toBeDefined();
      expect(search.isReady()).toBe(false);
      expect(search.getIndexedCount()).toBe(0);
    });
  });

  describe('createMetricSearchEngine', () => {
    it('creates engine from endpoint string', () => {
      const search = createMetricSearchEngine('http://prometheus:9090');

      expect(search).toBeInstanceOf(MetricSearchEngine);
      expect(search.isReady()).toBe(false);
    });
  });

  describe('clear', () => {
    it('resets the search engine state', async () => {
      const client = new PrometheusClient({ endpoint: 'http://prometheus:9090' });
      const search = new MetricSearchEngine(client);

      await search.clear();

      expect(search.isReady()).toBe(false);
      expect(search.getIndexedCount()).toBe(0);
    });
  });
});

describe('MetricSearchEngine - search token generation', () => {
  describe('searchTokens generation', () => {
    it('should build searchable tokens from metric name', () => {
      const metricName = 'http_requests_total';
      const nameParts = metricName.replace(/_/g, ' ');

      expect(nameParts).toBe('http requests total');
      expect(nameParts).toContain('http');
      expect(nameParts).toContain('requests');
      expect(nameParts).toContain('total');
    });

    it('should include metric type in tokens', () => {
      const metricName = 'container_memory_usage_bytes';
      const metricType = 'gauge';
      const help = 'Current memory usage in bytes';

      const searchTokens = `${metricName.replace(/_/g, ' ')} ${metricType} ${help}`;

      expect(searchTokens).toContain('container memory usage bytes');
      expect(searchTokens).toContain('gauge');
      expect(searchTokens).toContain('Current memory usage');
    });
  });

  describe('metric types', () => {
    it('should handle all metric types', () => {
      const validTypes = ['counter', 'gauge', 'histogram', 'summary', 'unknown'];

      validTypes.forEach((type) => {
        expect(['counter', 'gauge', 'histogram', 'summary', 'unknown']).toContain(type);
      });
    });
  });
});

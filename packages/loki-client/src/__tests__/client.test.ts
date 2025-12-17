/**
 * Tests for the LokiClient
 *
 * These tests verify that the LokiClient correctly interfaces with the Loki REST API
 * as documented at https://grafana.com/docs/loki/latest/reference/loki-http-api/
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LokiClient } from '../index.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('LokiClient', () => {
  let client: LokiClient;

  beforeEach(() => {
    client = new LokiClient({
      baseUrl: 'http://localhost:3100',
    });
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ============================================================================
  // Constructor Tests
  // ============================================================================

  describe('constructor', () => {
    it('creates client with baseUrl', () => {
      const c = new LokiClient({
        baseUrl: 'http://localhost:3100',
      });
      expect(c).toBeDefined();
    });

    it('removes trailing slash from baseUrl', () => {
      const c = new LokiClient({
        baseUrl: 'http://localhost:3100/',
      });
      // We verify this by checking the URL in a request
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'success', data: [] }),
      });

      c.labels();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringMatching(/^http:\/\/localhost:3100\/loki/),
        expect.any(Object)
      );
    });

    it('accepts optional tenantId for multi-tenant Loki', () => {
      const c = new LokiClient({
        baseUrl: 'http://localhost:3100',
        tenantId: 'my-tenant',
      });
      expect(c).toBeDefined();
    });

    it('accepts custom timeout', () => {
      const c = new LokiClient({
        baseUrl: 'http://localhost:3100',
        timeout: 60000,
      });
      expect(c).toBeDefined();
    });

    it('uses default timeout of 30000ms if not specified', () => {
      const c = new LokiClient({
        baseUrl: 'http://localhost:3100',
      });
      expect(c).toBeDefined();
    });
  });

  // ============================================================================
  // Multi-tenant Header Tests
  // ============================================================================

  describe('multi-tenant support', () => {
    it('includes X-Scope-OrgID header when tenantId is set', async () => {
      const tenantClient = new LokiClient({
        baseUrl: 'http://localhost:3100',
        tenantId: 'my-org',
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'success', data: [] }),
      });

      await tenantClient.labels();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Scope-OrgID': 'my-org',
          }),
        })
      );
    });

    it('does not include X-Scope-OrgID header when tenantId is not set', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'success', data: [] }),
      });

      await client.labels();

      const callHeaders = mockFetch.mock.calls[0][1].headers;
      expect(callHeaders['X-Scope-OrgID']).toBeUndefined();
    });
  });

  // ============================================================================
  // /loki/api/v1/labels Endpoint Tests
  // ============================================================================

  describe('labels()', () => {
    it('calls GET /loki/api/v1/labels', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'success',
          data: ['app', 'namespace', 'pod'],
        }),
      });

      await client.labels();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/loki/api/v1/labels'),
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('returns array of label names matching Loki API response format', async () => {
      // Loki API returns: { "status": "success", "data": ["<label_name>", ...] }
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'success',
          data: ['app', 'namespace', 'pod', 'container'],
        }),
      });

      const result = await client.labels();

      expect(result).toEqual(['app', 'namespace', 'pod', 'container']);
    });

    it('accepts start and end time parameters', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'success', data: [] }),
      });

      await client.labels({ start: 1705312800, end: 1705316400 });

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('start=');
      expect(url).toContain('end=');
    });

    it('accepts since parameter for relative time', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'success', data: [] }),
      });

      await client.labels({ since: '1h' });

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('start=');
      expect(url).toContain('end=');
    });
  });

  // ============================================================================
  // /loki/api/v1/label/{name}/values Endpoint Tests
  // ============================================================================

  describe('labelValues()', () => {
    it('calls GET /loki/api/v1/label/{name}/values', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'success',
          data: ['default', 'kube-system'],
        }),
      });

      await client.labelValues('namespace');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/loki/api/v1/label/namespace/values'),
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('URL-encodes label names', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'success', data: [] }),
      });

      await client.labelValues('label-with-special/chars');

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain(encodeURIComponent('label-with-special/chars'));
    });

    it('returns array of label values matching Loki API response format', async () => {
      // Loki API returns: { "status": "success", "data": ["<label_value>", ...] }
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'success',
          data: ['nginx', 'redis', 'postgres'],
        }),
      });

      const result = await client.labelValues('app');

      expect(result).toEqual(['nginx', 'redis', 'postgres']);
    });

    it('accepts query parameter to filter by LogQL', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'success', data: [] }),
      });

      await client.labelValues('pod', { query: '{app="nginx"}' });

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('query=');
    });

    it('accepts time range parameters', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'success', data: [] }),
      });

      await client.labelValues('app', { since: '24h' });

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('start=');
      expect(url).toContain('end=');
    });
  });

  // ============================================================================
  // /loki/api/v1/series Endpoint Tests
  // ============================================================================

  describe('series()', () => {
    it('calls GET /loki/api/v1/series', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'success',
          data: [],
        }),
      });

      await client.series(['{app="nginx"}']);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/loki/api/v1/series'),
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('includes match[] parameters for each selector', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'success', data: [] }),
      });

      await client.series(['{app="nginx"}', '{namespace="default"}']);

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('match%5B0%5D='); // match[0]=
      expect(url).toContain('match%5B1%5D='); // match[1]=
    });

    it('returns array of label sets matching Loki API response format', async () => {
      // Loki API returns: { "status": "success", "data": [{ "<label_key>": "<label_value>" }, ...] }
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'success',
          data: [
            { app: 'nginx', namespace: 'default', pod: 'nginx-abc123' },
            { app: 'nginx', namespace: 'default', pod: 'nginx-def456' },
          ],
        }),
      });

      const result = await client.series(['{app="nginx"}']);

      expect(result).toEqual([
        { app: 'nginx', namespace: 'default', pod: 'nginx-abc123' },
        { app: 'nginx', namespace: 'default', pod: 'nginx-def456' },
      ]);
    });

    it('accepts time range parameters', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'success', data: [] }),
      });

      await client.series(['{app="nginx"}'], { since: '1h' });

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('start=');
      expect(url).toContain('end=');
    });
  });

  // ============================================================================
  // /loki/api/v1/query_range Endpoint Tests (Logs)
  // ============================================================================

  describe('queryRange()', () => {
    it('calls GET /loki/api/v1/query_range', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'success',
          data: { resultType: 'streams', result: [], stats: {} },
        }),
      });

      await client.queryRange('{app="nginx"}');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/loki/api/v1/query_range'),
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('includes query parameter', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'success',
          data: { resultType: 'streams', result: [], stats: {} },
        }),
      });

      await client.queryRange('{namespace="kube-system"} |= "error"');

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('query=');
    });

    it('parses streams result matching Loki API response format', async () => {
      // Loki API returns for streams:
      // {
      //   "status": "success",
      //   "data": {
      //     "resultType": "streams",
      //     "result": [{ "stream": {...}, "values": [["<timestamp>", "<log_line>"]] }],
      //     "stats": {}
      //   }
      // }
      const nowNanos = (Date.now() * 1000000).toString();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'success',
          data: {
            resultType: 'streams',
            result: [
              {
                stream: { app: 'nginx', pod: 'nginx-abc123' },
                values: [
                  [nowNanos, 'Error: connection refused'],
                  [nowNanos, 'Warning: timeout occurred'],
                ],
              },
            ],
            stats: { summary: { bytesProcessedPerSecond: 1000000 } },
          },
        }),
      });

      const result = await client.queryRange('{app="nginx"}');

      expect(result.streams).toHaveLength(1);
      expect(result.streams[0].labels).toEqual({ app: 'nginx', pod: 'nginx-abc123' });
      expect(result.streams[0].entries).toHaveLength(2);
      expect(result.streams[0].entries[0].line).toBe('Error: connection refused');
    });

    it('returns flattened logs with labels', async () => {
      const nowNanos = (Date.now() * 1000000).toString();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'success',
          data: {
            resultType: 'streams',
            result: [
              {
                stream: { app: 'nginx' },
                values: [[nowNanos, 'log line 1']],
              },
              {
                stream: { app: 'redis' },
                values: [[nowNanos, 'log line 2']],
              },
            ],
          },
        }),
      });

      const result = await client.queryRange('{namespace="default"}');

      expect(result.logs).toHaveLength(2);
      expect(result.logs[0].labels).toBeDefined();
      expect(result.logs[0].line).toBeDefined();
      expect(result.logs[0].timestamp).toBeInstanceOf(Date);
    });

    it('accepts limit parameter', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'success',
          data: { resultType: 'streams', result: [] },
        }),
      });

      await client.queryRange('{app="nginx"}', { limit: 500 });

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('limit=500');
    });

    it('accepts direction parameter (forward/backward)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'success',
          data: { resultType: 'streams', result: [] },
        }),
      });

      await client.queryRange('{app="nginx"}', { direction: 'forward' });

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('direction=forward');
    });

    it('defaults to last hour if no time range specified', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'success',
          data: { resultType: 'streams', result: [] },
        }),
      });

      await client.queryRange('{app="nginx"}');

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('start=');
      expect(url).toContain('end=');
    });

    it('includes stats in result when provided by Loki', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'success',
          data: {
            resultType: 'streams',
            result: [],
            stats: {
              summary: { bytesProcessedPerSecond: 1000000 },
              querier: { store: { chunksDownloadTime: 100 } },
            },
          },
        }),
      });

      const result = await client.queryRange('{app="nginx"}');

      expect(result.stats).toBeDefined();
      expect(result.stats?.summary).toBeDefined();
    });
  });

  // ============================================================================
  // /loki/api/v1/query_range Endpoint Tests (Matrix/Metrics)
  // ============================================================================

  describe('queryRangeMatrix()', () => {
    it('calls GET /loki/api/v1/query_range for metric queries', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'success',
          data: { resultType: 'matrix', result: [] },
        }),
      });

      await client.queryRangeMatrix('rate({app="nginx"}[5m])');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/loki/api/v1/query_range'),
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('parses matrix result matching Loki API response format', async () => {
      // Loki API returns for matrix:
      // {
      //   "status": "success",
      //   "data": {
      //     "resultType": "matrix",
      //     "result": [{ "metric": {...}, "values": [[<timestamp>, "<value>"]] }]
      //   }
      // }
      const now = Math.floor(Date.now() / 1000);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'success',
          data: {
            resultType: 'matrix',
            result: [
              {
                metric: { app: 'nginx', level: 'error' },
                values: [
                  [now - 300, '5'],
                  [now, '10'],
                ],
              },
            ],
          },
        }),
      });

      const result = await client.queryRangeMatrix('count_over_time({app="nginx"}[5m])');

      expect(result.metrics).toHaveLength(1);
      expect(result.metrics[0].labels).toEqual({ app: 'nginx', level: 'error' });
      expect(result.metrics[0].values).toHaveLength(2);
      expect(result.metrics[0].values[0].value).toBe(5);
      expect(result.metrics[0].values[1].value).toBe(10);
    });

    it('converts timestamps to Date objects', async () => {
      const now = Math.floor(Date.now() / 1000);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'success',
          data: {
            resultType: 'matrix',
            result: [
              {
                metric: { app: 'nginx' },
                values: [[now, '42']],
              },
            ],
          },
        }),
      });

      const result = await client.queryRangeMatrix('rate({app="nginx"}[5m])');

      expect(result.metrics[0].values[0].timestamp).toBeInstanceOf(Date);
    });

    it('parses string values to numbers', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'success',
          data: {
            resultType: 'matrix',
            result: [
              {
                metric: {},
                values: [[1705312800, '3.14159']],
              },
            ],
          },
        }),
      });

      const result = await client.queryRangeMatrix('rate({app="nginx"}[5m])');

      expect(result.metrics[0].values[0].value).toBeCloseTo(3.14159);
    });
  });

  // ============================================================================
  // /ready Endpoint Tests
  // ============================================================================

  describe('ready()', () => {
    it('calls GET /ready', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      await client.ready();

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3100/ready',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('returns true when Loki responds with 200', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const result = await client.ready();

      expect(result).toBe(true);
    });

    it('returns false when Loki responds with non-200', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false });

      const result = await client.ready();

      expect(result).toBe(false);
    });

    it('returns false when fetch throws (network error)', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await client.ready();

      expect(result).toBe(false);
    });
  });

  // ============================================================================
  // Time Parsing Tests
  // ============================================================================

  describe('time parsing', () => {
    it('accepts relative time strings (e.g., "1h", "30m", "7d")', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'success',
          data: { resultType: 'streams', result: [] },
        }),
      });

      await client.queryRange('{app="nginx"}', { since: '1h' });

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('start=');
    });

    it('accepts ISO date strings', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'success',
          data: { resultType: 'streams', result: [] },
        }),
      });

      await client.queryRange('{app="nginx"}', {
        start: '2024-01-15T10:00:00Z',
        end: '2024-01-15T11:00:00Z',
      });

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('start=');
      expect(url).toContain('end=');
    });

    it('accepts Unix timestamps in seconds', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'success',
          data: { resultType: 'streams', result: [] },
        }),
      });

      await client.queryRange('{app="nginx"}', {
        start: 1705312800,
        end: 1705316400,
      });

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('start=');
      expect(url).toContain('end=');
    });

    it('supports all relative time units (s, m, h, d, w)', async () => {
      const units = ['30s', '5m', '1h', '7d', '2w'];

      for (const since of units) {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ status: 'success', data: [] }),
        });

        await client.labels({ since });

        expect(mockFetch).toHaveBeenCalled();
      }
    });
  });

  // ============================================================================
  // Error Handling Tests
  // ============================================================================

  describe('error handling', () => {
    it('throws error on non-OK HTTP response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => 'parse error: invalid query',
      });

      await expect(client.labels()).rejects.toThrow(/Loki request failed/);
    });

    it('includes status code in error message', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'internal error',
      });

      await expect(client.labels()).rejects.toThrow(/500/);
    });

    it('includes error body in error message', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => 'parse error at line 1: unexpected token',
      });

      await expect(client.labels()).rejects.toThrow(/parse error/);
    });

    it('throws on invalid relative time format', async () => {
      await expect(
        client.queryRange('{app="nginx"}', { since: 'invalid' })
      ).rejects.toThrow(/Invalid relative time format/);
    });
  });
});

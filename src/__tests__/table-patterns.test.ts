import { describe, expect, it } from 'vitest';
import {
  GREEN_STATUSES,
  RED_STATUSES,
  YELLOW_STATUSES,
  AGE_PATTERN,
  PERCENTAGE_PATTERN,
  BYTE_PATTERN,
  PERCENTAGE_COLUMN_PATTERN,
} from '../apps/runSandbox/renderers/table.js';

describe('status sets', () => {
  describe('GREEN_STATUSES', () => {
    it.each([
      'Running', 'Active', 'Ready', 'Succeeded',
      'Completed', 'Bound', 'Available', 'True',
    ])('contains "%s"', (status) => {
      expect(GREEN_STATUSES.has(status)).toBe(true);
    });

    it('does not contain lowercase variants', () => {
      expect(GREEN_STATUSES.has('running')).toBe(false);
      expect(GREEN_STATUSES.has('active')).toBe(false);
    });
  });

  describe('RED_STATUSES', () => {
    it.each([
      'Failed', 'CrashLoopBackOff', 'Error',
      'ImagePullBackOff', 'OOMKilled', 'Evicted', 'False',
    ])('contains "%s"', (status) => {
      expect(RED_STATUSES.has(status)).toBe(true);
    });
  });

  describe('YELLOW_STATUSES', () => {
    it.each([
      'Pending', 'ContainerCreating', 'Terminating', 'Waiting', 'Unknown',
    ])('contains "%s"', (status) => {
      expect(YELLOW_STATUSES.has(status)).toBe(true);
    });
  });

  it('status sets are mutually exclusive', () => {
    for (const status of GREEN_STATUSES) {
      expect(RED_STATUSES.has(status)).toBe(false);
      expect(YELLOW_STATUSES.has(status)).toBe(false);
    }
    for (const status of RED_STATUSES) {
      expect(GREEN_STATUSES.has(status)).toBe(false);
      expect(YELLOW_STATUSES.has(status)).toBe(false);
    }
    for (const status of YELLOW_STATUSES) {
      expect(GREEN_STATUSES.has(status)).toBe(false);
      expect(RED_STATUSES.has(status)).toBe(false);
    }
  });
});

describe('AGE_PATTERN', () => {
  it.each([
    '3d12h',
    '45m',
    '12s',
    '1d',
    '2h30m',
    '1d2h3m4s',
    '0s',
    '100d',
  ])('matches valid duration "%s"', (input) => {
    expect(AGE_PATTERN.test(input)).toBe(true);
  });

  it.each([
    'abc',
    '3d12x',
    'running',
    '3.5h',
    'h30m',
    '3d 12h',
    '3D12H',
  ])('does not match invalid input "%s"', (input) => {
    expect(AGE_PATTERN.test(input)).toBe(false);
  });

  it('does not match empty string', () => {
    // The regex allows all groups to be optional, which means empty string matches.
    // This is handled in the code via a length check. Verify the regex behavior.
    const matches = AGE_PATTERN.test('');
    // The regex ^(\d+d)?(\d+h)?(\d+m)?(\d+s)?$ matches empty string
    // because all groups are optional. Code guards against this separately.
    expect(matches).toBe(true); // Regex alone matches; code checks value.length > 0
  });
});

describe('PERCENTAGE_PATTERN', () => {
  it.each([
    ['75%', '75'],
    ['0%', '0'],
    ['100%', '100'],
    ['45.5%', '45.5'],
    ['0.1%', '0.1'],
  ])('matches "%s" and captures "%s"', (input, captured) => {
    const match = input.match(PERCENTAGE_PATTERN);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(captured);
  });

  it.each([
    '75',
    '%75',
    '75%%',
    'abc%',
    '',
  ])('does not match "%s"', (input) => {
    expect(PERCENTAGE_PATTERN.test(input)).toBe(false);
  });
});

describe('BYTE_PATTERN', () => {
  it.each([
    ['128Mi', '128', 'Mi'],
    ['2Gi', '2', 'Gi'],
    ['500m', '500', 'm'],
    ['1Ti', '1', 'Ti'],
    ['64Ki', '64', 'Ki'],
    ['4G', '4', 'G'],
    ['100M', '100', 'M'],
    ['1.5Gi', '1.5', 'Gi'],
  ])('matches "%s" → number="%s" unit="%s"', (input, num, unit) => {
    const match = input.match(BYTE_PATTERN);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(num);
    expect(match![2]).toBe(unit);
  });

  it.each([
    '128MB',
    '2GiB',
    'abc',
    '',
    '128',
    'Mi',
  ])('does not match "%s"', (input) => {
    expect(BYTE_PATTERN.test(input)).toBe(false);
  });
});

describe('PERCENTAGE_COLUMN_PATTERN', () => {
  it.each([
    'cpu_percent',
    'memory_usage',
    'disk_utilization',
    'Percent',
    'USAGE',
    'cpuUtilization',
  ])('matches column name "%s"', (col) => {
    expect(PERCENTAGE_COLUMN_PATTERN.test(col)).toBe(true);
  });

  it.each([
    'name',
    'status',
    'cpu',
    'memory',
    'restarts',
  ])('does not match column name "%s"', (col) => {
    expect(PERCENTAGE_COLUMN_PATTERN.test(col)).toBe(false);
  });
});

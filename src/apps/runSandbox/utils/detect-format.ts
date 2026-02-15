export type OutputFormat = 'json-table' | 'time-series' | 'plain-text' | 'interactive-table' | 'interactive-actions';

export interface InteractiveTableMeta {
  type: 'table';
  kind: string;
  identifiers: string[];
}

export interface InteractiveAction {
  id: string;
  label: string;
  description?: string;
  destructive?: boolean;
}

export interface InteractiveActionsMeta {
  type: 'actions';
  kind: string;
  resource: Record<string, unknown>;
}

const TIMESTAMP_KEYS = new Set([
  'timestamp', 'time', 'date', '@timestamp', 'ts', 'datetime',
  'created_at', 'updated_at', 'createdAt', 'updatedAt',
]);

function isTimestampKey(key: string): boolean {
  return TIMESTAMP_KEYS.has(key.toLowerCase());
}

function hasNumericValues(obj: Record<string, unknown>, excludeKey: string): boolean {
  return Object.entries(obj).some(
    ([k, v]) => k !== excludeKey && typeof v === 'number',
  );
}

export function detectFormat(output: string): { format: OutputFormat; parsed?: unknown } {
  const trimmed = output.trim();
  if (!trimmed) return { format: 'plain-text' };

  try {
    const parsed = JSON.parse(trimmed);

    // Interactive formats: object with _interactive property
    if (!Array.isArray(parsed) && typeof parsed === 'object' && parsed !== null && '_interactive' in parsed) {
      const obj = parsed as Record<string, unknown>;
      const meta = obj._interactive as Record<string, unknown> | undefined;
      if (meta?.type === 'table' && Array.isArray(obj.rows)) {
        return { format: 'interactive-table', parsed };
      }
      if (meta?.type === 'actions' && Array.isArray(obj.actions)) {
        return { format: 'interactive-actions', parsed };
      }
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      return { format: 'plain-text', parsed };
    }

    // Check if array of objects
    const first = parsed[0];
    if (typeof first !== 'object' || first === null || Array.isArray(first)) {
      return { format: 'plain-text', parsed };
    }

    const keys = Object.keys(first);

    // Check for time-series pattern
    if (parsed.length >= 3) {
      const tsKey = keys.find((k) => isTimestampKey(k));
      if (tsKey && hasNumericValues(first as Record<string, unknown>, tsKey)) {
        return { format: 'time-series', parsed };
      }
    }

    return { format: 'json-table', parsed };
  } catch {
    return { format: 'plain-text' };
  }
}

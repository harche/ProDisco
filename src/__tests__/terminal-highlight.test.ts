import { describe, expect, it } from 'vitest';
import { splitIntoSegments, highlightJson } from '../apps/runSandbox/renderers/terminal.js';

describe('splitIntoSegments', () => {
  it('returns single text segment for plain text', () => {
    const result = splitIntoSegments('hello world');
    expect(result).toEqual([{ type: 'text', content: 'hello world' }]);
  });

  it('returns single text segment for multi-line plain text', () => {
    const result = splitIntoSegments('line 1\nline 2\nline 3');
    expect(result).toEqual([{ type: 'text', content: 'line 1\nline 2\nline 3' }]);
  });

  it('returns single json segment for a JSON object', () => {
    const input = '{"key": "value"}';
    const result = splitIntoSegments(input);
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe('json');
    expect(result[0]!.parsed).toEqual({ key: 'value' });
  });

  it('returns single json segment for a JSON array', () => {
    const input = '[1, 2, 3]';
    const result = splitIntoSegments(input);
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe('json');
    expect(result[0]!.parsed).toEqual([1, 2, 3]);
  });

  it('handles multi-line JSON', () => {
    const input = '{\n  "name": "test",\n  "value": 42\n}';
    const result = splitIntoSegments(input);
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe('json');
    expect(result[0]!.parsed).toEqual({ name: 'test', value: 42 });
  });

  it('splits text before JSON', () => {
    const input = 'Output:\n{"result": true}';
    const result = splitIntoSegments(input);
    expect(result).toHaveLength(2);
    expect(result[0]!.type).toBe('text');
    expect(result[0]!.content).toBe('Output:');
    expect(result[1]!.type).toBe('json');
    expect(result[1]!.parsed).toEqual({ result: true });
  });

  it('splits JSON followed by text', () => {
    const input = '{"a":1}\nDone.';
    const result = splitIntoSegments(input);
    expect(result).toHaveLength(2);
    expect(result[0]!.type).toBe('json');
    expect(result[1]!.type).toBe('text');
    expect(result[1]!.content).toBe('Done.');
  });

  it('splits text + JSON + text', () => {
    const input = 'Start\n{"x":1}\nEnd';
    const result = splitIntoSegments(input);
    expect(result).toHaveLength(3);
    expect(result[0]!.type).toBe('text');
    expect(result[1]!.type).toBe('json');
    expect(result[2]!.type).toBe('text');
  });

  it('treats invalid JSON starting with { as plain text', () => {
    const input = '{not valid json at all';
    const result = splitIntoSegments(input);
    expect(result).toEqual([{ type: 'text', content: '{not valid json at all' }]);
  });

  it('merges consecutive text lines into one segment', () => {
    const input = 'line1\nline2\n{"a":1}\nline3\nline4';
    const result = splitIntoSegments(input);
    expect(result).toHaveLength(3);
    expect(result[0]!.type).toBe('text');
    expect(result[0]!.content).toBe('line1\nline2');
    expect(result[1]!.type).toBe('json');
    expect(result[2]!.type).toBe('text');
    expect(result[2]!.content).toBe('line3\nline4');
  });

  it('handles multiple JSON blocks', () => {
    const input = '{"a":1}\n{"b":2}';
    const result = splitIntoSegments(input);
    expect(result).toHaveLength(2);
    expect(result[0]!.type).toBe('json');
    expect(result[0]!.parsed).toEqual({ a: 1 });
    expect(result[1]!.type).toBe('json');
    expect(result[1]!.parsed).toEqual({ b: 2 });
  });

  it('handles empty string', () => {
    const result = splitIntoSegments('');
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe('text');
    expect(result[0]!.content).toBe('');
  });
});

describe('highlightJson', () => {
  it('wraps object keys with jt-key class', () => {
    const result = highlightJson({ name: 'test' });
    expect(result).toContain('<span class="jt-key">"name"</span>');
  });

  it('wraps string values with jt-string class', () => {
    const result = highlightJson({ name: 'test' });
    expect(result).toContain('<span class="jt-string">"test"</span>');
  });

  it('wraps numbers with jt-number class', () => {
    const result = highlightJson({ count: 42 });
    expect(result).toContain('<span class="jt-number">42</span>');
  });

  it('wraps booleans with jt-boolean class', () => {
    const result = highlightJson({ ready: true });
    expect(result).toContain('<span class="jt-boolean">true</span>');
  });

  it('wraps null with jt-null class', () => {
    const result = highlightJson({ value: null });
    expect(result).toContain('<span class="jt-null">null</span>');
  });

  it('escapes HTML entities in string values', () => {
    const result = highlightJson({ html: '<b>bold</b>' });
    expect(result).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(result).not.toContain('<b>');
  });

  it('does not double-wrap keys as strings', () => {
    const result = highlightJson({ name: 'val' });
    // Key "name" should appear once as jt-key, not also as jt-string
    const keyMatches = result.match(/class="jt-key">"name"/g);
    expect(keyMatches).toHaveLength(1);
    // "name" should not appear as jt-string
    expect(result).not.toContain('<span class="jt-string">"name"</span>');
  });

  it('preserves pretty-print indentation', () => {
    const result = highlightJson({ a: 1 });
    // JSON.stringify(obj, null, 2) produces indented output
    expect(result).toContain('\n');
    expect(result).toContain('  ');
  });
});

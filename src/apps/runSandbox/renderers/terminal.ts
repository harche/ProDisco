export interface Segment {
  type: 'text' | 'json';
  content: string;
  parsed?: unknown;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function highlightJson(obj: unknown): string {
  return highlightValue(obj, 0);
}

function highlightValue(value: unknown, depth: number): string {
  if (value === null) return '<span class="jt-null">null</span>';
  if (typeof value === 'boolean') return `<span class="jt-boolean">${value}</span>`;
  if (typeof value === 'number') return `<span class="jt-number">${value}</span>`;
  if (typeof value === 'string') return `<span class="jt-string">"${escapeHtml(value)}"</span>`;

  const pad = '  '.repeat(depth);
  const padInner = '  '.repeat(depth + 1);

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((v, i) => {
      const comma = i < value.length - 1 ? ',' : '';
      return `${padInner}${highlightValue(v, depth + 1)}${comma}`;
    });
    return `[\n${items.join('\n')}\n${pad}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    const items = entries.map(([k, v], i) => {
      const comma = i < entries.length - 1 ? ',' : '';
      return `${padInner}<span class="jt-key">"${escapeHtml(k)}"</span>: ${highlightValue(v, depth + 1)}${comma}`;
    });
    return `{\n${items.join('\n')}\n${pad}}`;
  }

  return escapeHtml(String(value));
}

export function splitIntoSegments(text: string): Segment[] {
  const lines = text.split('\n');
  const segments: Segment[] = [];
  let i = 0;

  while (i < lines.length) {
    const trimmed = lines[i].trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      // Try to accumulate lines to form valid JSON
      let found = false;
      for (let end = i; end < lines.length; end++) {
        const candidate = lines.slice(i, end + 1).join('\n');
        try {
          const parsed = JSON.parse(candidate);
          // Successfully parsed JSON block
          segments.push({ type: 'json', content: candidate, parsed });
          i = end + 1;
          found = true;
          break;
        } catch {
          // Keep accumulating
        }
      }
      if (!found) {
        // Could not parse as JSON, treat this line as plain text
        segments.push({ type: 'text', content: lines[i] });
        i++;
      }
    } else {
      // Plain text line
      segments.push({ type: 'text', content: lines[i] });
      i++;
    }
  }

  // Merge consecutive text segments
  const merged: Segment[] = [];
  for (const seg of segments) {
    if (seg.type === 'text' && merged.length > 0 && merged[merged.length - 1].type === 'text') {
      merged[merged.length - 1].content += '\n' + seg.content;
    } else {
      merged.push(seg);
    }
  }

  return merged;
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split('\n').length;
}

export function renderTerminal(container: HTMLElement, text: string): void {
  const wrapper = document.createElement('div');
  wrapper.className = 'terminal';

  const pre = document.createElement('pre');

  const segments = splitIntoSegments(text);

  for (const seg of segments) {
    const code = document.createElement('code');
    if (seg.type === 'json' && seg.parsed !== undefined) {
      code.className = 'terminal-json';
      code.innerHTML = highlightJson(seg.parsed);
    } else {
      code.textContent = seg.content;
    }
    pre.appendChild(code);
  }

  wrapper.appendChild(pre);

  // Collapse long output
  const totalLines = countLines(text);
  if (totalLines > 50) {
    pre.style.maxHeight = '20lh';
    pre.style.overflow = 'hidden';

    const button = document.createElement('button');
    button.className = 'terminal-collapse';
    button.textContent = `Show all ${totalLines} lines`;
    let expanded = false;

    button.addEventListener('click', () => {
      expanded = !expanded;
      if (expanded) {
        pre.style.maxHeight = 'none';
        pre.style.overflow = 'visible';
        button.textContent = 'Show less';
      } else {
        pre.style.maxHeight = '20lh';
        pre.style.overflow = 'hidden';
        button.textContent = `Show all ${totalLines} lines`;
      }
    });

    wrapper.appendChild(button);
  }

  container.appendChild(wrapper);
}

import { copyToClipboard } from '../utils/copy';

function getType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '\u2026';
}

function renderPreview(value: unknown): string {
  const type = getType(value);
  switch (type) {
    case 'string':
      return `<span class="jt-string">"${escapeHtml(truncate(value as string, 80))}"</span>`;
    case 'number':
      return `<span class="jt-number">${value}</span>`;
    case 'boolean':
      return `<span class="jt-boolean">${value}</span>`;
    case 'null':
      return '<span class="jt-null">null</span>';
    case 'array': {
      const arr = value as unknown[];
      return `<span class="jt-bracket">[</span><span class="jt-count">${arr.length} item${arr.length !== 1 ? 's' : ''}</span><span class="jt-bracket">]</span>`;
    }
    case 'object': {
      const keys = Object.keys(value as Record<string, unknown>);
      return `<span class="jt-bracket">{</span><span class="jt-count">${keys.length} key${keys.length !== 1 ? 's' : ''}</span><span class="jt-bracket">}</span>`;
    }
    default:
      return escapeHtml(String(value));
  }
}

function isExpandable(value: unknown): boolean {
  const type = getType(value);
  return type === 'object' || type === 'array';
}

function buildPath(parentPath: string, key: string | number): string {
  if (parentPath === '') return String(key);
  if (typeof key === 'number') return `${parentPath}[${key}]`;
  // If the key contains dots or special chars, use bracket notation
  if (/[.[\]\s]/.test(key)) return `${parentPath}["${key}"]`;
  return `${parentPath}.${key}`;
}

function createNode(
  key: string | number | null,
  value: unknown,
  path: string,
  depth: number,
  defaultExpandDepth: number,
): HTMLElement {
  const type = getType(value);
  const expandable = isExpandable(value);

  if (expandable) {
    const details = document.createElement('details');
    details.className = 'jt-node';
    if (depth < defaultExpandDepth) {
      details.open = true;
    }

    const summary = document.createElement('summary');
    summary.className = 'jt-summary';
    summary.style.paddingLeft = `${depth * 16}px`;

    // Key label
    if (key !== null) {
      const keySpan = document.createElement('span');
      keySpan.className = 'jt-key';
      keySpan.textContent = String(key);
      keySpan.title = `Click to copy path: ${path}`;
      keySpan.style.cursor = 'pointer';
      keySpan.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        copyToClipboard(path).then((ok) => {
          keySpan.classList.add('jt-path-copied');
          keySpan.title = ok ? 'Copied!' : 'Failed to copy';
          setTimeout(() => {
            keySpan.classList.remove('jt-path-copied');
            keySpan.title = `Click to copy path: ${path}`;
          }, 1200);
        });
      });
      summary.appendChild(keySpan);

      const colon = document.createElement('span');
      colon.className = 'jt-colon';
      colon.textContent = ': ';
      summary.appendChild(colon);
    }

    // Preview (shown in collapsed summary)
    const preview = document.createElement('span');
    preview.className = 'jt-preview';
    preview.innerHTML = renderPreview(value);
    summary.appendChild(preview);

    details.appendChild(summary);

    // Children container
    const children = document.createElement('div');
    children.className = 'jt-children';

    if (type === 'array') {
      const arr = value as unknown[];
      for (let i = 0; i < arr.length; i++) {
        const childPath = buildPath(path, i);
        children.appendChild(createNode(i, arr[i], childPath, depth + 1, defaultExpandDepth));
      }
    } else {
      const obj = value as Record<string, unknown>;
      for (const k of Object.keys(obj)) {
        const childPath = buildPath(path, k);
        children.appendChild(createNode(k, obj[k], childPath, depth + 1, defaultExpandDepth));
      }
    }

    details.appendChild(children);
    return details;
  }

  // Leaf node (non-expandable)
  const div = document.createElement('div');
  div.className = 'jt-leaf';
  div.style.paddingLeft = `${depth * 16}px`;

  if (key !== null) {
    const keySpan = document.createElement('span');
    keySpan.className = 'jt-key';
    keySpan.textContent = String(key);
    keySpan.title = `Click to copy path: ${path}`;
    keySpan.style.cursor = 'pointer';
    keySpan.addEventListener('click', (e) => {
      e.stopPropagation();
      copyToClipboard(path).then((ok) => {
        keySpan.classList.add('jt-path-copied');
        keySpan.title = ok ? 'Copied!' : 'Failed to copy';
        setTimeout(() => {
          keySpan.classList.remove('jt-path-copied');
          keySpan.title = `Click to copy path: ${path}`;
        }, 1200);
      });
    });
    div.appendChild(keySpan);

    const colon = document.createElement('span');
    colon.className = 'jt-colon';
    colon.textContent = ': ';
    div.appendChild(colon);
  }

  const valSpan = document.createElement('span');
  valSpan.className = `jt-value jt-${type}`;
  if (type === 'string') {
    valSpan.textContent = `"${value as string}"`;
  } else {
    valSpan.textContent = String(value);
  }
  div.appendChild(valSpan);

  return div;
}

function applySearch(container: HTMLElement, term: string): void {
  const nodes = container.querySelectorAll<HTMLElement>('.jt-node, .jt-leaf');

  if (!term) {
    // Reset: show everything, remove highlights
    for (const node of nodes) {
      node.classList.remove('jt-hidden', 'jt-highlight');
    }
    return;
  }

  // First pass: mark direct matches
  const matchSet = new Set<HTMLElement>();
  for (const node of nodes) {
    const isDirectMatch = matchesDirectly(node, term);
    if (isDirectMatch) {
      matchSet.add(node);
      node.classList.add('jt-highlight');
      node.classList.remove('jt-hidden');
      // Expand all parent <details> to show match
      let parent = node.parentElement;
      while (parent && parent !== container) {
        if (parent.tagName === 'DETAILS') {
          (parent as HTMLDetailsElement).open = true;
          matchSet.add(parent as HTMLElement);
          parent.classList.remove('jt-hidden');
          parent.classList.remove('jt-highlight');
        }
        parent = parent.parentElement;
      }
    } else {
      node.classList.remove('jt-highlight');
    }
  }

  // Second pass: hide non-matching nodes that have no matching descendants
  for (const node of nodes) {
    if (matchSet.has(node)) continue;
    // Check if any child is in matchSet
    const hasMatchingChild = Array.from(node.querySelectorAll<HTMLElement>('.jt-node, .jt-leaf'))
      .some((child) => matchSet.has(child));
    if (hasMatchingChild) {
      node.classList.remove('jt-hidden');
      if (node.tagName === 'DETAILS') {
        (node as HTMLDetailsElement).open = true;
      }
    } else {
      node.classList.add('jt-hidden');
    }
  }
}

function matchesDirectly(node: HTMLElement, term: string): boolean {
  // Only check immediate key/value spans (not children)
  const directChildren = node.tagName === 'DETAILS'
    ? node.querySelector('.jt-summary')?.children
    : node.children;
  if (!directChildren) return false;
  for (const child of directChildren) {
    if (child.classList.contains('jt-key') && child.textContent?.toLowerCase().includes(term)) return true;
    if (child.classList.contains('jt-value') && child.textContent?.toLowerCase().includes(term)) return true;
    if (child.classList.contains('jt-string') && child.textContent?.toLowerCase().includes(term)) return true;
    if (child.classList.contains('jt-number') && child.textContent?.toLowerCase().includes(term)) return true;
    if (child.classList.contains('jt-boolean') && child.textContent?.toLowerCase().includes(term)) return true;
    if (child.classList.contains('jt-null') && child.textContent?.toLowerCase().includes(term)) return true;
  }
  return false;
}

export function renderJsonTree(container: HTMLElement, data: unknown): void {
  const wrapper = document.createElement('div');
  wrapper.className = 'json-tree';

  // Search bar
  const searchContainer = document.createElement('div');
  searchContainer.className = 'json-tree__search';
  const searchBar = document.createElement('input');
  searchBar.type = 'text';
  searchBar.placeholder = 'Search keys and values\u2026';
  searchContainer.appendChild(searchBar);
  wrapper.appendChild(searchContainer);

  // Tree content container
  const treeContent = document.createElement('div');
  treeContent.className = 'jt-root';

  const rootNode = createNode(null, data, '', 0, 2);
  treeContent.appendChild(rootNode);
  wrapper.appendChild(treeContent);

  // Wire up search
  let searchTimeout: ReturnType<typeof setTimeout> | undefined;
  searchBar.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      const term = searchBar.value.trim().toLowerCase();
      applySearch(treeContent, term);
    }, 200);
  });

  container.appendChild(wrapper);
}

type SortState = { column: string; ascending: boolean } | null;

export interface TableInteractivity {
  identifiers: string[];
  kind: string;
  onCellClick: (column: string, value: unknown, row: Record<string, unknown>) => void;
}

export const GREEN_STATUSES = new Set([
  'Running', 'Active', 'Ready', 'Succeeded', 'Completed', 'Bound', 'Available', 'True',
]);
export const RED_STATUSES = new Set([
  'Failed', 'CrashLoopBackOff', 'Error', 'ImagePullBackOff', 'OOMKilled', 'Evicted', 'False',
]);
export const YELLOW_STATUSES = new Set([
  'Pending', 'ContainerCreating', 'Terminating', 'Waiting', 'Unknown',
]);

export const AGE_PATTERN = /^(\d+d)?(\d+h)?(\d+m)?(\d+s)?$/;
export const PERCENTAGE_PATTERN = /^([\d.]+)%$/;
export const BYTE_PATTERN = /^([\d.]+)(Mi|Gi|Ti|Ki|m|k|M|G|T)$/;
export const PERCENTAGE_COLUMN_PATTERN = /percent|usage|utilization/i;

function formatCellValue(value: unknown, columnName: string): HTMLElement | string {
  // Null/undefined
  if (value == null) {
    const span = document.createElement('span');
    span.className = 'cell-dim';
    span.textContent = '\u2014';
    return span;
  }

  // Boolean values
  if (typeof value === 'boolean') {
    const span = document.createElement('span');
    span.className = `cell-bool ${value ? 'cell-bool--true' : 'cell-bool--false'}`;
    span.textContent = value ? '\u2713' : '\u2717';
    return span;
  }

  // Objects — fall through to JSON string
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }

  const str = String(value);

  // K8s status values
  if (typeof value === 'string') {
    let dotColor: string | null = null;
    if (GREEN_STATUSES.has(value)) dotColor = 'green';
    else if (RED_STATUSES.has(value)) dotColor = 'red';
    else if (YELLOW_STATUSES.has(value)) dotColor = 'yellow';

    if (dotColor) {
      const span = document.createElement('span');
      span.className = 'cell-status';
      const dot = document.createElement('span');
      dot.className = `cell-status__dot cell-status__dot--${dotColor}`;
      span.appendChild(dot);
      span.appendChild(document.createTextNode(value));
      return span;
    }
  }

  // Age/duration strings (e.g. 3d12h, 45m, 12s)
  if (typeof value === 'string' && AGE_PATTERN.test(value) && value.length > 0) {
    const span = document.createElement('span');
    // Split into number and unit parts
    const parts = value.match(/(\d+)([dhms])/g);
    if (parts) {
      for (const part of parts) {
        const numMatch = part.match(/^(\d+)([dhms])$/);
        if (numMatch) {
          span.appendChild(document.createTextNode(numMatch[1]));
          const unit = document.createElement('span');
          unit.className = 'cell-unit';
          unit.textContent = numMatch[2];
          span.appendChild(unit);
        }
      }
      return span;
    }
  }

  // Percentage values — string with % suffix
  const pctMatch = str.match(PERCENTAGE_PATTERN);
  if (pctMatch) {
    const num = parseFloat(pctMatch[1]);
    return createProgressCell(num, str);
  }

  // Percentage by column name (numeric value in a percent/usage/utilization column)
  if (typeof value === 'number' && PERCENTAGE_COLUMN_PATTERN.test(columnName)) {
    return createProgressCell(value, `${value}%`);
  }

  // Byte/resource values (128Mi, 2Gi, 500m)
  const byteMatch = str.match(BYTE_PATTERN);
  if (byteMatch) {
    const span = document.createElement('span');
    span.appendChild(document.createTextNode(byteMatch[1]));
    const unit = document.createElement('span');
    unit.className = 'cell-unit';
    unit.textContent = byteMatch[2];
    span.appendChild(unit);
    return span;
  }

  // Default: plain string
  return str;
}

function createProgressCell(percent: number, label: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'cell-progress';
  span.style.setProperty('--progress', `${Math.min(100, Math.max(0, percent))}%`);
  span.textContent = label;
  return span;
}

export function renderTable(container: HTMLElement, data: Record<string, unknown>[], interactivity?: TableInteractivity): void {
  if (data.length === 0) {
    container.textContent = 'Empty result set.';
    return;
  }

  const columns = Array.from(new Set(data.flatMap((row) => Object.keys(row))));
  let sortState: SortState = null;
  let filterTerm = '';
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  function render() {
    // Filter
    const filtered = filterTerm
      ? data.filter((row) => {
          const term = filterTerm.toLowerCase();
          return columns.some((col) => {
            const v = row[col];
            if (v == null) return false;
            const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
            return s.toLowerCase().includes(term);
          });
        })
      : data;

    // Sort
    const sorted = sortState
      ? [...filtered].sort((a, b) => {
          const av = a[sortState!.column];
          const bv = b[sortState!.column];
          if (av == null && bv == null) return 0;
          if (av == null) return 1;
          if (bv == null) return -1;
          if (typeof av === 'number' && typeof bv === 'number') {
            return sortState!.ascending ? av - bv : bv - av;
          }
          const sa = String(av);
          const sb = String(bv);
          return sortState!.ascending ? sa.localeCompare(sb) : sb.localeCompare(sa);
        })
      : filtered;

    const wrapper = document.createElement('div');
    wrapper.className = 'table-container';

    // Info bar
    const info = document.createElement('div');
    info.className = 'table-info';
    let infoText: string;
    if (filterTerm) {
      infoText = `${filtered.length} of ${data.length} row${data.length !== 1 ? 's' : ''} \u00d7 ${columns.length} column${columns.length !== 1 ? 's' : ''}`;
    } else {
      infoText = `${data.length} row${data.length !== 1 ? 's' : ''} \u00d7 ${columns.length} column${columns.length !== 1 ? 's' : ''}`;
    }
    if (interactivity) {
      infoText += ' \u00b7 Click a highlighted cell to see actions';
    }
    info.textContent = infoText;
    wrapper.appendChild(info);

    // Search bar
    const searchContainer = document.createElement('div');
    searchContainer.className = 'table-search';

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'table-search__input';
    searchInput.placeholder = 'Filter rows...';
    searchInput.value = filterTerm;

    const clearBtn = document.createElement('button');
    clearBtn.className = 'table-search__clear';
    clearBtn.textContent = '\u00d7';
    clearBtn.style.display = filterTerm ? '' : 'none';

    searchInput.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        filterTerm = searchInput.value;
        render();
      }, 150);
    });

    clearBtn.addEventListener('click', () => {
      filterTerm = '';
      render();
    });

    searchContainer.appendChild(searchInput);
    searchContainer.appendChild(clearBtn);
    wrapper.appendChild(searchContainer);

    const table = document.createElement('table');

    // Header
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const col of columns) {
      const th = document.createElement('th');
      th.textContent = col;

      const indicator = document.createElement('span');
      indicator.className = 'sort-indicator';
      if (sortState?.column === col) {
        indicator.classList.add('active');
        indicator.textContent = sortState.ascending ? ' \u25b2' : ' \u25bc';
      } else {
        indicator.textContent = ' \u25b8';
      }
      th.appendChild(indicator);

      th.addEventListener('click', () => {
        if (sortState?.column === col) {
          sortState = { column: col, ascending: !sortState.ascending };
        } else {
          sortState = { column: col, ascending: true };
        }
        render();
      });

      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Body
    const tbody = document.createElement('tbody');
    for (const row of sorted) {
      const tr = document.createElement('tr');
      for (const col of columns) {
        const td = document.createElement('td');
        const value = row[col];

        // Format cell value
        const formatted = formatCellValue(value, col);
        if (typeof formatted === 'string') {
          td.textContent = formatted;
        } else {
          td.appendChild(formatted);
        }

        // Tooltip
        td.title = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);

        if (interactivity && interactivity.identifiers.includes(col)) {
          td.classList.add('cell-interactive');
          td.addEventListener('click', () => {
            interactivity.onCellClick(col, value, row);
          });
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrapper.appendChild(table);

    container.innerHTML = '';
    container.appendChild(wrapper);

    // Restore focus to search input if it was focused
    if (filterTerm) {
      const newInput = wrapper.querySelector('.table-search__input') as HTMLInputElement | null;
      if (newInput) {
        newInput.focus();
        newInput.setSelectionRange(newInput.value.length, newInput.value.length);
      }
    }
  }

  render();
}

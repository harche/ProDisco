type SortState = { column: string; ascending: boolean } | null;

export interface TableInteractivity {
  identifiers: string[];
  kind: string;
  onCellClick: (column: string, value: unknown, row: Record<string, unknown>) => void;
}

export function renderTable(container: HTMLElement, data: Record<string, unknown>[], interactivity?: TableInteractivity): void {
  if (data.length === 0) {
    container.textContent = 'Empty result set.';
    return;
  }

  const columns = Array.from(new Set(data.flatMap((row) => Object.keys(row))));
  let sortState: SortState = null;

  function render() {
    const sorted = sortState
      ? [...data].sort((a, b) => {
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
      : data;

    const wrapper = document.createElement('div');
    wrapper.className = 'table-container';

    const info = document.createElement('div');
    info.className = 'table-info';
    let infoText = `${data.length} row${data.length !== 1 ? 's' : ''} \u00d7 ${columns.length} column${columns.length !== 1 ? 's' : ''}`;
    if (interactivity) {
      infoText += ' \u00b7 Click a highlighted cell to see actions';
    }
    info.textContent = infoText;
    wrapper.appendChild(info);

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
        td.textContent = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
        td.title = td.textContent;
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
  }

  render();
}

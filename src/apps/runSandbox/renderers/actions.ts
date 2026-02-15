import type { InteractiveAction } from '../utils/detect-format';

export interface ActionsConfig {
  kind: string;
  resource: Record<string, unknown>;
  actions: InteractiveAction[];
  onActionClick: (actionId: string, kind: string, resource: Record<string, unknown>) => void;
}

export function renderActions(container: HTMLElement, config: ActionsConfig): void {
  const panel = document.createElement('div');
  panel.className = 'actions-panel';

  // Header: kind badge + resource name + namespace
  const header = document.createElement('div');
  header.className = 'actions-panel__header';

  const kindBadge = document.createElement('span');
  kindBadge.className = 'badge badge--mode';
  kindBadge.textContent = config.kind;
  header.appendChild(kindBadge);

  const name = config.resource.name ?? config.resource.Name;
  if (name) {
    const nameEl = document.createElement('span');
    nameEl.className = 'actions-panel__name';
    nameEl.textContent = String(name);
    header.appendChild(nameEl);
  }

  const ns = config.resource.namespace ?? config.resource.Namespace;
  if (ns) {
    const nsEl = document.createElement('span');
    nsEl.className = 'meta-text';
    nsEl.textContent = String(ns);
    header.appendChild(nsEl);
  }

  panel.appendChild(header);

  // Button grid
  const grid = document.createElement('div');
  grid.className = 'actions-panel__grid';

  for (const action of config.actions) {
    const btn = document.createElement('button');
    btn.className = 'actions-panel__btn';
    if (action.destructive) {
      btn.classList.add('actions-panel__btn--destructive');
    }

    const label = document.createElement('span');
    label.className = 'actions-panel__btn-label';
    label.textContent = action.label;
    btn.appendChild(label);

    if (action.description) {
      const desc = document.createElement('span');
      desc.className = 'actions-panel__btn-desc';
      desc.textContent = action.description;
      btn.appendChild(desc);
    }

    btn.addEventListener('click', () => {
      config.onActionClick(action.id, config.kind, config.resource);
    });

    grid.appendChild(btn);
  }

  panel.appendChild(grid);
  container.appendChild(panel);
}

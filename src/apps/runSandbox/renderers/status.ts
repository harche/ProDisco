interface StatusData {
  mode: string;
  executionId?: string;
  state?: string;
  message?: string;
  output?: string;
  success?: boolean;
  executions?: Array<{
    executionId: string;
    state: string;
    codePreview: string;
  }>;
  totalCount?: number;
}

export function renderStatus(container: HTMLElement, result: StatusData): void {
  const card = document.createElement('div');
  card.className = 'status-card';

  const header = document.createElement('div');
  header.className = 'status-header';

  const modeBadge = document.createElement('span');
  modeBadge.className = 'badge badge--mode';
  modeBadge.textContent = result.mode;
  header.appendChild(modeBadge);

  if (result.state) {
    const stateBadge = document.createElement('span');
    const isSuccess = result.state === 'completed' || result.success === true;
    const isError = result.state === 'failed' || result.state === 'cancelled' || result.state === 'timeout';
    stateBadge.className = `badge ${isSuccess ? 'badge--success' : isError ? 'badge--error' : ''}`;
    stateBadge.textContent = result.state;
    header.appendChild(stateBadge);
  }

  card.appendChild(header);

  // Fields
  if (result.executionId) {
    addField(card, 'Execution ID', result.executionId);
  }

  if (result.message) {
    addField(card, 'Message', result.message);
  }

  // List mode: show executions
  if (result.mode === 'list' && result.executions) {
    addField(card, 'Total', String(result.totalCount ?? result.executions.length));
    for (const exec of result.executions) {
      const execDiv = document.createElement('div');
      execDiv.className = 'status-field';
      execDiv.innerHTML = `<span class="label">${exec.executionId}</span> [${exec.state}]: ${escapeHtml(exec.codePreview)}`;
      card.appendChild(execDiv);
    }
  }

  // Output preview
  if (result.output) {
    const preview = document.createElement('div');
    preview.className = 'status-preview';
    preview.textContent = result.output.slice(0, 1000);
    if (result.output.length > 1000) {
      preview.textContent += '\n... (truncated)';
    }
    card.appendChild(preview);
  }

  container.appendChild(card);
}

function addField(parent: HTMLElement, label: string, value: string): void {
  const div = document.createElement('div');
  div.className = 'status-field';
  div.innerHTML = `<span class="label">${label}:</span> ${escapeHtml(value)}`;
  parent.appendChild(div);
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

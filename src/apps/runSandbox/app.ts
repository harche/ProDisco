import { App } from '@modelcontextprotocol/ext-apps';
import { detectFormat } from './utils/detect-format';
import type { InteractiveTableMeta, InteractiveActionsMeta, InteractiveAction } from './utils/detect-format';
import { copyToClipboard } from './utils/copy';
import { renderTable } from './renderers/table';
import { renderChart, type ChartInteractivity } from './renderers/chart';
import { renderTerminal } from './renderers/terminal';
import { renderTestResults } from './renderers/test-results';
import { renderStatus } from './renderers/status';
import { renderActions } from './renderers/actions';
import { renderJsonTree } from './renderers/json-tree';

const metadataBar = document.getElementById('metadata-bar')!;
const contentEl = document.getElementById('content')!;

const app = new App({ name: 'prodisco-runSandbox', version: '1.0.0' });

/** Last tool input arguments — captured via ontoolinput for re-run support. */
let lastToolInput: Record<string, unknown> | null = null;

interface ToolResult {
  mode?: string;
  success?: boolean;
  output?: string;
  error?: string;
  errorOutput?: string;
  executionTimeMs?: number;
  cachedScript?: string;
  cached?: { name: string };
  summary?: { total: number; passed: number; failed: number; skipped: number };
  tests?: Array<{ name: string; passed: boolean; error?: string; durationMs: number }>;
  executionId?: string;
  state?: string;
  message?: string;
  executions?: Array<{ executionId: string; state: string; codePreview: string }>;
  totalCount?: number;
}

function renderMetadata(result: ToolResult): void {
  metadataBar.innerHTML = '';

  // Success/fail badge
  if (result.success !== undefined) {
    const badge = document.createElement('span');
    badge.className = `badge ${result.success ? 'badge--success' : 'badge--error'}`;
    badge.textContent = result.success ? 'Success' : 'Failed';
    metadataBar.appendChild(badge);
  }

  // Mode badge
  if (result.mode) {
    const modeBadge = document.createElement('span');
    modeBadge.className = 'badge badge--mode';
    modeBadge.textContent = result.mode;
    metadataBar.appendChild(modeBadge);
  }

  // Execution time
  if (result.executionTimeMs !== undefined) {
    const sep = document.createElement('span');
    sep.className = 'meta-sep';
    sep.textContent = '\u00b7';
    metadataBar.appendChild(sep);

    const time = document.createElement('span');
    time.className = 'meta-text';
    time.textContent = `${result.executionTimeMs}ms`;
    metadataBar.appendChild(time);
  }

  // Cached script name
  const scriptName = result.cachedScript ?? result.cached?.name;
  if (scriptName) {
    const sep = document.createElement('span');
    sep.className = 'meta-sep';
    sep.textContent = '\u00b7';
    metadataBar.appendChild(sep);

    const cached = document.createElement('span');
    cached.className = 'meta-text';
    cached.textContent = `cached: ${scriptName}`;
    metadataBar.appendChild(cached);
  }

  // Action buttons
  const actions = document.createElement('div');
  actions.className = 'actions';

  // Copy button
  const rawOutput = result.output ?? result.error ?? '';
  if (rawOutput) {
    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', async () => {
      const ok = await copyToClipboard(rawOutput);
      copyBtn.textContent = ok ? 'Copied!' : 'Failed';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
    });
    actions.appendChild(copyBtn);
  }

  // Re-run button — prefer cached script name, fall back to replaying original input
  const rerunArgs: Record<string, unknown> | null = scriptName
    ? { mode: 'execute', cached: scriptName }
    : lastToolInput;

  if (rerunArgs) {
    const rerunBtn = document.createElement('button');
    rerunBtn.className = 'btn btn--primary';
    rerunBtn.textContent = 'Re-run';
    rerunBtn.addEventListener('click', async () => {
      rerunBtn.disabled = true;
      rerunBtn.textContent = 'Running\u2026';
      // Show loading indicator while the script executes
      contentEl.innerHTML = '';
      const loadingEl = document.createElement('div');
      loadingEl.className = 'loading';
      loadingEl.textContent = 'Running script\u2026';
      contentEl.appendChild(loadingEl);
      try {
        const callResult = await app.callServerTool({
          name: 'prodisco_runSandbox',
          arguments: rerunArgs,
        });
        renderResult(extractResult(callResult));
      } catch (err) {
        contentEl.innerHTML = '';
        renderTerminal(contentEl, `Re-run failed: ${err}`);
        rerunBtn.textContent = 'Re-run';
        rerunBtn.disabled = false;
      }
    });
    actions.appendChild(rerunBtn);
  }

  metadataBar.appendChild(actions);
}

async function sendInteractiveMessage(text: string): Promise<void> {
  const feedbackEl = document.createElement('div');
  feedbackEl.className = 'interactive-feedback interactive-feedback--sending';
  feedbackEl.textContent = 'Sending\u2026';
  contentEl.appendChild(feedbackEl);

  try {
    await app.sendMessage({
      role: 'user',
      content: [{ type: 'text', text }],
    });
    feedbackEl.className = 'interactive-feedback interactive-feedback--success';
    feedbackEl.textContent = 'Sent';
  } catch (err) {
    feedbackEl.className = 'interactive-feedback interactive-feedback--error';
    feedbackEl.textContent = `Error: ${err}`;
  }
}

function findIdentifierColumns(data: Record<string, unknown>[]): string[] {
  if (data.length === 0) return [];
  const columns = Object.keys(data[0]);
  const nameCol = columns.find((c) => c.toLowerCase() === 'name');
  return nameCol ? [nameCol] : [];
}

function handleCellClick(column: string, value: unknown, row: Record<string, unknown>): void {
  const message =
    `[Interactive UI] User clicked "${value}" in column "${column}".\n` +
    `Row data: ${JSON.stringify(row)}\n\n` +
    `Please determine and display the available actions for this resource.`;
  sendInteractiveMessage(message);
}

function handleActionClick(actionId: string, kind: string, resource: Record<string, unknown>): void {
  const name = resource.name ?? resource.Name ?? '';
  const ns = resource.namespace ?? resource.Namespace ?? '';
  const message =
    `[Interactive UI] User selected an action from the actions panel.\n` +
    `Action: ${actionId}\n` +
    `Resource kind: ${kind}\n` +
    `Resource name: ${name}\n` +
    (ns ? `Namespace: ${ns}\n` : '') +
    `\nPlease execute this action using searchTools and runSandbox.`;
  sendInteractiveMessage(message);
}

function handleChartQuery(query: string): void {
  const message =
    `[Interactive UI] User requested a new chart query: ${query}\n` +
    `Please execute this query and return time-series data for charting.`;
  sendInteractiveMessage(message);
}

const chartInteractivity: ChartInteractivity = { onQuerySubmit: handleChartQuery };

function renderResult(result: ToolResult): void {
  contentEl.innerHTML = '';
  renderMetadata(result);

  const mode = result.mode ?? 'execute';

  switch (mode) {
    case 'execute':
    case 'stream': {
      const output = result.output || result.error || '';
      const { format, parsed } = detectFormat(output);

      switch (format) {
        case 'json-table': {
          const rows = parsed as Record<string, unknown>[];
          const identifiers = findIdentifierColumns(rows);
          const interactivity = identifiers.length > 0
            ? { identifiers, kind: '', onCellClick: (col: string, val: unknown, row: Record<string, unknown>) => handleCellClick(col, val, row) }
            : undefined;
          renderTable(contentEl, rows, interactivity);
          break;
        }
        case 'time-series':
          renderChart(contentEl, parsed as Record<string, unknown>[], chartInteractivity);
          break;
        case 'interactive-table': {
          const obj = parsed as { _interactive: InteractiveTableMeta; rows: Record<string, unknown>[] };
          const identifiers = obj._interactive.identifiers;
          renderTable(contentEl, obj.rows, {
            identifiers,
            kind: obj._interactive.kind,
            onCellClick: (col, val, row) => handleCellClick(col, val, row),
          });
          break;
        }
        case 'interactive-actions': {
          const obj = parsed as { _interactive: InteractiveActionsMeta; actions: InteractiveAction[] };
          renderActions(contentEl, {
            kind: obj._interactive.kind,
            resource: obj._interactive.resource,
            actions: obj.actions,
            onActionClick: handleActionClick,
          });
          break;
        }
        case 'json-object':
          renderJsonTree(contentEl, parsed);
          break;
        case 'plain-text':
          renderTerminal(contentEl, output);
          break;
      }
      break;
    }

    case 'test':
      if (result.summary && result.tests) {
        renderTestResults(contentEl, result.summary, result.tests);
      } else {
        renderTerminal(contentEl, result.output ?? result.error ?? '');
      }
      break;

    case 'async':
    case 'status':
    case 'list':
    case 'cancel':
      renderStatus(contentEl, result);
      break;

    default:
      renderTerminal(contentEl, result.output ?? JSON.stringify(result, null, 2));
      break;
  }
}

// Capture original tool arguments for re-run support
app.ontoolinput = (toolInput: { name: string; arguments?: Record<string, unknown> }) => {
  lastToolInput = toolInput.arguments ?? null;
};

/** Extract structured result from tool result, checking _meta and legacy structuredContent. */
export function extractResult(toolResult: unknown): ToolResult {
  const raw = toolResult as Record<string, unknown>;
  // Prefer _meta.structuredResult (standard MCP field)
  const meta = raw._meta as Record<string, unknown> | undefined;
  if (meta?.structuredResult) {
    return meta.structuredResult as ToolResult;
  }
  // Legacy fallback: structuredContent
  if (raw.structuredContent) {
    return raw.structuredContent as ToolResult;
  }
  return raw as ToolResult;
}

// Listen for tool results from the host
app.ontoolresult = (toolResult) => {
  renderResult(extractResult(toolResult));
};

app.connect().catch((err) => {
  contentEl.innerHTML = `<div class="terminal"><pre><code>Failed to connect: ${err}</code></pre></div>`;
});

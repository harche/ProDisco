import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  TimeScale,
  CategoryScale,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';
import { renderTable } from './table';

Chart.register(
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  TimeScale,
  CategoryScale,
  Tooltip,
  Legend,
  Filler,
);

const TIMESTAMP_KEYS = new Set([
  'timestamp', 'time', 'date', '@timestamp', 'ts', 'datetime',
  'created_at', 'updated_at', 'createdAt', 'updatedAt',
]);

const COLORS = [
  '#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6',
  '#06b6d4', '#ec4899', '#14b8a6', '#f97316', '#6366f1',
];

export function renderChart(container: HTMLElement, data: Record<string, unknown>[]): void {
  if (data.length === 0) {
    container.textContent = 'No data to chart.';
    return;
  }

  const keys = Object.keys(data[0]!);
  const tsKey = keys.find((k) => TIMESTAMP_KEYS.has(k.toLowerCase()));
  const valueKeys = keys.filter(
    (k) => k !== tsKey && typeof data[0]![k] === 'number',
  );

  if (!tsKey || valueKeys.length === 0) {
    // Fallback to table if we can't find time-series structure
    renderTable(container, data);
    return;
  }

  const labels = data.map((row) => {
    const v = row[tsKey];
    if (typeof v === 'number') {
      return new Date(v > 1e12 ? v : v * 1000).toLocaleString();
    }
    return String(v);
  });

  const chartContainer = document.createElement('div');
  chartContainer.className = 'chart-container';

  const canvas = document.createElement('canvas');
  chartContainer.appendChild(canvas);
  container.appendChild(chartContainer);

  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const gridColor = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)';
  const textColor = isDark ? '#a3a3a3' : '#666666';

  new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: valueKeys.map((key, i) => ({
        label: key,
        data: data.map((row) => (row[key] as number) ?? null),
        borderColor: COLORS[i % COLORS.length],
        backgroundColor: 'transparent',
        tension: 0.3,
        pointRadius: data.length > 50 ? 0 : 3,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      interaction: {
        mode: 'index',
        intersect: false,
      },
      scales: {
        x: {
          ticks: { color: textColor, maxTicksLimit: 10 },
          grid: { color: gridColor },
        },
        y: {
          ticks: { color: textColor },
          grid: { color: gridColor },
        },
      },
      plugins: {
        legend: {
          labels: { color: textColor },
        },
      },
    },
  });

  // Toggle to show raw data
  const toggleDiv = document.createElement('div');
  toggleDiv.className = 'chart-toggle';
  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'btn';
  toggleBtn.textContent = 'Show raw data';
  let showingTable = false;
  const tableContainer = document.createElement('div');

  toggleBtn.addEventListener('click', () => {
    showingTable = !showingTable;
    toggleBtn.textContent = showingTable ? 'Hide raw data' : 'Show raw data';
    if (showingTable) {
      renderTable(tableContainer, data);
    } else {
      tableContainer.innerHTML = '';
    }
  });

  toggleDiv.appendChild(toggleBtn);
  container.appendChild(toggleDiv);
  container.appendChild(tableContainer);
}

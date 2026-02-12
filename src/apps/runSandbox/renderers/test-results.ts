interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
}

interface TestSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

export function renderTestResults(
  container: HTMLElement,
  summary: TestSummary,
  tests: TestResult[],
): void {
  // Summary bar
  const summaryDiv = document.createElement('div');
  summaryDiv.className = 'test-summary';

  const passedSpan = document.createElement('span');
  passedSpan.className = 'passed';
  passedSpan.textContent = `${summary.passed} passed`;
  summaryDiv.appendChild(passedSpan);

  if (summary.failed > 0) {
    const failedSpan = document.createElement('span');
    failedSpan.className = 'failed';
    failedSpan.textContent = `${summary.failed} failed`;
    summaryDiv.appendChild(failedSpan);
  }

  if (summary.skipped > 0) {
    const skippedSpan = document.createElement('span');
    skippedSpan.className = 'skipped';
    skippedSpan.textContent = `${summary.skipped} skipped`;
    summaryDiv.appendChild(skippedSpan);
  }

  const totalSpan = document.createElement('span');
  totalSpan.textContent = `${summary.total} total`;
  summaryDiv.appendChild(totalSpan);

  container.appendChild(summaryDiv);

  // Individual test results
  for (const test of tests) {
    const details = document.createElement('details');
    details.className = 'test-item';
    if (!test.passed) {
      details.open = true;
    }

    const summaryEl = document.createElement('summary');

    const icon = document.createElement('span');
    icon.className = `test-icon ${test.passed ? 'test-icon--pass' : 'test-icon--fail'}`;
    icon.textContent = test.passed ? '\u2713' : '\u2717';
    summaryEl.appendChild(icon);

    const nameSpan = document.createElement('span');
    nameSpan.textContent = test.name;
    summaryEl.appendChild(nameSpan);

    const timeSpan = document.createElement('span');
    timeSpan.className = 'test-time';
    timeSpan.textContent = `${test.durationMs}ms`;
    summaryEl.appendChild(timeSpan);

    details.appendChild(summaryEl);

    if (test.error) {
      const errorDiv = document.createElement('div');
      errorDiv.className = 'test-error';
      errorDiv.textContent = test.error;
      details.appendChild(errorDiv);
    }

    container.appendChild(details);
  }
}

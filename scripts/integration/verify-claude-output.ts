#!/usr/bin/env tsx

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

type VerifyArgs = {
  input: string;
};

function parseArgs(): VerifyArgs {
  const args = process.argv.slice(2);
  const result: Partial<VerifyArgs> = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--input') {
      result.input = args[i + 1];
      i += 1;
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }

  if (!result.input) {
    console.error('Usage: tsx verify-claude-output.ts --input <path>');
    process.exit(1);
  }

  return result as VerifyArgs;
}

type PodRecord = {
  namespace: string;
  name: string;
};

const expectedPods: PodRecord[] = [
  { namespace: 'demo-int', name: 'demo-nginx-0' },
  { namespace: 'demo-int', name: 'demo-nginx-1' },
];

async function main() {
  const { input } = parseArgs();
  const resolvedPath = path.resolve(input);
  const payload = JSON.parse(await fs.readFile(resolvedPath, 'utf8'));

  if (!Array.isArray(payload?.pods)) {
    throw new Error('Structured output is missing the pods array');
  }

  for (const pod of expectedPods) {
    const match = payload.pods.find(
      (candidate: PodRecord) => candidate.namespace === pod.namespace && candidate.name === pod.name,
    );

    if (!match) {
      throw new Error(`Missing pod ${pod.namespace}/${pod.name} in Claude response`);
    }
  }

  console.log(`[verify-claude-output] Claude reported all expected pods (${resolvedPath})`);
}

main().catch((error) => {
  console.error('[verify-claude-output] failed', error);
  process.exit(1);
});


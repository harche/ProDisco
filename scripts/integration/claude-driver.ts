#!/usr/bin/env tsx

/**
 * Drives a single Claude conversation using the TypeScript Agent SDK.
 * Authentication is assumed to be handled outside of this script (e.g. the
 * ANTHROPIC_API_KEY environment variable already exists).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

type DriverArgs = {
  kubeconfig: string;
  output: string;
  prompt?: string;
  verbose: boolean;
};

const defaultPrompt = `
You are verifying a Kubernetes integration test.

Use the connected MCP server to discover and run whatever tools are needed to
list every pod in the "demo-int" namespace. This namespace contains a StatefulSet
named "demo-nginx" with pods "demo-nginx-0" and "demo-nginx-1". Your response
must reflect the actual pods returned by the tools—do not invent names—and both
demo-nginx pods must appear in the JSON output.

Emit ONLY JSON matching the provided schema. Do not add Markdown fences or commentary.
`.trim();

const structuredSchema: JsonSchemaOutputFormat['schema'] = {
  type: 'object',
  additionalProperties: false,
  required: ['pods'],
  properties: {
    summary: {
      type: 'string',
      description: 'Human readable summary of the pods present in the namespace.',
    },
    pods: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['namespace', 'name', 'phase', 'ready', 'containers'],
        properties: {
          namespace: { type: 'string' },
          name: { type: 'string' },
          phase: { type: 'string' },
          ready: { type: 'boolean', description: 'True when all containers are ready.' },
          nodeName: { type: 'string' },
          containers: {
            type: 'object',
            additionalProperties: false,
            required: ['ready', 'total'],
            properties: {
              ready: { type: 'integer', minimum: 0 },
              total: { type: 'integer', minimum: 0 },
            },
          },
        },
      },
    },
  },
};

function parseArgs(): DriverArgs {
  const args = process.argv.slice(2);
  const result: Partial<DriverArgs> = {};
  result.verbose = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--kubeconfig') {
      result.kubeconfig = args[i + 1];
      i += 1;
    } else if (arg === '--output') {
      result.output = args[i + 1];
      i += 1;
    } else if (arg === '--prompt') {
      result.prompt = args[i + 1];
      i += 1;
    } else if (arg === '--verbose') {
      result.verbose = true;
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }

  if (!result.kubeconfig || !result.output) {
    console.error('Usage: tsx claude-driver.ts --kubeconfig <path> --output <path> [--prompt "..."]');
    process.exit(1);
  }

  return result as DriverArgs;
}

function cleanEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string') {
      cleaned[key] = value;
    }
  }

  return cleaned;
}

const moduleDirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const args = parseArgs();
  const repoRoot = path.resolve(moduleDirname, '..', '..');
  const serverEntrypoint = path.join(repoRoot, 'dist', 'server.js');

  const env = cleanEnv();
  env.KUBECONFIG = args.kubeconfig;

  const claudeQuery = query({
    prompt: args.prompt ?? defaultPrompt,
    options: {
      cwd: repoRoot,
      model: process.env.CLAUDE_INT_MODEL,
      outputFormat: { type: 'json_schema', schema: structuredSchema },
      strictMcpConfig: true,
      includePartialMessages: false,
      allowDangerouslySkipPermissions: true,
      permissionMode: 'bypassPermissions',
      stderr: args.verbose
        ? (line) => {
            process.stderr.write(`[claude-sd] ${line}\n`);
          }
        : undefined,
      mcpServers: {
        prodisco: {
          type: 'stdio',
          command: 'node',
          args: [serverEntrypoint],
          env,
        },
      },
    },
  });

  let structuredOutput: unknown;

  for await (const message of claudeQuery as AsyncGenerator<SDKMessage, void>) {
    if (args.verbose) {
      const interestingTypes = new Set<SDKMessage['type']>(['assistant', 'tool_progress', 'result', 'system', 'stream_event']);
      if (interestingTypes.has(message.type)) {
        console.error('[claude-driver] message', JSON.stringify(message));
      }
    }
    if (message.type === 'result') {
      if (message.subtype === 'success') {
        structuredOutput = message.structured_output;
      } else {
        throw new Error(`Claude Agent SDK returned error subtype: ${message.subtype}`);
      }
    }
  }

  if (!structuredOutput) {
    throw new Error('Claude Agent SDK did not return structured output');
  }

  await fs.mkdir(path.dirname(args.output), { recursive: true });
  await fs.writeFile(args.output, JSON.stringify(structuredOutput, null, 2), 'utf8');

  console.log(`[claude-driver] wrote structured output to ${args.output}`);
}

main().catch((error) => {
  console.error('[claude-driver] failed', error);
  process.exit(1);
});


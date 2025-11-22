import type { z } from 'zod';

export interface ToolDefinition<TResult = unknown, TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  schema: TSchema;
  resultSchema?: z.ZodTypeAny;
  execute: (input: z.infer<TSchema>) => Promise<TResult>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any, any>;


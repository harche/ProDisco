/**
 * Simple logger utility for consistent logging across the application.
 *
 * Uses stderr for all output since MCP servers communicate via stdout.
 * This ensures log messages don't interfere with the MCP protocol.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Default log level (can be overridden via environment variable)
const currentLogLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[currentLogLevel];
}

function formatMessage(level: LogLevel, message: string): string {
  const timestamp = new Date().toISOString();
  return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
}

export const logger = {
  /**
   * Log debug-level messages (hidden by default)
   */
  debug(message: string): void {
    if (shouldLog('debug')) {
      console.error(formatMessage('debug', message));
    }
  },

  /**
   * Log info-level messages
   */
  info(message: string): void {
    if (shouldLog('info')) {
      console.error(formatMessage('info', message));
    }
  },

  /**
   * Log warning-level messages
   */
  warn(message: string): void {
    if (shouldLog('warn')) {
      console.error(formatMessage('warn', message));
    }
  },

  /**
   * Log error-level messages with optional error object
   */
  error(message: string, err?: unknown): void {
    if (shouldLog('error')) {
      if (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(formatMessage('error', `${message}: ${errorMessage}`));
      } else {
        console.error(formatMessage('error', message));
      }
    }
  },
};

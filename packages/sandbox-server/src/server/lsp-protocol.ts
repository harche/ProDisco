/**
 * LSP Protocol Handler
 *
 * Handles JSON-RPC 2.0 communication with the TypeScript language server.
 * The LSP uses Content-Length headers to frame messages over stdio.
 */

import type { ChildProcess } from 'node:child_process';

/**
 * JSON-RPC 2.0 request
 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

/**
 * JSON-RPC 2.0 notification (no id, no response expected)
 */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

/**
 * JSON-RPC 2.0 response
 */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * JSON-RPC 2.0 message (request, notification, or response)
 */
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/**
 * Pending request tracker
 */
export interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  timeoutId: NodeJS.Timeout;
}

/**
 * Configuration for LspProtocol
 */
export interface LspProtocolConfig {
  /** Request timeout in milliseconds */
  requestTimeout?: number;
  /** Called when a notification is received from the server */
  onNotification?: (method: string, params: unknown) => void;
  /** Called when there's a protocol error */
  onError?: (error: Error) => void;
}

const DEFAULT_REQUEST_TIMEOUT = 30000; // 30 seconds

/**
 * LspProtocol handles JSON-RPC 2.0 communication with an LSP server over stdio.
 */
export class LspProtocol {
  private messageId = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private buffer = '';
  private contentLength = -1;
  private process: ChildProcess | null = null;
  private config: Required<LspProtocolConfig>;

  constructor(config: LspProtocolConfig = {}) {
    this.config = {
      requestTimeout: config.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT,
      onNotification: config.onNotification ?? (() => {}),
      onError: config.onError ?? (() => {}),
    };
  }

  /**
   * Attach to a child process's stdio
   */
  attach(process: ChildProcess): void {
    this.process = process;

    if (!process.stdout || !process.stdin) {
      throw new Error('Process must have stdout and stdin');
    }

    process.stdout.on('data', (data: Buffer) => {
      this.handleData(data.toString('utf-8'));
    });

    process.stderr?.on('data', (data: Buffer) => {
      // Log stderr but don't treat as protocol data
      console.error('[LSP stderr]', data.toString('utf-8'));
    });
  }

  /**
   * Detach from the process and reject all pending requests
   */
  detach(): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('LSP protocol detached'));
      this.pendingRequests.delete(id);
    }
    this.process = null;
    this.buffer = '';
    this.contentLength = -1;
  }

  /**
   * Send a request and wait for a response
   */
  async sendRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.process?.stdin?.writable) {
      throw new Error('LSP process not available');
    }

    const id = ++this.messageId;

    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`LSP request '${method}' timed out after ${this.config.requestTimeout}ms`));
      }, this.config.requestTimeout);

      this.pendingRequests.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        method,
        timeoutId,
      });

      this.writeMessage(request);
    });
  }

  /**
   * Send a notification (no response expected)
   */
  sendNotification(method: string, params?: unknown): void {
    if (!this.process?.stdin?.writable) {
      throw new Error('LSP process not available');
    }

    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    this.writeMessage(notification);
  }

  /**
   * Write a JSON-RPC message with Content-Length header
   */
  private writeMessage(message: JsonRpcMessage): void {
    const content = JSON.stringify(message);
    const contentLength = Buffer.byteLength(content, 'utf-8');
    const header = `Content-Length: ${contentLength}\r\n\r\n`;

    this.process!.stdin!.write(header + content);
  }

  /**
   * Handle incoming data from the LSP server
   */
  private handleData(data: string): void {
    this.buffer += data;

    while (true) {
      // If we don't have a content length yet, try to parse the header
      if (this.contentLength === -1) {
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) {
          // Need more data for complete header
          return;
        }

        const header = this.buffer.slice(0, headerEnd);
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          this.config.onError(new Error(`Invalid LSP header: ${header}`));
          // Skip this header and try to recover
          this.buffer = this.buffer.slice(headerEnd + 4);
          continue;
        }

        this.contentLength = parseInt(match[1], 10);
        this.buffer = this.buffer.slice(headerEnd + 4);
      }

      // Check if we have enough data for the content
      if (Buffer.byteLength(this.buffer, 'utf-8') < this.contentLength) {
        // Need more data
        return;
      }

      // Extract the message content
      const content = this.buffer.slice(0, this.contentLength);
      this.buffer = this.buffer.slice(this.contentLength);
      this.contentLength = -1;

      // Parse and handle the message
      try {
        const message = JSON.parse(content) as JsonRpcMessage;
        this.handleMessage(message);
      } catch (error) {
        this.config.onError(new Error(`Failed to parse LSP message: ${error}`));
      }
    }
  }

  /**
   * Handle a parsed JSON-RPC message
   */
  private handleMessage(message: JsonRpcMessage): void {
    // Check if it's a response (has 'id' and either 'result' or 'error')
    if ('id' in message && message.id !== undefined && message.id !== null) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        clearTimeout(pending.timeoutId);
        this.pendingRequests.delete(message.id);

        const response = message as JsonRpcResponse;
        if (response.error) {
          pending.reject(new Error(`LSP error: ${response.error.message} (${response.error.code})`));
        } else {
          pending.resolve(response.result);
        }
      }
      return;
    }

    // It's a notification from the server
    if ('method' in message) {
      const notification = message as JsonRpcNotification;
      this.config.onNotification(notification.method, notification.params);
    }
  }

  /**
   * Check if the protocol is connected
   */
  isConnected(): boolean {
    return this.process !== null && this.process.stdin?.writable === true;
  }

  /**
   * Get the number of pending requests
   */
  getPendingCount(): number {
    return this.pendingRequests.size;
  }
}

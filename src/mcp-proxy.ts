import { spawn, ChildProcess } from 'child_process';
import { Writable } from 'stream';

export interface SpawnOptions {
  [key: string]: string;
}

export class MCPProxy {
  private proc: ChildProcess | null = null;
  private writeStream: Writable | null = null;
  private pendingRequests: Map<string, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }> = new Map();
  private responseBuffer: string = '';
  public isInitialized = false;

  async spawn(binaryPath: string, env: SpawnOptions = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      const envVars = { ...process.env, ...env };
      this.proc = spawn(binaryPath, [], {
        env: envVars,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      if (!this.proc.stdin || !this.proc.stdout || !this.proc.stderr) {
        reject(new Error('Failed to spawn process with piped stdio'));
        return;
      }

      this.writeStream = this.proc.stdin;

      this.proc.stdout.on('data', (data: Buffer) => {
        this.responseBuffer += data.toString();
        this.processResponses();
      });

      this.proc.stderr.on('data', (data: Buffer) => {
        console.error(`[slack-pp-stderr] ${data.toString()}`);
      });

      this.proc.on('error', (err) => {
        console.error('[slack-pp error]', err);
        reject(err);
      });

      this.proc.on('close', (code) => {
        if (code !== 0) {
          console.error(`[slack-pp exited with code ${code}]`);
        }
      });

      setTimeout(() => resolve(), 500);
    });
  }

  private processResponses(): void {
    const lines = this.responseBuffer.split('\n');
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i].trim();
      if (line) {
        try {
          const response = JSON.parse(line);
          this.handleResponse(response);
        } catch {
          // Ignore parse errors
        }
      }
    }
    this.responseBuffer = lines[lines.length - 1];
  }

  private handleResponse(response: { id?: string | number; result?: unknown; error?: { code: number; message: string } }): void {
    const id = String(response.id);
    const pending = this.pendingRequests.get(id);
    if (pending) {
      if (response.error) {
        pending.reject(new Error(response.error.message));
      } else {
        pending.resolve(response.result);
      }
      this.pendingRequests.delete(id);
    }
  }

  private async sendRequest(method: string, params: unknown = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.writeStream || !this.proc) {
        reject(new Error('Process not spawned'));
        return;
      }

      const id = Date.now().toString();
      const request = { jsonrpc: '2.0', id, method, params };
      this.pendingRequests.set(id, { resolve, reject });

      try {
        this.writeStream.write(JSON.stringify(request) + '\n');
      } catch (e) {
        this.pendingRequests.delete(id);
        reject(e);
      }

      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request ${method} timed out`));
        }
      }, 30000);
    });
  }

  async initialize(): Promise<unknown> {
    const result = await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'slack-mcp-actor', version: '1.0.0' }
    });
    this.isInitialized = true;
    return result;
  }

  async listTools(): Promise<unknown> {
    return this.sendRequest('tools/list', {});
  }

  async callTool(toolName: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return this.sendRequest('tools/call', { name: toolName, arguments: args });
  }

  terminate(): void {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.writeStream = null;
    this.pendingRequests.clear();
  }
}

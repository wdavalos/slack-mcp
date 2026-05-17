import { spawn } from 'child_process';
export class MCPProxy {
    proc = null;
    writeStream = null;
    pendingRequests = new Map();
    responseBuffer = '';
    isInitialized = false;
    async spawn(binaryPath, env = {}) {
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
            this.proc.stdout.on('data', (data) => {
                this.responseBuffer += data.toString();
                this.processResponses();
            });
            this.proc.stderr.on('data', (data) => {
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
    processResponses() {
        const lines = this.responseBuffer.split('\n');
        for (let i = 0; i < lines.length - 1; i++) {
            const line = lines[i].trim();
            if (line) {
                try {
                    const response = JSON.parse(line);
                    this.handleResponse(response);
                }
                catch {
                    // Ignore parse errors
                }
            }
        }
        this.responseBuffer = lines[lines.length - 1];
    }
    handleResponse(response) {
        const id = String(response.id);
        const pending = this.pendingRequests.get(id);
        if (pending) {
            if (response.error) {
                pending.reject(new Error(response.error.message));
            }
            else {
                pending.resolve(response.result);
            }
            this.pendingRequests.delete(id);
        }
    }
    async sendRequest(method, params = {}) {
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
            }
            catch (e) {
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
    async initialize() {
        const result = await this.sendRequest('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'slack-mcp-actor', version: '1.0.0' }
        });
        this.isInitialized = true;
        return result;
    }
    async listTools() {
        return this.sendRequest('tools/list', {});
    }
    async callTool(toolName, args = {}) {
        return this.sendRequest('tools/call', { name: toolName, arguments: args });
    }
    terminate() {
        if (this.proc) {
            this.proc.kill();
            this.proc = null;
        }
        this.writeStream = null;
        this.pendingRequests.clear();
    }
}
//# sourceMappingURL=mcp-proxy.js.map
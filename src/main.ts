import http from 'http';
import { Actor } from 'apify';
import { MCPProxy } from './mcp-proxy.js';

let proxy: MCPProxy | null = null;

// PPE prices per tool — Slack PP tool names
const TOOL_PRICES: Record<string, number> = {
  // Auth
  about: 0.01, auth_test: 0.01, auth_revoke: 0.03,
  // Conversations
  conversations_list: 0.03, conversations_history: 0.03, conversations_info: 0.03,
  conversations_create: 0.05, conversations_archive: 0.05, conversations_unarchive: 0.05,
  conversations_invite: 0.05, conversations_set_purpose: 0.05, conversations_set_topic: 0.05,
  conversations_mark: 0.03, conversations_members: 0.03, conversations_replies: 0.03,
  // Messages
  messages_post_message: 0.05, messages_update_message: 0.05, messages_delete_message: 0.05,
  messages_get_permalink: 0.03, messages_list_scheduled: 0.03, messages_schedule_message: 0.05,
  // Files
  files_list: 0.03, files_info: 0.03, files_upload: 0.08, files_delete: 0.05,
  // Reactions
  reactions_list: 0.03, reactions_add: 0.05, reactions_remove: 0.03, reactions_get: 0.03,
  // Users
  users_list: 0.03, users_info: 0.03, users_get_presence: 0.03, users_profile_get: 0.03,
  users_profile_set: 0.05, users_set_presence: 0.05, users_lookup_by_email: 0.03,
  // Usergroups
  usergroups_list: 0.03, usergroups_create: 0.05, usergroups_update: 0.05,
  usergroups_users_list: 0.03, usergroups_users_update: 0.05,
  // DND
  dnd_info: 0.03, dnd_team_info: 0.03, dnd_set_snooze: 0.03, dnd_end_dnd: 0.03, dnd_end_snooze: 0.03,
  // Reminders
  reminders_list: 0.03, reminders_add: 0.05, reminders_complete: 0.03, reminders_delete: 0.05,
  reminders_info: 0.03,
  // Pins
  pins_list: 0.03, pins_add: 0.05, pins_remove: 0.03,
  // Stars
  stars_list: 0.03, stars_add: 0.05, stars_remove: 0.03,
  // Search
  search: 0.05, search_messages: 0.05,
  // Team
  team_info: 0.03, team_access_logs: 0.05, team_billable_info: 0.03,
  // Bots
  bots_info: 0.03,
  // Emoji
  emoji_list: 0.03,
  // SQL / Sync
  sql: 0.05, sync: 0.03,
};

async function getProxy(): Promise<MCPProxy> {
  if (proxy) return proxy;
  proxy = new MCPProxy();
  await proxy.spawn('/usr/local/bin/slack-pp-mcp', {
    SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN || '',
  });
  await proxy.initialize();
  return proxy;
}

async function handleTool(toolName: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const p = await getProxy();
  return p.callTool(toolName, args);
}

// =============================================================================
// ACTOR INITIALIZATION — ts-standby template pattern
// =============================================================================

await Actor.init();

const isStandby = process.env.APIFY_META_ORIGIN === 'STANDBY';

if (isStandby) {
  const PORT = Actor.config.get('containerPort') || Number(process.env.ACTOR_WEB_SERVER_PORT) || 3000;

  const server = http.createServer(async (req, res) => {
    if (req.headers['x-apify-container-server-readiness-probe']) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
      return;
    }

    if (req.method === 'POST' && (req.url === '/mcp' || req.url === '/')) {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const jsonBody = JSON.parse(body);
          const id = jsonBody.id ?? null;

          const reply = (result: unknown) => {
            const resp = id !== null
              ? { jsonrpc: '2.0', id, result }
              : result;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(resp));
          };

          const replyError = (code: number, message: string) => {
            const resp = id !== null
              ? { jsonrpc: '2.0', id, error: { code, message } }
              : { status: 'error', error: message };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(resp));
          };

          const method = jsonBody.method;

          if (method === 'initialize') {
            const p = await getProxy();
            return reply(await p.initialize());
          }

          if (method === 'tools/list') {
            const p = await getProxy();
            try {
              await Actor.charge({ eventName: 'list_tools', count: 0.01 });
            } catch (e) {
              console.error('Charge failed:', e);
            }
            return reply({ tools: await p.listTools() });
          }

          if (method === 'tools/call') {
            const toolName = jsonBody.params?.name;
            const toolArgs = jsonBody.params?.arguments || {};
            if (!toolName) return replyError(-32602, 'Missing params.name');

            const price = TOOL_PRICES[toolName] || 0.05;
            try {
              await Actor.charge({ eventName: `slack_${toolName}`, count: price });
            } catch (e) {
              console.error('Charge failed:', e);
            }

            const p = await getProxy();
            return reply(await p.callTool(toolName, toolArgs));
          }

          // Legacy direct: {tool: "...", params: {...}}
          if (jsonBody.tool) {
            const toolName = jsonBody.tool;
            const price = TOOL_PRICES[toolName] || 0.05;
            try {
              await Actor.charge({ eventName: `slack_${toolName}`, count: price });
            } catch (e) {
              console.error('Charge failed:', e);
            }

            const p = await getProxy();
            const toolResult = await p.callTool(toolName, jsonBody.params || {});
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'success', result: toolResult }));
            return;
          }

          replyError(-32601, `Method not found: ${method}`);
        } catch (error) {
          console.error('MCP error:', (error as Error).message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', error: (error as Error).message }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(PORT, () => {
      console.log(`Slack MCP listening on port ${PORT}`);
      resolve();
    });
  });

  process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
} else {
  // Non-STANDBY batch mode
  const input = await Actor.getInput() as { tool?: string; params?: Record<string, unknown> } | null;
  if (input && input.tool) {
    const tool = input.tool;
    const params = input.params || {};
    console.log(`Running tool: ${tool}`);
    const result = await handleTool(tool, params);
    await Actor.setValue('OUTPUT', result);
    await Actor.pushData([{ tool, result, timestamp: new Date().toISOString() }]);
  }
  await Actor.exit({ statusMessage: 'Completed', exit: true });
}

export default {
  handleRequest: async ({ request, log }: { request: Request; log: { info: (msg: string) => void; error: (msg: string) => void } }) => {
    log.info('Slack MCP received request');
    try {
      const body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
      const { tool, params = {} } = body;
      log.info(`Calling tool: ${tool}`);
      const result = await handleTool(tool, params);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      log.error(`Error: ${(error as Error).message}`);
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: (error as Error).message }, null, 2) }] };
    }
  }
};

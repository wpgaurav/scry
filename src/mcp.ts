/**
 * Stateless MCP server over Streamable HTTP (JSON responses, no SSE).
 * Every tool in the shared registry is exposed; write tools only to write-scope sessions.
 */
import { HttpError, type Env, type Session } from './env';
import { GoogleError } from './google';
import { callTool, TOOLS, toolJsonSchema } from './tools';
import { isOverloaded } from './db';
import { getBranding } from './branding';

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SERVER_VERSION = '0.1.0';

interface RpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, any>;
}

const INSTRUCTIONS = `Google Search Console data for the properties this server tracks.
Start with list_properties to get property ids, then use get_summary, top_pages, top_queries, page_details, query_details and get_insight.
Dates are YYYY-MM-DD. Ranges default to the last 28 days that have final data (Search Console data lags 2-3 days).
CTR is a percentage (3.2 = 3.2%). Position is the impression-weighted average; lower is better, so a negative delta_position is an improvement.
Stored reports are fast and cover 16 months. country/device filters and search_analytics call Google live.
get_insight kinds: striking_distance, ctr_gaps, page_decliners, page_gainers, query_decliners, query_gainers, new_queries, lost_queries, cannibalization, content_decay, zero_clicks.`;

const ok = (id: RpcRequest['id'], result: unknown) => ({ jsonrpc: '2.0', id, result });
const fail = (id: RpcRequest['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function handleOne(env: Env, session: Session, msg: RpcRequest) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(msg?.id ?? null, -32600, 'Invalid Request');
  const isNotification = msg.id === undefined;
  const p = msg.params || {};

  switch (msg.method) {
    case 'initialize': {
      const requested = String(p.protocolVersion || '');
      return ok(msg.id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: (await getBranding(env)).name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'scry', title: `${(await getBranding(env)).name} Search Console`, version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return ok(msg.id, {});
    case 'tools/list':
      return ok(msg.id, {
        tools: TOOLS.filter((t) => t.scope === 'read' || session.scope === 'write').map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: toolJsonSchema(t),
          annotations: {
            title: t.title,
            readOnlyHint: t.scope === 'read',
            destructiveHint: t.name.startsWith('delete_'),
            idempotentHint: t.scope === 'read',
            openWorldHint: true,
          },
        })),
      });
    case 'tools/call': {
      const name = String(p.name || '');
      if (!TOOLS.some((t) => t.name === name)) return fail(msg.id, -32602, `Unknown tool: ${name}`);
      try {
        const result = (await callTool(env, session, name, p.arguments || {})) as Record<string, unknown>;
        return ok(msg.id, { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result });
      } catch (e) {
        const message =
          e instanceof HttpError || e instanceof GoogleError
            ? e.message
            : isOverloaded(e)
              ? 'The database is busy while a sync writes data. Retry in a few seconds.'
              : 'Internal error';
        if (!(e instanceof HttpError || e instanceof GoogleError)) console.error('tool error', name, e);
        return ok(msg.id, { content: [{ type: 'text', text: message }], isError: true });
      }
    }
    case 'resources/list':
      return ok(msg.id, { resources: [] });
    case 'prompts/list':
      return ok(msg.id, { prompts: [] });
    default:
      if (isNotification || msg.method.startsWith('notifications/')) return null;
      return fail(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

export async function handleMcp(req: Request, env: Env, session: Session): Promise<Response> {
  if (req.method === 'GET') return new Response('This MCP server does not offer an SSE stream.', { status: 405, headers: { allow: 'POST' } });
  if (req.method === 'DELETE') return new Response(null, { status: 204 });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { allow: 'POST' } });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(fail(null, -32700, 'Parse error'), { status: 400 });
  }
  const batch = Array.isArray(body);
  const msgs = (batch ? body : [body]) as RpcRequest[];
  const results = (await Promise.all(msgs.map((m) => (m && m.id === undefined && m.method?.startsWith('notifications/') ? null : handleOne(env, session, m))))).filter(
    (r) => r !== null,
  );
  if (!results.length) return new Response(null, { status: 202 });
  return Response.json(batch ? results : results[0]);
}

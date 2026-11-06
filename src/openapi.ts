import { TOOLS } from './tools';
import { SERVER_VERSION } from './mcp';

/** OpenAPI 3.1 document generated from the tool registry, for GPT actions and other HTTP tool runners. */
export function openapi(origin: string, appName = 'Scry') {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const t of TOOLS) {
    const path = '/api' + t.http.path.replace(/:(\w+)/g, '{$1}');
    const pathParams = [...t.http.path.matchAll(/:(\w+)/g)].map((m) => m[1]);
    const required = new Set(t.input.required || []);
    const params = Object.entries(t.input.properties);
    const op: Record<string, unknown> = {
      operationId: t.name,
      summary: t.title,
      description: t.description + (t.scope === 'write' ? ' Requires a write-scope key.' : ''),
      parameters: [
        ...pathParams.map((name) => ({ name, in: 'path', required: true, schema: t.input.properties[name] || { type: 'string' } })),
        ...(t.http.method === 'GET'
          ? params
              .filter(([k]) => !pathParams.includes(k))
              .map(([name, schema]) => ({
                name,
                in: 'query',
                required: required.has(name),
                schema: schema.type === 'array' ? { type: 'string', description: 'Comma-separated list.' } : schema,
                ...(schema.description ? { description: schema.description } : {}),
              }))
          : []),
      ],
      responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } }, '4XX': { description: 'Error' } },
    };
    if (t.http.method !== 'GET') {
      const bodyProps = Object.fromEntries(params.filter(([k]) => !pathParams.includes(k)));
      op.requestBody = {
        required: true,
        content: {
          'application/json': {
            schema: { type: 'object', properties: bodyProps, required: [...required].filter((r) => !pathParams.includes(r)) },
          },
        },
      };
    }
    paths[path] = { ...(paths[path] || {}), [t.http.method.toLowerCase()]: op };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: `${appName} Search Console API`,
      version: SERVER_VERSION,
      description: 'Search Console performance, insights and indexing data. Table endpoints accept format=csv.',
    },
    servers: [{ url: origin }],
    components: { securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', description: 'gsk_... key from Settings → API keys' } } },
    security: [{ apiKey: [] }],
    paths,
  };
}

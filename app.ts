// app.ts — the forge's HTTP server: one listener that routes each request
// to the surface it belongs to (REST v3, git smart HTTP, GraphQL, MCP),
// enforces the bearer token everywhere but the boot probe, stamps every
// reply with a request id, and never lets a handler's exception take the
// process down — a trial grades liveness as much as correctness.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { RequestIds } from './clock.ts';
import { infoRefs, receivePack, uploadPack } from './githttp.ts';
import { handleGraphQL } from './graphql.ts';
import type { Ctx, Reply } from './http.ts';
import { errorReply, jsonReply } from './http.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import type { Forge } from './store.ts';

/** The largest request body the forge will read (packs for big pushes). */
const MAX_BODY_BYTES = 256 * 1024 * 1024;

export interface AppOptions {
  /** The trial token every surface demands; '' disables auth (local runs). */
  token: string;
}

/** Build the server around a forge instance. It binds nothing until listened. */
export function createForgeServer(forge: Forge, options: AppOptions): Server {
  const requestIds = new RequestIds();
  const server = createServer({ sendDate: false }, (req, res) => {
    void serve(req, res).catch(() => {
      // serve() already guards its own work; this is the last resort.
      try {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"message":"Internal error"}');
      } catch {
        // The socket is gone; nothing more to do.
      }
    });
  });
  server.keepAliveTimeout = 30_000;
  return server;

  async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = requestIds.next();
    let reply: Reply;
    try {
      const body = await readBody(req);
      const url = new URL(req.url ?? '/', 'http://entry');
      const rawPath = url.pathname;
      const segments = splitPath(rawPath);
      const ctx: Ctx = {
        forge,
        method: req.method ?? 'GET',
        segments,
        rawPath,
        query: url.searchParams,
        body,
        host: req.headers.host ?? '127.0.0.1',
        authorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : null,
        gitProtocol: typeof req.headers['git-protocol'] === 'string' ? (req.headers['git-protocol'] as string) : '',
      };
      reply = route(ctx);
    } catch (error) {
      process.stderr.write(`[forge] request failed: ${error instanceof Error ? error.message : String(error)}\n`);
      reply = errorReply(500, 'Internal error');
    }
    const bodyBuffer =
      reply.body === undefined ? Buffer.alloc(0) : typeof reply.body === 'string' ? Buffer.from(reply.body, 'utf8') : reply.body;
    res.writeHead(reply.status, {
      'x-github-request-id': requestId,
      'content-length': bodyBuffer.length,
      ...(reply.headers ?? {}),
    });
    res.end(bodyBuffer);
  }

  /** Route one request to its surface. Authentication comes first. */
  function route(ctx: Ctx): Reply {
    // The boot probe: no auth, always the same tiny answer.
    if (ctx.method === 'GET' && ctx.rawPath === '/healthz') {
      return jsonReply(200, { ok: true });
    }
    if (options.token !== '' && !authorized(ctx.authorization, options.token)) {
      const reply = errorReply(401, 'Unauthorized');
      reply.headers = { ...(reply.headers ?? {}), 'www-authenticate': 'Basic realm="forge"' };
      return reply;
    }

    if (ctx.rawPath === '/mcp') {
      if (ctx.method === 'POST') return handleMcp(ctx);
      if (ctx.method === 'DELETE') return jsonReply(200, {});
      return errorReply(405, 'Method Not Allowed');
    }
    if (ctx.rawPath === '/api/graphql') {
      if (ctx.method !== 'POST') return errorReply(404, 'Not Found');
      return handleGraphQL(ctx);
    }
    if (ctx.segments[0] === 'api' && ctx.segments[1] === 'v3') {
      return handleRest(ctx, ctx.segments.slice(2));
    }
    const git = matchGitPath(ctx.rawPath);
    if (git !== null) {
      const repo = ctx.forge.repoByPath(git.owner, git.repo);
      if (repo === undefined) return errorReply(404, 'Not Found');
      if (git.endpoint === 'info/refs' && ctx.method === 'GET') return infoRefs(ctx, repo);
      if (git.endpoint === 'git-upload-pack' && ctx.method === 'POST') return uploadPack(ctx, repo);
      if (git.endpoint === 'git-receive-pack' && ctx.method === 'POST') return receivePack(ctx, repo);
      return errorReply(404, 'Not Found');
    }
    return errorReply(404, 'Not Found');
  }
}

/**
 * Whether a request carries the trial token: as a Bearer credential (what
 * the suite sends on every surface) or, for real git clients, as the
 * password (or username) of a Basic credential.
 */
function authorized(header: string | null, token: string): boolean {
  if (header === null) return false;
  if (header === `Bearer ${token}`) return true;
  if (header.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      const user = colon === -1 ? decoded : decoded.slice(0, colon);
      const password = colon === -1 ? '' : decoded.slice(colon + 1);
      return password === token || user === token;
    } catch {
      return false;
    }
  }
  return false;
}

/** Read a request body whole, with a generous cap for pack uploads. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Split a URL path into decoded segments ('/' → []). */
function splitPath(rawPath: string): string[] {
  return rawPath
    .split('/')
    .filter((part) => part !== '')
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
}

interface GitPath {
  owner: string;
  repo: string;
  endpoint: 'info/refs' | 'git-upload-pack' | 'git-receive-pack';
}

/** Match /{owner}/{repo}.git/<endpoint>; repo names never contain a slash. */
function matchGitPath(rawPath: string): GitPath | null {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(rawPath);
  if (match === null) return null;
  const decode = (text: string): string => {
    try {
      return decodeURIComponent(text);
    } catch {
      return text;
    }
  };
  return {
    owner: decode(match[1]!),
    repo: decode(match[2]!),
    endpoint: match[3] as GitPath['endpoint'],
  };
}

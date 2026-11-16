// app.ts — the forge's HTTP server: one listener that routes each request
// to the surface it belongs to (REST v3, git smart HTTP, GraphQL, MCP),
// enforces the bearer token everywhere but the boot probe, stamps every
// reply with a request id, and never lets a handler's exception take the
// process down — a trial grades liveness as much as correctness.
//
// The transport is rawhttp.ts, a hand-rolled HTTP/1.1 stack on node:net:
// the suite's load is thousands of small keep-alive requests, and the
// measured cost of node:http's per-request machinery (llhttp bindings,
// request/response objects, URL parsing) rivalled the handlers themselves.
// Routing and every surface below the transport are unchanged by the swap.

import type { Server } from 'node:http';
import { RequestIds } from './clock.ts';
import { infoRefs, receivePack, uploadPack } from './githttp.ts';
import { handleGraphQL } from './graphql.ts';
import type { Ctx, Reply } from './http.ts';
import { errorReply, jsonReply } from './http.ts';
import { handleMcp } from './mcp.ts';
import { RawHttpServer, type RawReply, type RawRequest } from './rawhttp.ts';
import { handleRest } from './rest.ts';
import type { Forge } from './store.ts';

export interface AppOptions {
  /** The trial token every surface demands; '' disables auth (local runs). */
  token: string;
}

/** Shared empty parameter set for the (very common) query-less request. */
const EMPTY_QUERY = new URLSearchParams();

/** Placeholder segment list; only the REST router reads segments, and it
 *  receives its own split of the path, so nothing else pays for one. */
const NO_SEGMENTS: string[] = [];

/** Build the server around a forge instance. It binds nothing until listened. */
export function createForgeServer(forge: Forge, options: AppOptions): Server {
  const requestIds = new RequestIds();
  const bearer = `Bearer ${options.token}`;
  const server = new RawHttpServer((req) => serve(req));
  // main.ts drives this through the http.Server surface (listen/address/
  // once/close); RawHttpServer provides exactly those members.
  return server as unknown as Server;

  function serve(req: RawRequest): RawReply {
    const requestId = requestIds.next();
    let reply: Reply;
    try {
      const queryAt = req.target.indexOf('?');
      const rawPath = queryAt === -1 ? req.target : req.target.slice(0, queryAt);
      const ctx: Ctx = {
        forge,
        method: req.method,
        segments: NO_SEGMENTS,
        rawPath,
        // Only the REST surface and info/refs ever read the query; the
        // git POSTs and the MCP/GraphQL posts skip the parse entirely.
        query:
          queryAt === -1 || !(rawPath.startsWith('/api/v3') || rawPath.endsWith('/info/refs'))
            ? EMPTY_QUERY
            : new URLSearchParams(req.target.slice(queryAt + 1)),
        body: req.body,
        host: req.header('host') ?? '127.0.0.1',
        authorization: req.header('authorization') ?? null,
        gitProtocol: req.header('git-protocol') ?? '',
      };
      reply = route(ctx);
    } catch (error) {
      process.stderr.write(`[forge] request failed: ${error instanceof Error ? error.message : String(error)}\n`);
      reply = errorReply(500, 'Internal error');
    }
    return {
      status: reply.status,
      headers: reply.headers,
      body: reply.body,
      requestId,
    };
  }

  /** Route one request to its surface. Authentication comes first. */
  function route(ctx: Ctx): Reply {
    // The boot probe: no auth, always the same tiny answer.
    if (ctx.method === 'GET' && ctx.rawPath === '/healthz') {
      return jsonReply(200, { ok: true });
    }
    if (options.token !== '' && !authorized(ctx.authorization, options.token, bearer)) {
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
    if (ctx.rawPath === '/api/v3' || ctx.rawPath.startsWith('/api/v3/')) {
      return handleRest(ctx, splitPath(ctx.rawPath).slice(2));
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
function authorized(header: string | null, token: string, bearer: string): boolean {
  if (header === null) return false;
  if (header === bearer) return true;
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

/** Split a URL path into decoded segments ('/' → []). */
function splitPath(rawPath: string): string[] {
  const parts = rawPath.split('/');
  const segments: string[] = [];
  for (const part of parts) {
    if (part === '') continue;
    if (!part.includes('%')) {
      segments.push(part);
      continue;
    }
    try {
      segments.push(decodeURIComponent(part));
    } catch {
      segments.push(part);
    }
  }
  return segments;
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

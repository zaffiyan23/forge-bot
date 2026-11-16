// mcp.ts — the Model Context Protocol endpoint at /mcp: JSON-RPC 2.0 over
// Streamable HTTP, speaking both protocol eras the suite accepts. Modern
// (2026-07-28) clients open with server/discover; legacy clients open with
// initialize + notifications/initialized. The six tools are thin spellings
// of the same store operations REST uses, so an object made over MCP is the
// same object over REST, with the same stable id.

import type { Ctx, Reply } from './http.ts';
import { jsonReply } from './http.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import type { Repo } from './store.ts';
import { OWNER_LOGIN } from './store.ts';

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

function tool(name: string, description: string, properties: Record<string, string>, required: string[]): ToolDef {
  const props: ToolDef['inputSchema']['properties'] = {};
  for (const [key, text] of Object.entries(properties)) {
    props[key] = { type: key === 'private' ? 'boolean' : key === 'pull_number' ? 'number' : 'string', description: text };
  }
  return { name, description, inputSchema: { type: 'object', properties: props, required } };
}

/** The tool list, built once: two tools/list answers must be byte-identical. */
const TOOLS: ToolDef[] = [
  tool(
    'create_repo',
    'Create a new repository owned by the authenticated user.',
    { name: 'The repository name', description: 'A short description of the repository', private: 'Whether the repository is private' },
    ['name'],
  ),
  tool(
    'get_repo',
    'Get a repository by owner and name.',
    { owner: 'The repository owner login', repo: 'The repository name' },
    ['owner', 'repo'],
  ),
  tool(
    'create_issue',
    'Create an issue in a repository.',
    { owner: 'The repository owner login', repo: 'The repository name', title: 'The issue title', body: 'The issue body' },
    ['owner', 'repo', 'title'],
  ),
  tool(
    'list_issues',
    'List the issues of a repository, optionally filtered by state (open, closed, all).',
    { owner: 'The repository owner login', repo: 'The repository name', state: 'Filter by state: open, closed or all' },
    ['owner', 'repo'],
  ),
  tool(
    'create_pull_request',
    'Open a pull request from a head branch into a base branch.',
    {
      owner: 'The repository owner login',
      repo: 'The repository name',
      title: 'The pull request title',
      body: 'The pull request body',
      head: 'The head branch name',
      base: 'The base branch name',
    },
    ['owner', 'repo', 'title', 'head', 'base'],
  ),
  tool(
    'merge_pull_request',
    'Merge a pull request (squash) and report the merge commit.',
    { owner: 'The repository owner login', repo: 'The repository name', pull_number: 'The pull request number' },
    ['owner', 'repo', 'pull_number'],
  ),
];

const TOOLS_BY_NAME = new Map(TOOLS.map((def) => [def.name, def]));

// ------------------------------------------------------------- rpc framing

interface RpcError {
  code: number;
  message: string;
}

function rpcResult(id: unknown, result: unknown): Reply {
  return jsonReply(200, { jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(id: unknown, error: RpcError): Reply {
  return jsonReply(200, { jsonrpc: '2.0', id: id ?? null, error });
}

function toolSuccess(payload: unknown): Record<string, unknown> {
  const text = JSON.stringify(payload);
  return { content: [{ type: 'text', text }], structuredContent: payload, isError: false };
}

function toolFailure(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ------------------------------------------------------------------- tools

/** A string argument under any of its plausible spellings. */
function argStr(args: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

/** Resolve the target repository for a tool call, or an error message. */
function targetRepo(ctx: Ctx, args: Record<string, unknown>): { repo: Repo } | { error: string } {
  const owner = argStr(args, 'owner', 'owner_login') ?? OWNER_LOGIN;
  let name = argStr(args, 'repo', 'repository', 'repo_name', 'name');
  if (name === null) {
    const fullName = argStr(args, 'full_name', 'fullName');
    if (fullName !== null && fullName.includes('/')) name = fullName.split('/').slice(1).join('/');
  }
  if (owner !== OWNER_LOGIN) return { error: `repository ${owner}/${name ?? ''} not found` };
  if (name === null) return { error: 'missing required argument: repo' };
  const repo = ctx.forge.repoByName(name);
  if (repo === undefined) return { error: `repository ${owner}/${name} not found` };
  return { repo };
}

function callTool(ctx: Ctx, name: string, args: Record<string, unknown>): Reply | { rpc: RpcError } | { result: Record<string, unknown> } {
  const def = TOOLS_BY_NAME.get(name);
  if (def === undefined) return { rpc: { code: -32602, message: `unknown tool: ${name}` } };
  for (const required of def.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      // create_repo's target is its name, not an owner/repo pair.
      if (name === 'create_repo' && required === 'name') continue;
      return { rpc: { code: -32602, message: `missing required argument: ${required}` } };
    }
  }
  const forge = ctx.forge;
  switch (name) {
    case 'create_repo': {
      const repoName = argStr(args, 'name', 'repo', 'repository');
      if (repoName === null) return { rpc: { code: -32602, message: 'missing required argument: name' } };
      const existing = forge.repoByName(repoName);
      if (existing !== undefined) return { result: toolSuccess(repoJson(existing)) };
      const repo = forge.createRepo(repoName, argStr(args, 'description') ?? '', args.private === true);
      return { result: toolSuccess(repoJson(repo)) };
    }
    case 'get_repo': {
      const target = targetRepo(ctx, args);
      if ('error' in target) return { result: toolFailure(target.error) };
      return { result: toolSuccess(repoJson(target.repo)) };
    }
    case 'create_issue': {
      const target = targetRepo(ctx, args);
      if ('error' in target) return { result: toolFailure(target.error) };
      const title = argStr(args, 'title');
      if (title === null) return { rpc: { code: -32602, message: 'missing required argument: title' } };
      const issue = forge.createIssue(target.repo, title, argStr(args, 'body') ?? '', []);
      return { result: toolSuccess(issueJson(target.repo, issue)) };
    }
    case 'list_issues': {
      const target = targetRepo(ctx, args);
      if ('error' in target) return { result: toolFailure(target.error) };
      const state = argStr(args, 'state') ?? 'open';
      let issues = [...target.repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => a.number - b.number);
      return { result: toolSuccess(issues.map((issue) => issueJson(target.repo, issue))) };
    }
    case 'create_pull_request': {
      const target = targetRepo(ctx, args);
      if ('error' in target) return { result: toolFailure(target.error) };
      const head = argStr(args, 'head', 'head_ref', 'headRefName');
      const base = argStr(args, 'base', 'base_ref', 'baseRefName');
      const title = argStr(args, 'title');
      if (head === null || base === null || title === null) {
        return { rpc: { code: -32602, message: 'missing required argument: head, base or title' } };
      }
      if (target.repo.branchTip(head) === null) return { result: toolFailure(`head branch "${head}" does not exist`) };
      if (target.repo.branchTip(base) === null) return { result: toolFailure(`base branch "${base}" does not exist`) };
      const pull = forge.createPull(target.repo, title, argStr(args, 'body') ?? '', head, base);
      return { result: toolSuccess(pullJson(target.repo, pull)) };
    }
    case 'merge_pull_request': {
      const target = targetRepo(ctx, args);
      if ('error' in target) return { result: toolFailure(target.error) };
      const rawNumber = args.pull_number ?? args.number ?? args.pullNumber;
      const number = typeof rawNumber === 'number' ? rawNumber : Number(rawNumber);
      const pull = Number.isInteger(number) ? target.repo.pulls.get(number) : undefined;
      if (pull === undefined) return { result: toolFailure(`pull request ${String(rawNumber)} not found`) };
      const sha = forge.mergePull(target.repo, pull);
      if (sha === null) return { result: toolFailure('pull request is not mergeable') };
      return { result: toolSuccess(pullJson(target.repo, pull)) };
    }
    default:
      return { rpc: { code: -32602, message: `unknown tool: ${name}` } };
  }
}

// -------------------------------------------------------------------- http

/** Handle one JSON-RPC request object; null means "notification, no reply". */
function handleRpc(ctx: Ctx, request: Record<string, unknown>): Reply | null {
  const method = typeof request.method === 'string' ? request.method : '';
  const id = request.id;
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;
  if (id === undefined && method.startsWith('notifications/')) return null;
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      const outcome = callTool(ctx, name, args);
      if ('rpc' in outcome) return rpcError(id, outcome.rpc);
      return rpcResult(id, outcome.result);
    }
    default:
      if (method.startsWith('notifications/')) return null;
      return rpcError(id, { code: -32601, message: `method not found: ${method}` });
  }
}

/** POST /mcp. Auth is enforced by the server before this runs. */
export function handleMcp(ctx: Ctx): Reply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return jsonReply(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (Array.isArray(parsed)) {
    const replies: unknown[] = [];
    for (const item of parsed) {
      if (typeof item === 'object' && item !== null) {
        const reply = handleRpc(ctx, item as Record<string, unknown>);
        if (reply !== null && typeof reply.body === 'string') replies.push(JSON.parse(reply.body));
      }
    }
    return jsonReply(200, replies);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return jsonReply(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
  }
  const reply = handleRpc(ctx, parsed as Record<string, unknown>);
  if (reply === null) return { status: 202, body: '' };
  return reply;
}

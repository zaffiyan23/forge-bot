// http.ts — the small plumbing every surface shares: what a request looks
// like once the server has read it, and what a reply looks like before the
// server writes it. Keeping this tiny and shared is what lets REST, GraphQL,
// MCP and the git endpoints agree on framing (JSON bodies, error shapes).

import type { Forge } from './store.ts';

/** One fully-read HTTP request, ready for a surface handler. */
export interface Ctx {
  forge: Forge;
  method: string;
  /** URL-decoded path segments, no leading empty entry. */
  segments: string[];
  /** The raw path, still encoded (the git routes match on this). */
  rawPath: string;
  query: URLSearchParams;
  /** The request body, fully read (empty when there was none). */
  body: Buffer;
  /** The Host header, for building absolute Link URLs on this origin. */
  host: string;
  /** The Authorization header, or null. */
  authorization: string | null;
  /** The Git-Protocol header (git smart HTTP version negotiation), or ''. */
  gitProtocol?: string;
}

/** One reply: status, extra headers, and a body (JSON text or raw bytes). */
export interface Reply {
  status: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

/** The one header nearly every reply carries; shared, never mutated. */
const JSON_HEADERS: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };

/** A JSON reply with the forge's content type. */
export function jsonReply(status: number, value: unknown, headers?: Record<string, string>): Reply {
  return {
    status,
    headers: headers === undefined ? JSON_HEADERS : { ...JSON_HEADERS, ...headers },
    body: JSON.stringify(value),
  };
}

/** A GitHub-shaped error reply: a JSON object with a non-empty message. */
export function errorReply(status: number, message: string): Reply {
  return jsonReply(status, { message });
}

/** Parse a request body as JSON; { ok: false } when it is not JSON at all. */
export function parseJsonBody(ctx: Ctx): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (ctx.body.length === 0) return { ok: true, value: {} };
  const text = ctx.body.toString('utf8');
  try {
    // JSON.parse tolerates surrounding whitespace itself; no trim copy.
    const value: unknown = JSON.parse(text);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return { ok: true, value: value as Record<string, unknown> };
    }
    return { ok: true, value: {} };
  } catch {
    // A whitespace-only body meant "no fields" before, and still does.
    if (/^\s*$/.test(text)) return { ok: true, value: {} };
    return { ok: false };
  }
}

/** Read a string field from a JSON body, with a fallback. */
export function strField(body: Record<string, unknown>, key: string, fallback = ''): string {
  const value = body[key];
  return typeof value === 'string' ? value : fallback;
}

/** Read a boolean field from a JSON body. */
export function boolField(body: Record<string, unknown>, key: string): boolean {
  return body[key] === true;
}

/**
 * Slice a list by ?per_page=&page= when per_page is present (returning the
 * page and the total), or return everything when it is absent.
 */
export function paginate<T>(items: T[], query: URLSearchParams): { page: T[]; totalPages: number; pageNumber: number; perPage: number } | null {
  const perPageRaw = query.get('per_page');
  if (perPageRaw === null) return null;
  const perPage = Math.max(1, Math.min(100, Number(perPageRaw) || 30));
  const pageNumber = Math.max(1, Number(query.get('page')) || 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (pageNumber - 1) * perPage;
  return { page: items.slice(start, start + perPage), totalPages, pageNumber, perPage };
}

/** A Link header for a paginated list, on this request's own origin. */
export function linkHeader(ctx: Ctx, path: string, pageNumber: number, perPage: number, totalPages: number): string {
  const base = `http://${ctx.host}${path}`;
  const links: string[] = [];
  if (pageNumber < totalPages) {
    links.push(`<${base}?per_page=${perPage}&page=${pageNumber + 1}>; rel="next"`);
    links.push(`<${base}?per_page=${perPage}&page=${totalPages}>; rel="last"`);
  }
  if (pageNumber > 1) {
    links.push(`<${base}?per_page=${perPage}&page=1>; rel="first"`);
    links.push(`<${base}?per_page=${perPage}&page=${pageNumber - 1}>; rel="prev"`);
  }
  return links.join(', ');
}

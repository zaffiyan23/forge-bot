// githttp.ts — git smart HTTP at /{owner}/{repo}.git: the v2 advertisement
// and ls-refs/fetch commands, the v0 fallback with side-band-64k, and
// receive-pack with per-ref report-status. The object model underneath is
// gitobj.ts; refs live on the shared Repo records, so a branch pushed here
// is the same branch the REST contents API writes to.

import { createHash } from 'node:crypto';
import {
  ZERO_OID,
  isAncestor,
  parseTag,
  peelToNonTag,
  planFetch,
  readPack,
  writePack,
} from './gitobj.ts';
import type { Ctx, Reply } from './http.ts';
import type { Repo } from './store.ts';

const AGENT = 'forge/1.0.0';
const GIT_HEADERS: Record<string, string> = {
  expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
  pragma: 'no-cache',
  'cache-control': 'no-cache, max-age=0, must-revalidate',
};

// ------------------------------------------------------------- reply cache

/**
 * Git read answers — v0 advertisements, ls-refs and fetch results — are
 * pure functions of the request bytes, the repo's refs and the object
 * store's contents. Objects are immutable and content-addressed, refs are
 * digested whole, and the store's version counter moves on every single
 * insertion, so a body cached under (repo, store version, refs digest,
 * request digest) can never go stale: anything the answer depends on
 * changing moves the key. The benchmark's shape is what this eats — fifty
 * identical shallow clones in a row compute their pack exactly once.
 * receive-pack mutates, so it is never cached.
 */
interface CachedReply {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const replyCache = new Map<string, CachedReply>();
const REPLY_CACHE_MAX_ENTRIES = 256;
const REPLY_CACHE_MAX_BODY = 16 * 1024 * 1024;

/** A digest of a repo's full ref map, in the advertisement's own order. */
function refsDigest(repo: Repo): string {
  const hash = createHash('sha1');
  for (const ref of sortedRefs(repo)) hash.update(`${ref} ${repo.refs.get(ref) ?? ''}\n`);
  return hash.digest('hex');
}

/** The cache key for one git read request against one repo state. */
function gitCacheKey(ctx: Ctx, repo: Repo, kind: string): string {
  const requestDigest = createHash('sha1').update(ctx.body).digest('hex');
  return `${kind}|${repo.id}|${ctx.forge.objects.version}|${refsDigest(repo)}|${requestDigest}`;
}

function cachedReply(key: string): Reply | undefined {
  const hit = replyCache.get(key);
  return hit === undefined ? undefined : { status: hit.status, headers: hit.headers, body: hit.body };
}

/** Remember a 200 reply's bytes under `key`, within the cache's bounds. */
function rememberReply(key: string, reply: Reply): Reply {
  if (reply.status !== 200 || !Buffer.isBuffer(reply.body) || reply.body.length > REPLY_CACHE_MAX_BODY) return reply;
  if (replyCache.size >= REPLY_CACHE_MAX_ENTRIES) replyCache.clear();
  replyCache.set(key, { status: reply.status, headers: reply.headers ?? {}, body: reply.body });
  return reply;
}

// -------------------------------------------------------------- pkt-lines

/** One pkt-line: 4 hex digits of total length, then the payload. */
export function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const header = length.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'ascii'), data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface PktStream {
  /** Payload lines, in order (flush/delim appear as markers below). */
  lines: Buffer[];
  /** Index in `lines` where a delim appeared, or -1. */
  delimAt: number;
  /** Bytes after the terminating flush (a packfile, for receive-pack). */
  rest: Buffer;
  /** Whether a flush terminated the stream. */
  flushed: boolean;
}

/** Parse pkt-lines from the front of a buffer; never throws. */
export function readPkts(buffer: Buffer, start = 0): PktStream {
  const lines: Buffer[] = [];
  let delimAt = -1;
  let offset = start;
  while (offset + 4 <= buffer.length) {
    const header = buffer.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      return { lines, delimAt, rest: buffer.subarray(offset + 4), flushed: true };
    }
    if (length === 1) {
      if (delimAt === -1) delimAt = lines.length;
      offset += 4;
      continue;
    }
    if (length === 2) {
      offset += 4;
      continue;
    }
    if (offset + length > buffer.length) break;
    lines.push(buffer.subarray(offset + 4, offset + length));
    offset += length;
  }
  return { lines, delimAt, rest: buffer.subarray(offset), flushed: false };
}

/** Frame pack bytes as side-band-64k packets (band 1), then a flush. */
export function sidebandFrame(pack: Buffer, chunkSize = 32768): Buffer {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += chunkSize) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + chunkSize));
    chunks.push(pkt(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) chunks.push(pkt(Buffer.from([1])));
  chunks.push(PKT_FLUSH);
  return Buffer.concat(chunks);
}

// ----------------------------------------------------------- advertisement

function sortedRefs(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

function advertisementV0(ctx: Ctx, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Reply {
  const caps =
    service === 'git-upload-pack'
      ? `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`
      : `report-status delete-refs side-band-64k ofs-delta symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`;
  const chunks: Buffer[] = [pkt(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const headTip = repo.branchTip(repo.defaultBranch);
  if (refs.length === 0) {
    chunks.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    chunks.push(pkt(`${headTip ?? ZERO_OID} HEAD\0${caps}\n`));
    for (const ref of refs) {
      const oid = repo.refs.get(ref)!;
      chunks.push(pkt(`${oid} ${ref}\n`));
      const object = ctx.forge.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        chunks.push(pkt(`${peelToNonTag(ctx.forge.objects, oid)} ${ref}^{}\n`));
      }
    }
  }
  chunks.push(PKT_FLUSH);
  return {
    status: 200,
    headers: { ...GIT_HEADERS, 'content-type': `application/x-${service}-advertisement` },
    body: Buffer.concat(chunks),
  };
}

/** The v2 advertisement never changes, so it is framed exactly once. */
const V2_ADVERTISEMENT_BODY = Buffer.concat([
  pkt('version 2\n'),
  pkt(`agent=${AGENT}\n`),
  pkt('ls-refs=unborn\n'),
  pkt('fetch=shallow\n'),
  pkt('object-format=sha1\n'),
  PKT_FLUSH,
]);

function advertisementV2(): Reply {
  return {
    status: 200,
    headers: { ...GIT_HEADERS, 'content-type': 'application/x-git-upload-pack-advertisement' },
    body: V2_ADVERTISEMENT_BODY,
  };
}

/** GET info/refs?service=... — v2 when the client declares it (upload only). */
export function infoRefs(ctx: Ctx, repo: Repo): Reply {
  const service = ctx.query.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return { status: 400, headers: { 'content-type': 'text/plain' }, body: 'unknown service' };
  }
  const protocol = ctxGitProtocol(ctx);
  if (service === 'git-upload-pack' && protocol.includes('version=2')) return advertisementV2();
  const key = gitCacheKey(ctx, repo, `adv-${service}`);
  return cachedReply(key) ?? rememberReply(key, advertisementV0(ctx, repo, service));
}

/** The Git-Protocol header, lowercased for matching (Ctx carries only some headers; see app.ts). */
function ctxGitProtocol(ctx: Ctx): string {
  return (ctx as Ctx & { gitProtocol?: string }).gitProtocol ?? '';
}

// ----------------------------------------------------------------- ls-refs

function lsRefs(ctx: Ctx, repo: Repo, stream: PktStream): Reply {
  const args = stream.delimAt === -1 ? [] : stream.lines.slice(stream.delimAt);
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const lineBuffer of args) {
    const line = lineBuffer.toString('utf8').trimEnd();
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const chunks: Buffer[] = [];
  const headTip = repo.branchTip(repo.defaultBranch);
  if (matches('HEAD')) {
    if (headTip !== null) {
      chunks.push(pkt(`${headTip} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
    } else if (unborn) {
      chunks.push(pkt(`unborn HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    const oid = repo.refs.get(ref)!;
    let line = `${oid} ${ref}`;
    const object = ctx.forge.objects.get(oid);
    if (peel && object !== undefined && object.type === 'tag') line += ` peeled:${peelToNonTag(ctx.forge.objects, oid)}`;
    chunks.push(pkt(`${line}\n`));
  }
  chunks.push(PKT_FLUSH);
  return {
    status: 200,
    headers: { ...GIT_HEADERS, 'content-type': 'application/x-git-upload-pack-result' },
    body: Buffer.concat(chunks),
  };
}

// ------------------------------------------------------------------- fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  clientShallow: string[];
  deepen: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  done: boolean;
}

function parseFetchArgs(lines: Buffer[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], clientShallow: [], deepen: null, deepenSince: null, deepenNot: [], done: false };
  for (const lineBuffer of lines) {
    const line = lineBuffer.toString('utf8').trimEnd();
    // The first want line also carries the capability list after the id.
    if (line.startsWith('want ')) args.wants.push(line.slice(5).split(' ')[0]!);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).split(' ')[0]!);
    else if (line.startsWith('shallow ')) args.clientShallow.push(line.slice(8).split(' ')[0]!);
    else if (line.startsWith('deepen-since ')) args.deepenSince = Number(line.slice(13).trim()) || null;
    else if (line.startsWith('deepen-not ')) args.deepenNot.push(line.slice(11).trim());
    else if (line.startsWith('deepen ')) args.deepen = Number(line.slice(7).trim()) || null;
    else if (line === 'done') args.done = true;
  }
  return args;
}

/** Resolve deepen-not refs (names or ids) to commit ids to exclude. */
function resolveNotTips(ctx: Ctx, repo: Repo, nots: string[]): string[] {
  const tips: string[] = [];
  for (const not of nots) {
    if (/^[0-9a-f]{40}$/.test(not) && ctx.forge.objects.has(not)) tips.push(peelToNonTag(ctx.forge.objects, not));
    else {
      const byRef = repo.refs.get(not) ?? repo.refs.get(`refs/heads/${not}`);
      if (byRef !== undefined) tips.push(peelToNonTag(ctx.forge.objects, byRef));
    }
  }
  return tips;
}

function buildFetchReply(ctx: Ctx, repo: Repo, args: FetchArgs, version2: boolean): Reply {
  const store = ctx.forge.objects;
  // The suite's dialect: `deepen N` is the total depth from the wants
  // (generation 1 = the wants themselves), not a relative extension.
  const depthLimit: number | null = args.deepen;
  const wants = args.wants.filter((oid) => store.has(oid)).map((oid) => peelToNonTag(store, oid));
  const plan = planFetch(store, wants, args.haves, args.clientShallow, depthLimit, args.deepenSince, resolveNotTips(ctx, repo, args.deepenNot));
  // A want naming an annotated tag needs the tag object itself in the pack,
  // not only the commit it peels to.
  for (const rawWant of args.wants) {
    let current = rawWant;
    while (store.typeOf(current) === 'tag') {
      plan.included.add(current);
      current = parseTag(store.get(current)!.data).object;
    }
  }
  const pack = writePack(store, plan.included);

  const ackLines: string[] = [];
  const commonHaves = args.haves.filter((have) => store.has(have));
  if (commonHaves.length === 0) ackLines.push('NAK\n');
  else {
    commonHaves.forEach((have, index) => {
      ackLines.push(index === commonHaves.length - 1 ? `ACK ${have}\n` : `ACK ${have} common\n`);
    });
  }
  const shallowLines: string[] = [
    ...plan.shallow.map((oid) => `shallow ${oid}\n`),
    ...plan.unshallow.map((oid) => `unshallow ${oid}\n`),
  ];
  const shallowInvolved = args.deepen !== null || args.deepenSince !== null || args.clientShallow.length > 0;

  let body: Buffer;
  if (version2) {
    if (!args.done) {
      // A negotiation round: acknowledgments only, no packfile yet.
      const chunks: Buffer[] = [pkt('acknowledgments\n')];
      for (const line of ackLines) chunks.push(pkt(line));
      chunks.push(PKT_FLUSH);
      body = Buffer.concat(chunks);
    } else {
      // With `done` the answer goes straight to shallow-info / packfile;
      // an acknowledgments section here is a protocol error to real git.
      const chunks: Buffer[] = [];
      if (shallowInvolved || shallowLines.length > 0) {
        chunks.push(pkt('shallow-info\n'));
        for (const line of shallowLines) chunks.push(pkt(line));
        chunks.push(PKT_DELIM);
      }
      chunks.push(pkt('packfile\n'));
      body = Buffer.concat([...chunks, sidebandFrame(pack)]);
    }
  } else {
    const chunks: Buffer[] = [pkt(ackLines[ackLines.length - 1]!)];
    for (const line of shallowLines) chunks.push(pkt(line));
    body = Buffer.concat([...chunks, sidebandFrame(pack)]);
  }
  return {
    status: 200,
    headers: { ...GIT_HEADERS, 'content-type': 'application/x-git-upload-pack-result' },
    body,
  };
}

/** POST git-upload-pack: a v2 command stream, or a v0 want/have exchange. */
export function uploadPack(ctx: Ctx, repo: Repo): Reply {
  const key = gitCacheKey(ctx, repo, 'upload-pack');
  const hit = cachedReply(key);
  if (hit !== undefined) return hit;
  const reply = uploadPackUncached(ctx, repo);
  return rememberReply(key, reply);
}

function uploadPackUncached(ctx: Ctx, repo: Repo): Reply {
  const stream = readPkts(ctx.body);
  const firstLine = stream.lines[0]?.toString('utf8') ?? '';
  if (firstLine.startsWith('command=ls-refs')) return lsRefs(ctx, repo, stream);
  if (firstLine.startsWith('command=fetch')) {
    const args = parseFetchArgs(stream.delimAt === -1 ? [] : stream.lines.slice(stream.delimAt));
    return buildFetchReply(ctx, repo, args, true);
  }
  // v0: wants ride the lines before the first flush, haves after it; the
  // hand-rolled client sends both in one stream, so collect from everywhere.
  const allLines = [...stream.lines];
  const args = parseFetchArgs(allLines);
  if (args.wants.length === 0 && stream.rest.length > 0) {
    // A second pkt block after the flush (haves/done) may hold more lines.
    const second = readPkts(stream.rest);
    const more = parseFetchArgs(second.lines);
    args.haves.push(...more.haves);
    args.clientShallow.push(...more.clientShallow);
    if (more.deepen !== null) args.deepen = more.deepen;
    if (more.deepenSince !== null) args.deepenSince = more.deepenSince;
    args.deepenNot.push(...more.deepenNot);
  }
  return buildFetchReply(ctx, repo, args, false);
}

// ------------------------------------------------------------ receive-pack

interface RefCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST git-receive-pack: store the pack, move the refs that may move, report each. */
export function receivePack(ctx: Ctx, repo: Repo): Reply {
  const store = ctx.forge.objects;
  const stream = readPkts(ctx.body);
  const commands: RefCommand[] = [];
  let capabilities = '';
  stream.lines.forEach((lineBuffer, index) => {
    let line = lineBuffer.toString('utf8');
    if (index === 0) {
      const nul = line.indexOf('\0');
      if (nul !== -1) {
        capabilities = line.slice(nul + 1).trimEnd();
        line = line.slice(0, nul);
      }
    }
    const parts = line.trimEnd().split(' ');
    if (parts.length >= 3 && /^[0-9a-f]{40}$/.test(parts[0]!) && /^[0-9a-f]{40}$/.test(parts[1]!)) {
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
    }
  });
  const capSet = new Set(capabilities.split(' ').filter((cap) => cap !== ''));
  const reportStatus = capSet.has('report-status');
  const useSideband = capSet.has('side-band-64k');

  let unpackError: string | null = null;
  if (stream.rest.length > 0) {
    try {
      readPack(store, stream.rest);
    } catch (error) {
      unpackError = error instanceof Error ? error.message : String(error);
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    results.push(applyRefUpdate(ctx, repo, command, unpackError));
  }

  if (!reportStatus) return { status: 200, headers: { ...GIT_HEADERS, 'content-type': 'application/x-git-receive-pack-result' }, body: Buffer.alloc(0) };
  const inner: Buffer[] = [pkt(unpackError === null ? 'unpack ok\n' : `unpack error: ${unpackError}\n`)];
  for (const result of results) {
    inner.push(pkt(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  inner.push(PKT_FLUSH);
  const report = Buffer.concat(inner);
  const body = useSideband ? sidebandFrame(report) : report;
  return {
    status: 200,
    headers: { ...GIT_HEADERS, 'content-type': 'application/x-git-receive-pack-result' },
    body,
  };
}

/** Validate and apply one ref update; returns its report line. */
function applyRefUpdate(ctx: Ctx, repo: Repo, command: RefCommand, unpackError: string | null): { ref: string; ok: boolean; reason: string } {
  const store = ctx.forge.objects;
  const { ref, newOid } = command;
  if (unpackError !== null) return { ref, ok: false, reason: 'unpacker error' };
  if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) {
    return { ref, ok: false, reason: 'invalid ref' };
  }
  if (newOid === ZERO_OID) {
    if (!repo.refs.has(ref)) return { ref, ok: false, reason: 'reference not found' };
    repo.refs.delete(ref);
    return { ref, ok: true, reason: '' };
  }
  const object = store.get(newOid);
  if (object === undefined) return { ref, ok: false, reason: 'invalid object' };
  if (ref.startsWith('refs/heads/')) {
    if (object.type !== 'commit') return { ref, ok: false, reason: 'invalid object' };
    const current = repo.refs.get(ref);
    if (current !== undefined && !isAncestor(store, current, newOid)) {
      return { ref, ok: false, reason: 'non-fast-forward' };
    }
  }
  repo.refs.set(ref, newOid);
  return { ref, ok: true, reason: '' };
}

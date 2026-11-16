// gitobj.ts — the git object model, implemented from the protocol's own
// rules: SHA-1 over "<type> <len>\0<data>", zlib streams, tree entries in
// git's sort order, packfiles with ofs/ref deltas. Nothing here shells out
// to a git binary and nothing here touches the network; the store is a plain
// in-memory map the whole forge shares.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export const TYPE_NUMBER: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUMBER_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export const ZERO_OID = '0000000000000000000000000000000000000000';

/** The object id of a payload: sha1 of the git header plus the payload. */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export interface StoredObject {
  type: ObjType;
  data: Buffer;
}

/** Every object the forge knows, by id. One store for all repositories. */
export class ObjectStore {
  private readonly objects = new Map<string, StoredObject>();

  /** Store a payload, returning its id (idempotent). */
  put(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  get(oid: string): StoredObject | undefined {
    return this.objects.get(oid);
  }

  has(oid: string): boolean {
    return this.objects.has(oid);
  }

  typeOf(oid: string): ObjType | undefined {
    return this.objects.get(oid)?.type;
  }

  get size(): number {
    return this.objects.size;
  }
}

// ------------------------------------------------------------------ commits

export interface CommitInfo {
  tree: string;
  parents: string[];
  authorTime: number;
  committerTime: number;
  message: string;
  raw: Buffer;
}

/** Parse a commit payload into its parts. Throws on malformed input. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let authorTime = 0;
  let committerTime = 0;
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorTime = timeOf(line);
    else if (line.startsWith('committer ')) committerTime = timeOf(line);
  }
  return { tree, parents, authorTime, committerTime, message, raw: data };
}

/** The epoch-seconds field of an author/committer line ("... 1700000000 +0000"). */
function timeOf(line: string): number {
  const match = / (\d+) [+-]\d{4}$/.exec(line.trim());
  return match ? Number(match[1]) : 0;
}

export interface CommitParts {
  tree: string;
  parents: string[];
  name: string;
  email: string;
  timeSec: number;
  message: string;
}

/** Build a commit payload in git's canonical layout. */
export function buildCommit(parts: CommitParts): Buffer {
  const ident = `${parts.name} <${parts.email}> ${parts.timeSec} +0000`;
  let head = `tree ${parts.tree}\n`;
  for (const parent of parts.parents) head += `parent ${parent}\n`;
  head += `author ${ident}\ncommitter ${ident}\n`;
  return Buffer.from(`${head}\n${parts.message}`, 'utf8');
}

// -------------------------------------------------------------------- trees

export interface TreeEntry {
  /** Raw mode as stored, e.g. "100644" for a file, "40000" for a directory. */
  mode: string;
  name: string;
  oid: string;
  isTree: boolean;
}

/** Parse a tree payload into entries, in stored (git-sorted) order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.toString('utf8', offset, space);
    const nul = data.indexOf(0x00, space + 1);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid, isTree: mode === '40000' });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort: names compare bytewise, directories as if suffixed "/". */
function treeSortKey(entry: TreeEntry): string {
  return entry.isTree ? `${entry.name}/` : entry.name;
}

/** Build a tree payload from entries, sorting them the git way. */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const chunks: Buffer[] = [];
  for (const entry of sorted) {
    chunks.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    chunks.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(chunks);
}

/** The empty tree's payload-built id, used as the base of unborn branches. */
export const EMPTY_TREE_OID = hashObject('tree', Buffer.alloc(0));

/** Flatten a tree into path → blob entry, recursing into subtrees. */
export function flattenTree(store: ObjectStore, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const tree = store.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isTree) flattenTree(store, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Build (and store) nested trees from a flat path → blob map; returns the root tree id. */
export function buildTreeFromFiles(store: ObjectStore, files: Map<string, { oid: string; mode: string }>): string {
  interface Dir {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, file] of files) {
    const parts = path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let next = dir.dirs.get(parts[i]!);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(parts[i]!, next);
      }
      dir = next;
    }
    dir.files.set(parts[parts.length - 1]!, file);
  }
  const emit = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of dir.files) entries.push({ mode: file.mode, name, oid: file.oid, isTree: false });
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: emit(sub), isTree: true });
    return store.put('tree', buildTree(entries));
  };
  return emit(root);
}

/**
 * Return a new root tree with one path set to a blob (or removed when
 * blobOid is null), rebuilding only the trees along the path. A null root
 * starts from the empty tree.
 */
export function updateTreeAtPath(store: ObjectStore, rootOid: string | null, parts: string[], blobOid: string | null, mode = '100644'): string {
  const entries: TreeEntry[] = rootOid === null ? [] : parseTree(store.get(rootOid)?.data ?? Buffer.alloc(0));
  const [head, ...rest] = parts as [string, ...string[]];
  const index = entries.findIndex((entry) => entry.name === head);
  if (rest.length === 0) {
    const kept = entries.filter((entry) => entry.name !== head);
    if (blobOid !== null) kept.push({ mode, name: head, oid: blobOid, isTree: false });
    return store.put('tree', buildTree(kept));
  }
  const existing = index === -1 ? undefined : entries[index];
  const childRoot = existing !== undefined && existing.isTree ? existing.oid : null;
  const newChild = updateTreeAtPath(store, childRoot, rest, blobOid, mode);
  const kept = entries.filter((entry) => entry.name !== head);
  // A subtree emptied by a delete disappears, as in git.
  const childTree = store.get(newChild);
  const childEmpty = childTree !== undefined && childTree.data.length === 0;
  if (!childEmpty) kept.push({ mode: '40000', name: head, oid: newChild, isTree: true });
  return store.put('tree', buildTree(kept));
}

/** Look up one path inside a tree; returns the entry or undefined. */
export function lookupPath(store: ObjectStore, rootOid: string, parts: string[]): TreeEntry | undefined {
  let current = rootOid;
  for (let i = 0; i < parts.length; i += 1) {
    const tree = store.get(current);
    if (tree === undefined || tree.type !== 'tree') return undefined;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === parts[i]);
    if (entry === undefined) return undefined;
    if (i === parts.length - 1) return entry;
    if (!entry.isTree) return undefined;
    current = entry.oid;
  }
  return undefined;
}

// --------------------------------------------------------------------- tags

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  message: string;
}

/** Parse an annotated tag payload. */
export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  let object = '';
  let type = '';
  let tag = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, type, tag, message: split === -1 ? '' : text.slice(split + 2) };
}

/** Peel a (possibly annotated) tag chain down to the first non-tag object. */
export function peelToNonTag(store: ObjectStore, oid: string): string {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const object = store.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

// ----------------------------------------------------------------- ancestry

/** All commits reachable from a tip, tip first (DFS pre-order, parents in order). */
export function ancestryList(store: ObjectStore, tip: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    order.push(oid);
    const parents = parseCommit(object.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]!);
  }
  return order;
}

/** Whether `ancestor` is reachable from `descendant` (inclusive). */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/** Generation numbers (want = 1) of every commit reachable from the tips. */
export function generations(store: ObjectStore, tips: string[]): Map<string, number> {
  const result = new Map<string, number>();
  let frontier = [...new Set(tips)];
  let depth = 1;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (result.has(oid)) continue;
      const object = store.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      result.set(oid, depth);
      for (const parent of parseCommit(object.data).parents) next.push(parent);
    }
    frontier = next;
    depth += 1;
  }
  return result;
}

/** A best common ancestor of two commits, or null when histories are disjoint. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ancestorsOfA = new Set(ancestryList(store, a));
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsOfA.has(oid)) return oid;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    queue.push(...parseCommit(object.data).parents);
  }
  return null;
}

/** Add a commit's tree and everything under it to a set (not its parents). */
export function addTreeClosure(store: ObjectStore, treeOid: string, into: Set<string>): void {
  if (into.has(treeOid)) return;
  const tree = store.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return;
  into.add(treeOid);
  for (const entry of parseTree(tree.data)) {
    if (entry.isTree) addTreeClosure(store, entry.oid, into);
    else into.add(entry.oid);
  }
}

/** Add every object reachable from a commit (itself, ancestors, all trees/blobs). */
export function addFullClosure(store: ObjectStore, tip: string, into: Set<string>): void {
  for (const commitOid of ancestryList(store, tip)) {
    if (into.has(commitOid)) continue;
    into.add(commitOid);
    const commit = parseCommit(store.get(commitOid)!.data);
    addTreeClosure(store, commit.tree, into);
  }
}

// ------------------------------------------------------------- fetch planning

export interface FetchPlan {
  /** Every object id the pack must carry. */
  included: Set<string>;
  /** Boundary commits to report as shallow. */
  shallow: string[];
  /** Client-shallow commits that are no longer boundary. */
  unshallow: string[];
}

/**
 * Decide what a fetch sends: the closure of the wants, cut by depth or time
 * when asked, minus everything the client already has (the haves' closure,
 * plus each client-shallow commit's own tree — its parents are the point of
 * a deepen, so they are not excluded).
 */
export function planFetch(
  store: ObjectStore,
  wants: string[],
  haves: string[],
  clientShallow: string[],
  depthLimit: number | null,
  sinceSec: number | null,
  notTips: string[],
): FetchPlan {
  const excluded = new Set<string>();
  const shallowSet0 = new Set(clientShallow);
  for (const have of haves) {
    // A have that is also a client-shallow boundary excludes only the
    // commit and its tree: its ancestors are what a deepen is fetching,
    // so the full-closure rule would starve the very objects requested.
    if (!shallowSet0.has(have)) addFullClosure(store, have, excluded);
  }
  for (const shallowOid of clientShallow) {
    const object = store.get(shallowOid);
    if (object !== undefined && object.type === 'commit') {
      excluded.add(shallowOid);
      addTreeClosure(store, parseCommit(object.data).tree, excluded);
    }
  }
  const banned = new Set<string>();
  for (const tip of notTips) for (const oid of ancestryList(store, tip)) banned.add(oid);

  // Breadth-first by generation so depth limits mean what git means.
  const includedCommits = new Map<string, number>();
  let frontier = [...new Set(wants)];
  let depth = 1;
  while (frontier.length > 0) {
    if (depthLimit !== null && depth > depthLimit) break;
    const next: string[] = [];
    for (const oid of frontier) {
      if (includedCommits.has(oid) || banned.has(oid)) continue;
      const object = store.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      if (sinceSec !== null && commit.committerTime < sinceSec && depth > 1) continue;
      includedCommits.set(oid, depth);
      for (const parent of commit.parents) next.push(parent);
    }
    frontier = next;
    depth += 1;
  }

  const included = new Set<string>();
  const shallow: string[] = [];
  for (const commitOid of includedCommits.keys()) {
    const commit = parseCommit(store.get(commitOid)!.data);
    if (!excluded.has(commitOid)) {
      included.add(commitOid);
      addTreeClosure(store, commit.tree, included);
    }
    const cut = commit.parents.some((parent) => !includedCommits.has(parent) && store.has(parent));
    if (cut && (depthLimit !== null || sinceSec !== null)) shallow.push(commitOid);
  }
  for (const oid of [...included]) if (excluded.has(oid)) included.delete(oid);

  const shallowSet = new Set(shallow);
  const unshallow = clientShallow.filter((oid) => includedCommits.has(oid) && !shallowSet.has(oid));
  return { included, shallow, unshallow };
}

// -------------------------------------------------------------------- packs

/** Encode one pack object header (type + size varint). */
function packHeader(type: ObjType, size: number): Buffer {
  const bytes: number[] = [];
  let first = (TYPE_NUMBER[type] << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Write a complete packfile carrying the given objects (plain entries, no deltas). */
export function writePack(store: ObjectStore, oids: Set<string>): Buffer {
  const entries: StoredObject[] = [];
  for (const oid of oids) {
    const object = store.get(oid);
    if (object !== undefined) entries.push(object);
  }
  const chunks: Buffer[] = [Buffer.from('PACK', 'ascii')];
  const version = Buffer.alloc(4);
  version.writeUInt32BE(2, 0);
  chunks.push(version);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(entries.length, 0);
  chunks.push(count);
  for (const entry of entries) {
    chunks.push(packHeader(entry.type, entry.data.length));
    chunks.push(deflateSync(entry.data));
  }
  const body = Buffer.concat(chunks);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Apply a git delta payload to a base payload. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset]!;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size mismatch: ${sourceSize} vs ${base.length}`);
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset]!;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) copyOffset = delta[offset++]!;
      if (op & 0x02) copyOffset |= delta[offset++]! << 8;
      if (op & 0x04) copyOffset |= delta[offset++]! << 16;
      if (op & 0x08) copyOffset |= delta[offset++]! << 24;
      if (op & 0x10) copySize = delta[offset++]!;
      if (op & 0x20) copySize |= delta[offset++]! << 8;
      if (op & 0x40) copySize |= delta[offset++]! << 16;
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      offset += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) throw new Error('delta produced the wrong size');
  return result;
}

export interface PackEntry {
  type: ObjType;
  data: Buffer;
  oid: string;
}

/**
 * Read a packfile into the store, resolving ofs/ref deltas. Returns the ids
 * of the objects it carried. Throws on any structural problem; callers turn
 * that into "unpack error" without taking the server down.
 */
export function readPack(store: ObjectStore, pack: Buffer): PackEntry[] {
  if (pack.length < 12 + 20 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const pending: Array<{ type: ObjType; data: Buffer }> = [];
  const localBases: Array<{ offset: number; oid: string }> = [];
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    let byte = pack[offset]!;
    offset += 1;
    const typeNumber = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset]!;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let resolved: { type: ObjType; data: Buffer };
    if (typeNumber === 6) {
      // ofs-delta: base sits at an earlier offset in this same pack.
      let back = pack[offset]!;
      offset += 1;
      let baseDelta = back & 0x7f;
      while (back & 0x80) {
        back = pack[offset]!;
        offset += 1;
        baseDelta = ((baseDelta + 1) << 7) | (back & 0x7f);
      }
      const baseOffset = entryOffset - baseDelta;
      const base = localBases.find((candidate) => candidate.offset === baseOffset);
      if (base === undefined) throw new Error('ofs-delta base not in pack');
      const inflated = inflateWithSize(pack, offset);
      offset += inflated.consumed;
      const baseObject = store.get(base.oid);
      if (baseObject === undefined) throw new Error('ofs-delta base missing from store');
      resolved = { type: baseObject.type, data: applyDelta(baseObject.data, inflated.data) };
      if (resolved.data.length !== size) throw new Error('ofs-delta result size mismatch');
    } else if (typeNumber === 7) {
      // ref-delta: base named by id, in the store or earlier in this pack.
      const baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
      const inflated = inflateWithSize(pack, offset);
      offset += inflated.consumed;
      const baseObject = store.get(baseOid);
      if (baseObject === undefined) throw new Error('ref-delta base missing from store');
      resolved = { type: baseObject.type, data: applyDelta(baseObject.data, inflated.data) };
      if (resolved.data.length !== size) throw new Error('ref-delta result size mismatch');
    } else {
      const type = NUMBER_TYPE[typeNumber];
      if (type === undefined) throw new Error(`unknown pack object type ${typeNumber}`);
      const inflated = inflateWithSize(pack, offset);
      offset += inflated.consumed;
      if (inflated.data.length !== size) throw new Error('pack object size mismatch');
      resolved = { type, data: inflated.data };
    }
    const oid = store.put(resolved.type, resolved.data);
    localBases.push({ offset: entryOffset, oid });
    pending.push({ ...resolved, oid } as PackEntry & { type: ObjType; data: Buffer });
  }
  return pending.map((entry, i) => ({ type: entry.type, data: entry.data, oid: localBases[i]!.oid }));
}

/** Inflate one zlib stream starting at `offset`, reporting bytes consumed. */
function inflateWithSize(pack: Buffer, offset: number): { data: Buffer; consumed: number } {
  const result = inflateSync(pack.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, consumed: result.engine.bytesWritten };
}

// --------------------------------------------------------------------- diff

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  fromOid: string | null;
  toOid: string | null;
}

/** The per-path difference between two trees (either may be null = empty). */
export function diffTrees(store: ObjectStore, fromTree: string | null, toTree: string | null): FileChange[] {
  const from = fromTree === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(store, fromTree);
  const to = toTree === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(store, toTree);
  const changes: FileChange[] = [];
  const paths = new Set([...from.keys(), ...to.keys()]);
  for (const path of [...paths].sort()) {
    const before = from.get(path);
    const after = to.get(path);
    if (before === undefined && after !== undefined) changes.push({ path, status: 'added', fromOid: null, toOid: after.oid });
    else if (before !== undefined && after === undefined) changes.push({ path, status: 'removed', fromOid: before.oid, toOid: null });
    else if (before !== undefined && after !== undefined && before.oid !== after.oid) changes.push({ path, status: 'modified', fromOid: before.oid, toOid: after.oid });
  }
  return changes;
}

/** Line-level add/delete counts between two text payloads (LCS-based). */
export function lineDiffCounts(before: string, after: string): { additions: number; deletions: number } {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  if (a.length * b.length > 4_000_000) {
    // Very large files: fall back to a count that stays truthful in sign.
    return { additions: b.length, deletions: a.length };
  }
  const dp = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const above = dp[j]!;
      dp[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(dp[j]!, dp[j - 1]!);
      diagonal = above;
    }
  }
  const common = dp[b.length]!;
  return { additions: b.length - common, deletions: a.length - common };
}

// ------------------------------------------------------- three-way merging

export interface MergeOutcome {
  conflict: boolean;
  /** The merged path → blob map when there is no conflict. */
  files: Map<string, { oid: string; mode: string }> | null;
  conflictPaths: string[];
}

/**
 * A path-wise three-way merge: for every path, whichever side changed it
 * relative to the merge base wins; both sides changing it differently is a
 * conflict. This is exactly the conflict shape the suite exercises.
 */
export function threeWayMerge(
  store: ObjectStore,
  baseTree: string | null,
  headTree: string | null,
  currentTree: string | null,
): MergeOutcome {
  const base = baseTree === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(store, baseTree);
  const head = headTree === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(store, headTree);
  const current = currentTree === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(store, currentTree);
  const paths = new Set([...base.keys(), ...head.keys(), ...current.keys()]);
  const files = new Map<string, { oid: string; mode: string }>();
  const conflictPaths: string[] = [];
  for (const path of paths) {
    const inBase = base.get(path)?.oid ?? null;
    const inHead = head.get(path)?.oid ?? null;
    const inCurrent = current.get(path)?.oid ?? null;
    let winner: { oid: string; mode: string } | undefined;
    if (inHead === inCurrent) winner = head.get(path) ?? current.get(path);
    else if (inBase === inHead) winner = current.get(path);
    else if (inBase === inCurrent) winner = head.get(path);
    else {
      conflictPaths.push(path);
      continue;
    }
    if (winner !== undefined) files.set(path, winner);
  }
  if (conflictPaths.length > 0) return { conflict: true, files: null, conflictPaths };
  return { conflict: false, files, conflictPaths: [] };
}

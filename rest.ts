// rest.ts — the REST v3 surface under /api/v3: root, meta, the token's user,
// repositories and their contents, branches and refs, commits, labels,
// issues with comments, and pull requests with a real squash merge. Every
// handler answers GitHub-shaped JSON; errors are { message } objects; the
// server adds the request-id header on the way out.

import { isoOf } from './clock.ts';
import {
  ancestryList,
  diffTrees,
  lineDiffCounts,
  lookupPath,
  mergeBase,
  parseCommit,
  parseTree,
  peelToNonTag,
  updateTreeAtPath,
} from './gitobj.ts';
import type { Ctx, Reply } from './http.ts';
import { boolField, errorReply, jsonReply, linkHeader, paginate, parseJsonBody, strField } from './http.ts';
import type { Issue, Label, Pull, Repo } from './store.ts';
import { FORGE_EMAIL, FORGE_NAME, OWNER_ID, OWNER_LOGIN } from './store.ts';
import { buildCommit } from './gitobj.ts';

// ------------------------------------------------------------- serializers

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: OWNER_ID, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, name: label.name, color: label.color, description: label.description };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labelNames
      .map((name) => repo.labels.get(name))
      .filter((label) => label !== undefined)
      .map((label) => labelJson(label)),
    user: { login: repo.owner, id: OWNER_ID, type: 'User' },
    comments: repo.comments.get(issue.number)?.length ?? 0,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: {
      ref: pull.headRef,
      sha: repo.branchTip(pull.headRef) ?? '',
      label: `${repo.owner}:${pull.headRef}`,
    },
    base: {
      ref: pull.baseRef,
      sha: repo.branchTip(pull.baseRef) ?? '',
      label: `${repo.owner}:${pull.baseRef}`,
    },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: repo.owner, id: OWNER_ID, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

function commitJson(forge: Ctx['forge'], oid: string): Record<string, unknown> {
  const object = forge.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return { sha: oid };
  const commit = parseCommit(object.data);
  const author = identOf(object.data, 'author');
  const committer = identOf(object.data, 'committer');
  return {
    sha: oid,
    commit: {
      author: { name: author.name, email: author.email, date: isoOf(commit.authorTime) },
      committer: { name: committer.name, email: committer.email, date: isoOf(commit.committerTime) },
      message: commit.message,
      tree: { sha: commit.tree },
    },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

/** Name and email out of a commit's author/committer line. */
function identOf(commitData: Buffer, kind: 'author' | 'committer'): { name: string; email: string } {
  const text = commitData.toString('utf8');
  for (const line of text.split('\n')) {
    if (line.startsWith(`${kind} `)) {
      const rest = line.slice(kind.length + 1);
      const open = rest.lastIndexOf('<');
      const close = rest.lastIndexOf('>');
      if (open !== -1 && close > open) return { name: rest.slice(0, open).trim(), email: rest.slice(open + 1, close) };
      return { name: rest, email: '' };
    }
    if (line === '') break;
  }
  return { name: '', email: '' };
}

// ------------------------------------------------------------------- root

function rootReply(): Reply {
  return jsonReply(
    200,
    {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_repositories_url: '/api/v3/user/repos',
    },
    { 'x-oauth-scopes': 'repo, read:org', 'x-accepted-oauth-scopes': 'repo, read:org' },
  );
}

// ------------------------------------------------------------- repositories

function createRepo(ctx: Ctx): Reply {
  const parsed = parseJsonBody(ctx);
  if (!parsed.ok) return errorReply(400, 'Problems parsing JSON');
  const name = strField(parsed.value, 'name');
  if (name === '') return errorReply(422, 'Validation Failed: name is required');
  if (ctx.forge.repoByName(name) !== undefined) {
    return errorReply(422, `Validation Failed: name already exists on this account`);
  }
  const repo = ctx.forge.createRepo(name, strField(parsed.value, 'description'), boolField(parsed.value, 'private'));
  if (parsed.value.auto_init === true) {
    const blob = ctx.forge.objects.put('blob', Buffer.from(`# ${name}\n`, 'utf8'));
    const tree = updateTreeAtPath(ctx.forge.objects, null, ['README.md'], blob);
    const timeSec = ctx.forge.clock.tick();
    const commit = ctx.forge.objects.put(
      'commit',
      buildCommit({ tree, parents: [], name: FORGE_NAME, email: FORGE_EMAIL, timeSec, message: 'Initial commit' }),
    );
    repo.refs.set(`refs/heads/${repo.defaultBranch}`, commit);
  }
  return jsonReply(201, repoJson(repo));
}

function listOwnRepos(ctx: Ctx): Reply {
  const all = ctx.forge.listRepos().map((repo) => repoJson(repo));
  const paged = paginate(all, ctx.query);
  if (paged === null) return jsonReply(200, all);
  const headers: Record<string, string> = {};
  const link = linkHeader(ctx, '/api/v3/user/repos', paged.pageNumber, paged.perPage, paged.totalPages);
  if (link !== '') headers.link = link;
  return jsonReply(200, paged.page, headers);
}

function patchRepo(ctx: Ctx, repo: Repo): Reply {
  const parsed = parseJsonBody(ctx);
  if (!parsed.ok) return errorReply(400, 'Problems parsing JSON');
  if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
  if (typeof parsed.value.private === 'boolean') repo.isPrivate = parsed.value.private;
  if (typeof parsed.value.name === 'string' && parsed.value.name !== '' && parsed.value.name !== repo.name) {
    if (ctx.forge.repoByName(parsed.value.name) !== undefined) {
      return errorReply(422, 'Validation Failed: name already exists on this account');
    }
    ctx.forge.repos.delete(repo.name);
    (repo as { name: string }).name = parsed.value.name;
    ctx.forge.repos.set(repo.name, repo);
  }
  repo.updatedAt = ctx.forge.clock.tickIso();
  return jsonReply(200, repoJson(repo));
}

// ---------------------------------------------------------------- contents

/** Resolve a ?ref= (branch name or commit id) to a commit id, defaulting to the default branch tip. */
function resolveRef(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return repo.branchTip(repo.defaultBranch);
  const byBranch = repo.branchTip(ref);
  if (byBranch !== null) return byBranch;
  return ref;
}

function getContents(ctx: Ctx, repo: Repo, parts: string[]): Reply {
  const tip = resolveRef(repo, ctx.query.get('ref'));
  if (tip === null) return errorReply(404, 'Not Found');
  const tree = ctx.forge.treeOfCommit(tip);
  if (tree === null) return errorReply(404, 'Not Found');
  if (parts.length === 0) {
    return jsonReply(200, dirListing(ctx, repo, tree, ''));
  }
  const entry = lookupPath(ctx.forge.objects, tree, parts);
  if (entry === undefined) return errorReply(404, 'Not Found');
  const path = parts.join('/');
  if (entry.isTree) return jsonReply(200, dirListing(ctx, repo, entry.oid, path));
  const blob = ctx.forge.objects.get(entry.oid);
  const data = blob?.data ?? Buffer.alloc(0);
  return jsonReply(200, {
    type: 'file',
    name: parts[parts.length - 1],
    path,
    sha: entry.oid,
    size: data.length,
    encoding: 'base64',
    content: data.toString('base64'),
  });
}

function dirListing(ctx: Ctx, repo: Repo, treeOid: string, prefix: string): Record<string, unknown>[] {
  const tree = ctx.forge.objects.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return [];
  return parseTree(tree.data).map((entry) => ({
    type: entry.isTree ? 'dir' : 'file',
    name: entry.name,
    path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
    sha: entry.oid,
    size: 0,
  }));
}

/** The branch a contents write targets, and the tip/tree it builds on. */
function writeBase(ctx: Ctx, repo: Repo, branch: string): { tip: string | null; tree: string | null } {
  const tip = repo.branchTip(branch);
  if (tip !== null) return { tip, tree: ctx.forge.treeOfCommit(tip) };
  // A branch that does not exist yet starts from the default branch's tip.
  const fallback = repo.branchTip(repo.defaultBranch);
  if (fallback !== null) return { tip: fallback, tree: ctx.forge.treeOfCommit(fallback) };
  return { tip: null, tree: null };
}

function putContents(ctx: Ctx, repo: Repo, parts: string[]): Reply {
  const parsed = parseJsonBody(ctx);
  if (!parsed.ok) return errorReply(400, 'Problems parsing JSON');
  if (parts.length === 0) return errorReply(422, 'Validation Failed: no path given');
  const branch = strField(parsed.value, 'branch', repo.defaultBranch) || repo.defaultBranch;
  const { tip, tree } = writeBase(ctx, repo, branch);
  const existing = tree === null ? undefined : lookupPath(ctx.forge.objects, tree, parts);
  const isUpdate = existing !== undefined && !existing.isTree;
  if (existing !== undefined && existing.isTree) return errorReply(422, 'Validation Failed: path is a directory');
  if (isUpdate) {
    const sha = parsed.value.sha;
    if (typeof sha !== 'string' || sha === '') return errorReply(422, 'Validation Failed: sha is required to update a file');
    if (sha !== existing.oid) return errorReply(409, 'Conflict: the given sha does not match the current file');
  }
  const contentRaw = parsed.value.content;
  if (typeof contentRaw !== 'string') return errorReply(422, 'Validation Failed: content is required');
  const data = Buffer.from(contentRaw.replace(/\s+/g, ''), 'base64');
  const blobOid = ctx.forge.objects.put('blob', data);
  const newTree = updateTreeAtPath(ctx.forge.objects, tree, parts, blobOid);
  const timeSec = ctx.forge.clock.tick();
  const message = strField(parsed.value, 'message', `Update ${parts.join('/')}`);
  const commitOid = ctx.forge.objects.put(
    'commit',
    buildCommit({ tree: newTree, parents: tip === null ? [] : [tip], name: FORGE_NAME, email: FORGE_EMAIL, timeSec, message }),
  );
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  return jsonReply(isUpdate ? 200 : 201, {
    content: {
      type: 'file',
      name: parts[parts.length - 1],
      path: parts.join('/'),
      sha: blobOid,
      size: data.length,
      encoding: 'base64',
    },
    commit: { sha: commitOid, message },
  });
}

function deleteContents(ctx: Ctx, repo: Repo, parts: string[]): Reply {
  const parsed = parseJsonBody(ctx);
  if (!parsed.ok) return errorReply(400, 'Problems parsing JSON');
  if (parts.length === 0) return errorReply(404, 'Not Found');
  const branch = strField(parsed.value, 'branch', repo.defaultBranch) || repo.defaultBranch;
  const { tip, tree } = writeBase(ctx, repo, branch);
  if (tip === null || tree === null) return errorReply(404, 'Not Found');
  const existing = lookupPath(ctx.forge.objects, tree, parts);
  if (existing === undefined || existing.isTree) return errorReply(404, 'Not Found');
  const sha = parsed.value.sha;
  if (typeof sha === 'string' && sha !== '' && sha !== existing.oid) {
    return errorReply(409, 'Conflict: the given sha does not match the current file');
  }
  const newTree = updateTreeAtPath(ctx.forge.objects, tree, parts, null);
  const timeSec = ctx.forge.clock.tick();
  const message = strField(parsed.value, 'message', `Delete ${parts.join('/')}`);
  const commitOid = ctx.forge.objects.put(
    'commit',
    buildCommit({ tree: newTree, parents: [tip], name: FORGE_NAME, email: FORGE_EMAIL, timeSec, message }),
  );
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  return jsonReply(200, { content: null, commit: { sha: commitOid, message } });
}

// ------------------------------------------------------- branches and refs

function listBranches(repo: Repo): Reply {
  const branches = repo.branchNames().map((name) => ({
    name,
    commit: { sha: repo.branchTip(name) ?? '' },
    protected: false,
  }));
  return jsonReply(200, branches);
}

function getBranch(repo: Repo, name: string): Reply {
  const tip = repo.branchTip(name);
  if (tip === null) return errorReply(404, 'Not Found');
  return jsonReply(200, { name, commit: { sha: tip }, protected: false });
}

function listRefs(ctx: Ctx, repo: Repo): Reply {
  const all = [...repo.refs.keys()].sort().map((ref) => {
    const oid = repo.refs.get(ref)!;
    return { ref, object: { sha: oid, type: ctx.forge.objects.typeOf(oid) ?? 'commit' } };
  });
  return jsonReply(200, all);
}

function getRef(ctx: Ctx, repo: Repo, ref: string): Reply {
  if (!repo.refs.has(ref)) return errorReply(404, 'Not Found');
  const oid = repo.refs.get(ref)!;
  const type = ctx.forge.objects.typeOf(oid) ?? 'commit';
  return jsonReply(200, { ref, object: { sha: oid, type } });
}

function createRef(ctx: Ctx, repo: Repo): Reply {
  const parsed = parseJsonBody(ctx);
  if (!parsed.ok) return errorReply(400, 'Problems parsing JSON');
  const ref = strField(parsed.value, 'ref');
  const sha = strField(parsed.value, 'sha');
  if (!ref.startsWith('refs/')) return errorReply(422, 'Validation Failed: ref must start with refs/');
  if (!ctx.forge.objects.has(sha)) return errorReply(422, 'Validation Failed: sha does not name an object');
  if (repo.refs.has(ref)) return errorReply(422, 'Validation Failed: reference already exists');
  repo.refs.set(ref, sha);
  const type = ctx.forge.objects.typeOf(sha) ?? 'commit';
  return jsonReply(201, { ref, object: { sha, type } });
}

// ----------------------------------------------------------------- commits

function listCommits(ctx: Ctx, repo: Repo): Reply {
  const ref = ctx.query.get('sha');
  let tip: string | null;
  if (ref === null || ref === '') tip = repo.branchTip(repo.defaultBranch);
  else tip = repo.branchTip(ref) ?? (ctx.forge.objects.has(ref) ? peelToNonTag(ctx.forge.objects, ref) : null);
  if (tip === null) return jsonReply(200, []);
  const all = ancestryList(ctx.forge.objects, tip).map((oid) => commitJson(ctx.forge, oid));
  const paged = paginate(all, ctx.query);
  return jsonReply(200, paged === null ? all : paged.page);
}

// ------------------------------------------------------------------ labels

function createLabel(ctx: Ctx, repo: Repo): Reply {
  const parsed = parseJsonBody(ctx);
  if (!parsed.ok) return errorReply(400, 'Problems parsing JSON');
  const name = strField(parsed.value, 'name');
  if (name === '') return errorReply(422, 'Validation Failed: name is required');
  if (repo.labels.has(name)) return errorReply(422, 'Validation Failed: name already exists on this repository');
  const color = strField(parsed.value, 'color', 'ededed').replace(/^#/, '');
  const label = ctx.forge.createLabel(repo, name, color, strField(parsed.value, 'description'));
  return jsonReply(201, labelJson(label));
}

function listLabels(repo: Repo): Reply {
  return jsonReply(200, [...repo.labels.values()].map((label) => labelJson(label)));
}

// ------------------------------------------------------------------ issues

/** Label names out of an issue body: strings, or { name } objects. */
function labelNamesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') names.push(item);
    else if (typeof item === 'object' && item !== null && typeof (item as { name?: unknown }).name === 'string') {
      names.push((item as { name: string }).name);
    }
  }
  return names;
}

function createIssue(ctx: Ctx, repo: Repo): Reply {
  const parsed = parseJsonBody(ctx);
  if (!parsed.ok) return errorReply(400, 'Problems parsing JSON');
  const title = strField(parsed.value, 'title');
  if (title === '') return errorReply(422, 'Validation Failed: title is required');
  const labelNames = labelNamesOf(parsed.value.labels);
  for (const name of labelNames) {
    if (!repo.labels.has(name)) return errorReply(422, `Validation Failed: label "${name}" does not exist`);
  }
  const issue = ctx.forge.createIssue(repo, title, strField(parsed.value, 'body'), labelNames);
  return jsonReply(201, issueJson(repo, issue));
}

function listIssues(ctx: Ctx, repo: Repo): Reply {
  const state = ctx.query.get('state') ?? 'open';
  let issues = [...repo.issues.values()];
  if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
  const direction = ctx.query.get('direction') ?? 'desc';
  issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  const all = issues.map((issue) => issueJson(repo, issue));
  const paged = paginate(all, ctx.query);
  return jsonReply(200, paged === null ? all : paged.page);
}

function patchIssue(ctx: Ctx, repo: Repo, issue: Issue): Reply {
  const parsed = parseJsonBody(ctx);
  if (!parsed.ok) return errorReply(400, 'Problems parsing JSON');
  if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
  if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
  if (parsed.value.state === 'open' || parsed.value.state === 'closed') issue.state = parsed.value.state;
  if (parsed.value.labels !== undefined) {
    const labelNames = labelNamesOf(parsed.value.labels);
    for (const name of labelNames) {
      if (!repo.labels.has(name)) return errorReply(422, `Validation Failed: label "${name}" does not exist`);
    }
    issue.labelNames = labelNames;
  }
  issue.updatedAt = ctx.forge.clock.tickIso();
  return jsonReply(200, issueJson(repo, issue));
}

function createComment(ctx: Ctx, repo: Repo, number: number): Reply {
  const parsed = parseJsonBody(ctx);
  if (!parsed.ok) return errorReply(400, 'Problems parsing JSON');
  const comment = ctx.forge.addComment(repo, number, strField(parsed.value, 'body'));
  return jsonReply(201, {
    id: comment.id,
    body: comment.body,
    user: { login: repo.owner, id: OWNER_ID, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  });
}

function listComments(ctx: Ctx, repo: Repo, number: number): Reply {
  const all = ctx.forge.commentsOf(repo, number).map((comment) => ({
    id: comment.id,
    body: comment.body,
    user: { login: repo.owner, id: OWNER_ID, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  }));
  const paged = paginate(all, ctx.query);
  return jsonReply(200, paged === null ? all : paged.page);
}

// ------------------------------------------------------------------- pulls

function createPull(ctx: Ctx, repo: Repo): Reply {
  const parsed = parseJsonBody(ctx);
  if (!parsed.ok) return errorReply(400, 'Problems parsing JSON');
  const title = strField(parsed.value, 'title');
  const head = stripOwnerPrefix(strField(parsed.value, 'head'));
  const base = stripOwnerPrefix(strField(parsed.value, 'base'));
  if (title === '') return errorReply(422, 'Validation Failed: title is required');
  if (repo.branchTip(head) === null) return errorReply(422, `Validation Failed: head branch "${head}" does not exist`);
  if (repo.branchTip(base) === null) return errorReply(422, `Validation Failed: base branch "${base}" does not exist`);
  if (head === base) return errorReply(422, 'Validation Failed: head and base are the same branch');
  const pull = ctx.forge.createPull(repo, title, strField(parsed.value, 'body'), head, base);
  return jsonReply(201, pullJson(repo, pull));
}

/** "owner:branch" cross-repository spelling → the branch name itself. */
function stripOwnerPrefix(ref: string): string {
  const colon = ref.indexOf(':');
  return colon === -1 ? ref : ref.slice(colon + 1);
}

function listPulls(ctx: Ctx, repo: Repo): Reply {
  const state = ctx.query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  pulls.sort((a, b) => b.number - a.number);
  const all = pulls.map((pull) => pullJson(repo, pull));
  const paged = paginate(all, ctx.query);
  return jsonReply(200, paged === null ? all : paged.page);
}

function pullFiles(ctx: Ctx, repo: Repo, pull: Pull): Reply {
  const headTip = repo.branchTip(pull.headRef);
  const baseTip = repo.branchTip(pull.baseRef);
  if (headTip === null || baseTip === null) return jsonReply(200, []);
  const base = mergeBase(ctx.forge.objects, headTip, baseTip);
  const fromTree = ctx.forge.treeOfCommit(base ?? baseTip);
  const toTree = ctx.forge.treeOfCommit(headTip);
  const changes = diffTrees(ctx.forge.objects, fromTree, toTree);
  const files = changes.map((change) => {
    const before = change.fromOid === null ? '' : (ctx.forge.objects.get(change.fromOid)?.data.toString('utf8') ?? '');
    const after = change.toOid === null ? '' : (ctx.forge.objects.get(change.toOid)?.data.toString('utf8') ?? '');
    const counts = lineDiffCounts(before, after);
    return {
      sha: change.toOid ?? change.fromOid ?? '',
      filename: change.path,
      status: change.status,
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
    };
  });
  return jsonReply(200, files);
}

function mergePullReply(ctx: Ctx, repo: Repo, pull: Pull): Reply {
  const parsed = parseJsonBody(ctx);
  if (!parsed.ok) return errorReply(400, 'Problems parsing JSON');
  if (pull.merged) return errorReply(405, 'Pull Request is not mergeable: already merged');
  const check = ctx.forge.checkMerge(repo, pull);
  if (!check.ok) return errorReply(405, `Pull Request is not mergeable: ${check.reason}`);
  const sha = ctx.forge.mergePull(repo, pull);
  if (sha === null) return errorReply(405, 'Pull Request is not mergeable');
  return jsonReply(200, { sha, merged: true, message: 'Pull Request successfully merged' });
}

// ------------------------------------------------------------------ router

/**
 * Route one /api/v3 request. Segments arrive with the "api" and "v3" parts
 * already stripped. Anything unrouted is a JSON 404, never an HTML page.
 */
export function handleRest(ctx: Ctx, segments: string[]): Reply {
  const forge = ctx.forge;
  const method = ctx.method;

  if (segments.length === 0) {
    if (method === 'GET') return rootReply();
    return errorReply(404, 'Not Found');
  }

  if (segments[0] === 'meta' && segments.length === 1) {
    if (method === 'GET') return jsonReply(200, { installed_version: '1.0.0', verifiable_password_authentication: false });
    return errorReply(404, 'Not Found');
  }

  if (segments[0] === 'user') {
    if (segments.length === 1 && method === 'GET') {
      return jsonReply(200, { login: OWNER_LOGIN, id: OWNER_ID, type: 'User', name: 'ada iversen', email: 'adaiversen@example.invalid' });
    }
    if (segments.length === 2 && segments[1] === 'repos') {
      if (method === 'POST') return createRepo(ctx);
      if (method === 'GET') return listOwnRepos(ctx);
    }
    return errorReply(404, 'Not Found');
  }

  if (segments[0] === 'repos' && segments.length >= 3) {
    const repo = forge.repoByPath(segments[1]!, segments[2]!);
    if (repo === undefined) return errorReply(404, 'Not Found');
    const rest = segments.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') return jsonReply(200, repoJson(repo));
      if (method === 'PATCH') return patchRepo(ctx, repo);
      if (method === 'DELETE') {
        forge.deleteRepo(repo.name);
        return { status: 204, body: '' };
      }
      return errorReply(404, 'Not Found');
    }

    if (rest[0] === 'contents') {
      const parts = rest.slice(1);
      if (method === 'GET') return getContents(ctx, repo, parts);
      if (method === 'PUT') return putContents(ctx, repo, parts);
      if (method === 'DELETE') return deleteContents(ctx, repo, parts);
      return errorReply(404, 'Not Found');
    }

    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') return listBranches(repo);
      if (rest.length >= 2 && method === 'GET') return getBranch(repo, rest.slice(1).join('/'));
      return errorReply(404, 'Not Found');
    }

    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 2) {
        if (method === 'POST') return createRef(ctx, repo);
        if (method === 'GET') return listRefs(ctx, repo);
      }
      if (rest.length >= 3 && method === 'GET') return getRef(ctx, repo, `refs/${rest.slice(2).join('/')}`);
      return errorReply(404, 'Not Found');
    }

    if (rest[0] === 'git' && rest[1] === 'tags' && method === 'GET') {
      const tags = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/tags/'))
        .sort()
        .map((ref) => ({ name: ref.slice('refs/tags/'.length), commit: { sha: peelToNonTag(forge.objects, repo.refs.get(ref)!) } }));
      return jsonReply(200, tags);
    }

    if (rest[0] === 'commits') {
      if (rest.length === 1 && method === 'GET') return listCommits(ctx, repo);
      if (rest.length === 2 && method === 'GET') {
        if (!forge.objects.has(rest[1]!)) return errorReply(404, 'Not Found');
        return jsonReply(200, commitJson(forge, rest[1]!));
      }
      return errorReply(404, 'Not Found');
    }

    if (rest[0] === 'labels') {
      if (rest.length === 1) {
        if (method === 'POST') return createLabel(ctx, repo);
        if (method === 'GET') return listLabels(repo);
      }
      return errorReply(404, 'Not Found');
    }

    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') return createIssue(ctx, repo);
        if (method === 'GET') return listIssues(ctx, repo);
        return errorReply(404, 'Not Found');
      }
      const number = Number(rest[1]);
      const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
      if (rest.length === 2) {
        if (issue === undefined) return errorReply(404, 'Not Found');
        if (method === 'GET') return jsonReply(200, issueJson(repo, issue));
        if (method === 'PATCH') return patchIssue(ctx, repo, issue);
        return errorReply(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        const subjectExists = issue !== undefined || repo.pulls.has(number);
        if (!subjectExists) return errorReply(404, 'Not Found');
        if (method === 'POST') return createComment(ctx, repo, number);
        if (method === 'GET') return listComments(ctx, repo, number);
        return errorReply(404, 'Not Found');
      }
      return errorReply(404, 'Not Found');
    }

    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') return createPull(ctx, repo);
        if (method === 'GET') return listPulls(ctx, repo);
        return errorReply(404, 'Not Found');
      }
      const number = Number(rest[1]);
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) return errorReply(404, 'Not Found');
      if (rest.length === 2 && method === 'GET') return jsonReply(200, pullJson(repo, pull));
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') return pullFiles(ctx, repo, pull);
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') return mergePullReply(ctx, repo, pull);
      return errorReply(404, 'Not Found');
    }

    return errorReply(404, 'Not Found');
  }

  return errorReply(404, 'Not Found');
}

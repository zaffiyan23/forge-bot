// graphql.ts — a hand-written GraphQL parser and executor for exactly the
// surface the rules name: viewer, repository with issues/pullRequests
// connections, node, __type introspection, and the five mutations. It is
// deliberately small — a lexer, a recursive-descent parser for documents
// with variables, aliases, fragments and input objects, and a resolver
// switch per type — but it answers the suite's real documents, including
// batched operations and unknown-field errors in GitHub's wording.

import { diffTrees, mergeBase } from './gitobj.ts';
import type { Ctx, Reply } from './http.ts';
import { jsonReply } from './http.ts';
import type { Comment, Forge, Issue, Pull, Repo } from './store.ts';
import { OWNER_EMAIL, OWNER_ID, OWNER_LOGIN, OWNER_NAME } from './store.ts';

// ------------------------------------------------------------ global ids

/** Opaque, stable global ids: base64 of "Type:payload", never the bare number. */
export function globalId(type: string, payload: string | number): string {
  return Buffer.from(`${type}:${payload}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { type: string; payload: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon === -1) return null;
    return { type: text.slice(0, colon), payload: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function repoGlobalId(repo: Repo): string {
  return globalId('Repository', repo.id);
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', `${repo.id}.${issue.number}`);
}

function pullGlobalId(repo: Repo, pull: Pull): string {
  return globalId('PullRequest', `${repo.id}.${pull.number}`);
}

function commentGlobalId(comment: Comment): string {
  return globalId('IssueComment', comment.id);
}

// ------------------------------------------------------------------ lexer

type TokenKind = 'name' | 'string' | 'int' | 'punct' | 'spread' | 'eof';
interface Token {
  kind: TokenKind;
  value: string;
}

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!$=@|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (input.slice(i, i + 3) === '"""') {
        const end = input.indexOf('"""', i + 3);
        const text = end === -1 ? input.slice(i + 3) : input.slice(i + 3, end);
        tokens.push({ kind: 'string', value: text });
        i = end === -1 ? input.length : end + 3;
        continue;
      }
      let j = i + 1;
      let text = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1]!;
          text += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          text += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: text });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.eE+-]/.test(input[j]!)) j += 1;
      tokens.push({ kind: 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[_0-9A-Za-z]/.test(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ----------------------------------------------------------------- parser

type Value =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Record<string, Value> }
  | { kind: 'variable'; name: string };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Record<string, Value>;
  selection: FieldNode[] | null;
  fragment: string | null; // spread name, when this node is a fragment spread
  inlineOn: string | null; // type condition, when an inline fragment
}

interface Operation {
  type: 'query' | 'mutation';
  selection: FieldNode[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { on: string; selection: FieldNode[] }>;
}

class Parser {
  private tokens: Token[];
  private pos: number;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
    this.pos = 0;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expect(value: string): void {
    const token = this.next();
    if (token.value !== value) throw new Error(`expected ${value}, found ${token.value}`);
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { on: string; selection: FieldNode[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', selection: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        this.next();
        if (this.peek().kind === 'name') this.next(); // operation name
        if (this.atPunct('(')) this.parseVariableDefinitions();
        operations.push({ type: token.value as 'query' | 'mutation', selection: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.next().value;
        this.expect('on');
        const on = this.next().value;
        fragments.set(name, { on, selection: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${token.value}`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expect('(');
    while (!this.atPunct(')')) {
      this.expect('$');
      this.next(); // variable name
      this.expect(':');
      this.parseType();
      if (this.atPunct('=')) {
        this.next();
        this.parseValue();
      }
    }
    this.expect(')');
  }

  private parseType(): void {
    if (this.atPunct('[')) {
      this.next();
      this.parseType();
      this.expect(']');
    } else {
      this.next(); // type name
    }
    if (this.atPunct('!')) this.next();
  }

  private parseSelectionSet(): FieldNode[] {
    this.expect('{');
    const fields: FieldNode[] = [];
    while (!this.atPunct('}')) fields.push(this.parseField());
    this.expect('}');
    return fields;
  }

  private parseField(): FieldNode {
    if (this.peek().kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const on = this.next().value;
        return { alias: null, name: '', args: {}, selection: this.parseSelectionSet(), fragment: null, inlineOn: on };
      }
      const name = this.next().value;
      return { alias: null, name: '', args: {}, selection: null, fragment: name, inlineOn: null };
    }
    let nameToken = this.next();
    if (nameToken.kind !== 'name') throw new Error(`expected a field name, found ${nameToken.value}`);
    let alias: string | null = null;
    if (this.atPunct(':')) {
      this.next();
      alias = nameToken.value;
      nameToken = this.next();
    }
    const args: Record<string, Value> = {};
    if (this.atPunct('(')) {
      this.next();
      while (!this.atPunct(')')) {
        const argName = this.next().value;
        this.expect(':');
        args[argName] = this.parseValue();
      }
      this.expect(')');
    }
    let selection: FieldNode[] | null = null;
    if (this.atPunct('{')) selection = this.parseSelectionSet();
    return { alias, name: nameToken.value, args, selection, fragment: null, inlineOn: null };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.next().value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: Value[] = [];
      while (!this.atPunct(']')) items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, Value> = {};
      while (!this.atPunct('}')) {
        const key = this.next().value;
        this.expect(':');
        fields[key] = this.parseValue();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'string', value: token.value }; // enums ride as strings
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

/** Evaluate a parsed value against the operation's variables. */
function evalValue(value: Value, vars: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'string':
      return value.value;
    case 'int':
      return value.value;
    case 'bool':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => evalValue(item, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value.fields)) out[key] = evalValue(inner, vars);
      return out;
    }
    case 'variable':
      return vars[value.name];
  }
}

// -------------------------------------------------------------- execution

/** A value in the graph: a plain record tagged with its GraphQL type. */
type GqlObject = Record<string, unknown> & { __type: string };

function tagged(type: string, fields: Record<string, unknown>): GqlObject {
  return { __type: type, ...fields };
}

interface ExecCtx {
  forge: Forge;
  vars: Record<string, unknown>;
  errors: Array<{ message: string }>;
  fragments: Map<string, { on: string; selection: FieldNode[] }>;
}

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'description', 'isPrivate', 'owner',
    'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues',
    'pullRequest', 'pullRequests', 'createdAt', 'updatedAt',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'repository'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName',
    'mergeable', 'files', 'createdAt', 'updatedAt', 'author', 'repository',
  ],
  IssueComment: ['id', 'body', 'createdAt', 'author'],
  Ref: ['name', 'prefix', 'target'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestFile: ['path'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

function userObject(): GqlObject {
  return tagged('User', { login: OWNER_LOGIN, id: globalId('User', OWNER_ID), name: OWNER_NAME, email: OWNER_EMAIL });
}

function repoObject(repo: Repo): GqlObject {
  return tagged('Repository', { repo });
}

function issueObject(repo: Repo, issue: Issue): GqlObject {
  return tagged('Issue', { repo, issue });
}

function pullObject(repo: Repo, pull: Pull): GqlObject {
  return tagged('PullRequest', { repo, pull });
}

function commentObject(repo: Repo, comment: Comment): GqlObject {
  return tagged('IssueComment', { repo, comment });
}

/** Cursor for connection pagination: base64 of the last node's number. */
function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberOfCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

interface Page<T> {
  items: T[];
  hasNextPage: boolean;
  endCursor: string | null;
}

/** Slice an ordered list by first/after, where each item has a number. */
function pageOf<T extends { number: number }>(ordered: T[], args: Record<string, unknown>): Page<T> {
  let start = 0;
  const after = numberOfCursor(args.after);
  if (after !== null) {
    const index = ordered.findIndex((item) => item.number === after);
    if (index !== -1) start = index + 1;
  }
  const first = typeof args.first === 'number' && args.first >= 0 ? args.first : ordered.length;
  const items = ordered.slice(start, start + first);
  return {
    items,
    hasNextPage: start + items.length < ordered.length,
    endCursor: items.length > 0 ? cursorOf(items[items.length - 1]!.number) : null,
  };
}

function pageInfoObject(page: Page<unknown>): GqlObject {
  return tagged('PageInfo', {
    hasNextPage: page.hasNextPage,
    hasPreviousPage: false,
    startCursor: null,
    endCursor: page.endCursor,
  });
}

// --------------------------------------------------------------- resolvers

function resolveNode(forge: Forge, id: unknown): GqlObject | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.type === 'User') return userObject();
  if (decoded.type === 'Repository') {
    const repo = forge.listRepos().find((candidate) => candidate.id === Number(decoded.payload));
    return repo === undefined ? null : repoObject(repo);
  }
  if (decoded.type === 'Issue' || decoded.type === 'PullRequest') {
    const [repoId, number] = decoded.payload.split('.').map(Number);
    const repo = forge.listRepos().find((candidate) => candidate.id === repoId);
    if (repo === undefined) return null;
    if (decoded.type === 'Issue') {
      const issue = repo.issues.get(number!);
      return issue === undefined ? null : issueObject(repo, issue);
    }
    const pull = repo.pulls.get(number!);
    return pull === undefined ? null : pullObject(repo, pull);
  }
  if (decoded.type === 'IssueComment') {
    const commentId = Number(decoded.payload);
    for (const repo of forge.listRepos()) {
      for (const list of repo.comments.values()) {
        const comment = list.find((candidate) => candidate.id === commentId);
        if (comment !== undefined) return commentObject(repo, comment);
      }
    }
    return null;
  }
  return null;
}

function repoField(ctx: ExecCtx, repo: Repo, field: string, args: Record<string, unknown>): unknown {
  switch (field) {
    case 'id':
      return repoGlobalId(repo);
    case 'databaseId':
      return repo.id;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return repo.fullName;
    case 'description':
      return repo.description;
    case 'isPrivate':
      return repo.isPrivate;
    case 'owner':
      return userObject();
    case 'defaultBranchRef': {
      const tip = repo.branchTip(repo.defaultBranch);
      return tip === null ? null : tagged('Ref', { name: repo.defaultBranch, prefix: 'refs/heads/', target: tagged('GitObject', { oid: tip }) });
    }
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return true;
    case 'createdAt':
      return repo.createdAt;
    case 'updatedAt':
      return repo.updatedAt;
    case 'issue': {
      const issue = repo.issues.get(Number(args.number));
      return issue === undefined ? null : issueObject(repo, issue);
    }
    case 'issues': {
      let issues = [...repo.issues.values()];
      const states = args.states;
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((state) => String(state).toLowerCase()));
        issues = issues.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const descending = orderBy.direction === 'DESC';
      issues.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
      const page = pageOf(issues, args);
      return tagged('IssueConnection', {
        nodes: page.items.map((issue) => issueObject(repo, issue)),
        pageInfo: pageInfoObject(page),
        totalCount: issues.length,
        __page: page,
        __repo: repo,
        __kind: 'issue',
      });
    }
    case 'pullRequest': {
      const pull = repo.pulls.get(Number(args.number));
      return pull === undefined ? null : pullObject(repo, pull);
    }
    case 'pullRequests': {
      let pulls = [...repo.pulls.values()];
      const states = args.states;
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((state) => String(state).toUpperCase()));
        pulls = pulls.filter((pull) => wanted.has(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
      }
      pulls.sort((a, b) => a.number - b.number);
      const page = pageOf(pulls, args);
      return tagged('PullRequestConnection', {
        nodes: page.items.map((pull) => pullObject(repo, pull)),
        pageInfo: pageInfoObject(page),
        totalCount: pulls.length,
        __page: page,
        __repo: repo,
        __kind: 'pull',
      });
    }
    default:
      return undefined;
  }
}

function issueField(repo: Repo, issue: Issue, field: string): unknown {
  switch (field) {
    case 'id':
      return issueGlobalId(repo, issue);
    case 'number':
      return issue.number;
    case 'title':
      return issue.title;
    case 'body':
      return issue.body;
    case 'state':
      return issue.state.toUpperCase();
    case 'createdAt':
      return issue.createdAt;
    case 'updatedAt':
      return issue.updatedAt;
    case 'author':
      return userObject();
    case 'repository':
      return repoObject(repo);
    default:
      return undefined;
  }
}

function pullField(ctx: ExecCtx, repo: Repo, pull: Pull, field: string, args: Record<string, unknown>): unknown {
  switch (field) {
    case 'id':
      return pullGlobalId(repo, pull);
    case 'number':
      return pull.number;
    case 'title':
      return pull.title;
    case 'body':
      return pull.body;
    case 'state':
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    case 'merged':
      return pull.merged;
    case 'headRefName':
      return pull.headRef;
    case 'baseRefName':
      return pull.baseRef;
    case 'mergeable': {
      if (pull.merged || pull.state === 'closed') return 'UNKNOWN';
      return ctx.forge.checkMerge(repo, pull).ok ? 'MERGEABLE' : 'CONFLICTING';
    }
    case 'createdAt':
      return pull.createdAt;
    case 'updatedAt':
      return pull.updatedAt;
    case 'author':
      return userObject();
    case 'repository':
      return repoObject(repo);
    case 'files': {
      const headTip = repo.branchTip(pull.headRef);
      const baseTip = repo.branchTip(pull.baseRef);
      let paths: string[] = [];
      if (headTip !== null && baseTip !== null) {
        const base = mergeBase(ctx.forge.objects, headTip, baseTip);
        const changes = diffTrees(ctx.forge.objects, ctx.forge.treeOfCommit(base ?? baseTip), ctx.forge.treeOfCommit(headTip));
        paths = changes.map((change) => change.path);
      }
      const first = typeof args.first === 'number' && args.first >= 0 ? args.first : paths.length;
      const nodes = paths.slice(0, first).map((path) => tagged('PullRequestFile', { path }));
      return tagged('PullRequestFileConnection', {
        nodes,
        pageInfo: pageInfoObject({ items: [], hasNextPage: paths.length > nodes.length, endCursor: null }),
        totalCount: paths.length,
      });
    }
    default:
      return undefined;
  }
}

function typeObject(name: string): GqlObject | null {
  if (TYPE_FIELDS[name] !== undefined) {
    return tagged('__Type', {
      name,
      kind: 'OBJECT',
      fields: TYPE_FIELDS[name]!.map((field) => tagged('__Field', { name: field, description: null })),
      enumValues: null,
    });
  }
  if (ENUM_VALUES[name] !== undefined) {
    return tagged('__Type', {
      name,
      kind: 'ENUM',
      fields: null,
      enumValues: ENUM_VALUES[name]!.map((value) => tagged('__EnumValue', { name: value, description: null })),
    });
  }
  return null;
}

function resolveField(ctx: ExecCtx, type: string, source: GqlObject, field: string, args: Record<string, unknown>): unknown {
  if (field === '__typename') return type;
  const forge = ctx.forge;
  switch (type) {
    case 'Query':
      switch (field) {
        case 'viewer':
          return userObject();
        case 'repository': {
          const repo = forge.repoByPath(String(args.owner ?? ''), String(args.name ?? ''));
          return repo === undefined ? null : repoObject(repo);
        }
        case 'node':
          return resolveNode(forge, args.id);
        case '__type':
          return typeObject(String(args.name ?? ''));
        default:
          return undefined;
      }
    case 'Mutation':
      return resolveMutation(ctx, field, args);
    case 'User':
      return source[field];
    case 'Repository':
      return repoField(ctx, source.repo as Repo, field, args);
    case 'Issue':
      return issueField(source.repo as Repo, source.issue as Issue, field);
    case 'PullRequest':
      return pullField(ctx, source.repo as Repo, source.pull as Pull, field, args);
    case 'IssueComment': {
      const comment = source.comment as Comment;
      if (field === 'id') return commentGlobalId(comment);
      if (field === 'body') return comment.body;
      if (field === 'createdAt') return comment.createdAt;
      if (field === 'author') return userObject();
      return undefined;
    }
    case 'Ref':
      if (field === 'name') return source.name;
      if (field === 'prefix') return source.prefix;
      if (field === 'target') return source.target;
      return undefined;
    case 'GitObject':
      if (field === 'oid') return source.oid;
      if (field === 'id') return globalId('GitObject', String(source.oid));
      return undefined;
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestFileConnection': {
      if (field === 'nodes') return source.nodes;
      if (field === 'pageInfo') return source.pageInfo;
      if (field === 'totalCount') return source.totalCount;
      if (field === 'edges') {
        const nodes = (source.nodes as GqlObject[]) ?? [];
        const kind = source.__kind;
        const repo = source.__repo as Repo;
        return nodes.map((node) => {
          const number = kind === 'issue' ? (node.issue as Issue).number : (node.pull as Pull).number;
          void repo;
          return tagged('Edge', { node, cursor: cursorOf(number) });
        });
      }
      return undefined;
    }
    case 'PageInfo':
      return source[field];
    case '__Type':
      return source[field];
    case '__Field':
      return source[field];
    case '__EnumValue':
      return source[field];
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
      if (field === 'clientMutationId') return null;
      return field === 'issue' ? source.issue : undefined;
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      if (field === 'clientMutationId') return null;
      return field === 'pullRequest' ? source.pullRequest : undefined;
    case 'AddCommentPayload':
      if (field === 'clientMutationId') return null;
      if (field === 'commentEdge') return source.commentEdge;
      if (field === 'subject') return source.subject;
      return undefined;
    case 'Edge':
      return source[field];
    case 'IssueCommentEdge':
      return source[field];
    case 'PullRequestFile':
      return source[field];
    default:
      return undefined;
  }
}

/** Whether a type is known at all (unknown types answer fields as errors). */
function knownType(type: string): boolean {
  return TYPE_FIELDS[type] !== undefined || type === 'GitObject' || type === 'Edge';
}

function executeSelection(ctx: ExecCtx, type: string, source: GqlObject, selection: FieldNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const node of selection) {
    if (node.fragment !== null) {
      const fragment = ctx.fragments.get(node.fragment);
      if (fragment !== undefined && (fragment.on === type || fragment.on === 'Node')) {
        Object.assign(out, executeSelection(ctx, type, source, fragment.selection));
      }
      continue;
    }
    if (node.inlineOn !== null) {
      if (node.inlineOn === type) Object.assign(out, executeSelection(ctx, type, source, node.selection ?? []));
      continue;
    }
    const key = node.alias ?? node.name;
    const args: Record<string, unknown> = {};
    for (const [argName, argValue] of Object.entries(node.args)) args[argName] = evalValue(argValue, ctx.vars);
    const known = TYPE_FIELDS[type]?.includes(node.name) === true || node.name === '__typename' || (type === 'GitObject' && (node.name === 'oid' || node.name === 'id')) || (type === 'Edge' && (node.name === 'node' || node.name === 'cursor'));
    const value = known ? resolveField(ctx, type, source, node.name, args) : undefined;
    if (!known || (value === undefined && knownType(type))) {
      ctx.errors.push({ message: `Cannot query field "${node.name}" on type "${type}".` });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(ctx, value, node.selection);
  }
  return out;
}

/** Apply a sub-selection to a resolved value (objects, lists, scalars). */
function completeValue(ctx: ExecCtx, value: unknown, selection: FieldNode[] | null): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(ctx, item, selection));
  if (typeof value === 'object' && (value as GqlObject).__type !== undefined) {
    const object = value as GqlObject;
    if (selection === null) return object;
    return executeSelection(ctx, object.__type, object, selection);
  }
  return value;
}

// --------------------------------------------------------------- mutations

function inputOf(args: Record<string, unknown>): Record<string, unknown> {
  const input = args.input;
  if (typeof input === 'object' && input !== null) return input as Record<string, unknown>;
  return args;
}

function repoByGlobalId(forge: Forge, id: unknown): Repo | undefined {
  const decoded = typeof id === 'string' ? decodeGlobalId(id) : null;
  if (decoded === null || decoded.type !== 'Repository') return undefined;
  return forge.listRepos().find((repo) => repo.id === Number(decoded.payload));
}

function resolveMutation(ctx: ExecCtx, field: string, args: Record<string, unknown>): unknown {
  const forge = ctx.forge;
  const input = inputOf(args);
  switch (field) {
    case 'createIssue': {
      const repo = repoByGlobalId(forge, input.repositoryId);
      if (repo === undefined) {
        ctx.errors.push({ message: 'repository not found for createIssue' });
        return null;
      }
      const issue = forge.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return tagged('CreateIssuePayload', { issue: issueObject(repo, issue) });
    }
    case 'closeIssue': {
      const node = resolveNode(forge, input.issueId);
      if (node === null || node.__type !== 'Issue') {
        ctx.errors.push({ message: 'issue not found for closeIssue' });
        return null;
      }
      const repo = node.repo as Repo;
      const issue = node.issue as Issue;
      issue.state = 'closed';
      issue.updatedAt = forge.clock.tickIso();
      return tagged('CloseIssuePayload', { issue: issueObject(repo, issue) });
    }
    case 'createPullRequest': {
      const repo = repoByGlobalId(forge, input.repositoryId);
      if (repo === undefined) {
        ctx.errors.push({ message: 'repository not found for createPullRequest' });
        return null;
      }
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      if (repo.branchTip(head) === null || repo.branchTip(base) === null) {
        ctx.errors.push({ message: 'head or base branch not found for createPullRequest' });
        return null;
      }
      const pull = forge.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), head, base);
      return tagged('CreatePullRequestPayload', { pullRequest: pullObject(repo, pull) });
    }
    case 'mergePullRequest': {
      const node = resolveNode(forge, input.pullRequestId);
      if (node === null || node.__type !== 'PullRequest') {
        ctx.errors.push({ message: 'pull request not found for mergePullRequest' });
        return null;
      }
      const repo = node.repo as Repo;
      const pull = node.pull as Pull;
      const sha = forge.mergePull(repo, pull);
      if (sha === null) {
        ctx.errors.push({ message: 'pull request is not mergeable' });
        return tagged('MergePullRequestPayload', { pullRequest: pullObject(repo, pull) });
      }
      return tagged('MergePullRequestPayload', { pullRequest: pullObject(repo, pull) });
    }
    case 'addComment': {
      const node = resolveNode(forge, input.subjectId);
      if (node === null || (node.__type !== 'Issue' && node.__type !== 'PullRequest')) {
        ctx.errors.push({ message: 'subject not found for addComment' });
        return null;
      }
      const repo = node.repo as Repo;
      const number = node.__type === 'Issue' ? (node.issue as Issue).number : (node.pull as Pull).number;
      const comment = forge.addComment(repo, number, String(input.body ?? ''));
      return tagged('AddCommentPayload', {
        commentEdge: tagged('IssueCommentEdge', { node: commentObject(repo, comment), cursor: cursorOf(number) }),
        subject: node,
      });
    }
    default:
      return undefined;
  }
}

// -------------------------------------------------------------------- http

/** Execute one GraphQL operation body ({ query, variables }) → result object. */
export function executeGraphQL(forge: Forge, operation: Record<string, unknown>): Record<string, unknown> {
  const query = typeof operation.query === 'string' ? operation.query : '';
  const vars = (typeof operation.variables === 'object' && operation.variables !== null ? operation.variables : {}) as Record<string, unknown>;
  let document: Document;
  try {
    document = new Parser(lex(query)).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  const op = document.operations[0];
  if (op === undefined) return { errors: [{ message: 'no operation in document' }] };
  const ctx: ExecCtx = { forge, vars, errors: [], fragments: document.fragments };
  const rootType = op.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(ctx, rootType, tagged(rootType, {}), op.selection);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

/** POST /api/graphql: one operation, or a batch answered in order. */
export function handleGraphQL(ctx: Ctx): Reply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return jsonReply(400, { errors: [{ message: 'request body is not JSON' }] });
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((operation) =>
      executeGraphQL(ctx.forge, (typeof operation === 'object' && operation !== null ? operation : {}) as Record<string, unknown>),
    );
    return jsonReply(200, results);
  }
  if (typeof parsed === 'object' && parsed !== null) {
    return jsonReply(200, executeGraphQL(ctx.forge, parsed as Record<string, unknown>));
  }
  return jsonReply(400, { errors: [{ message: 'request body must be an operation or a batch' }] });
}

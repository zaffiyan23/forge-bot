// store.ts — the forge's single shared state: one object store for git data
// and one entity store for repositories, issues, pull requests, labels and
// comments. REST, git smart HTTP, GraphQL and MCP all read and write through
// here, which is what makes an object created on one surface the same object
// on every other. Everything is in memory (the trial pod's /bot is
// read-only) and every id and timestamp comes from counters and the trial
// clock, never from the wall clock.

import { ForgeClock, isoOf } from './clock.ts';
import {
  ObjectStore,
  buildCommit,
  buildTreeFromFiles,
  isAncestor,
  mergeBase,
  parseCommit,
  threeWayMerge,
} from './gitobj.ts';

/** The one login the trial token belongs to (the suite's scenario viewer). */
export const OWNER_LOGIN = 'adaiversen';
export const OWNER_ID = 1000;
export const OWNER_NAME = 'ada iversen';
export const OWNER_EMAIL = 'adaiversen@example.invalid';

/** Identity stamped on commits the forge itself authors (contents API, merges). */
export const FORGE_NAME = 'Forge';
export const FORGE_EMAIL = 'forge@make.fun';

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  /** Global numeric id, stable across surfaces and reads. */
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labelNames: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Comment {
  id: number;
  /** The issue or pull number the comment hangs on (one shared number space). */
  subjectNumber: number;
  body: string;
  createdAt: string;
}

export class Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;
  /** Full ref name ("refs/heads/main") → object id. */
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, Label>();
  readonly issues = new Map<number, Issue>();
  readonly pulls = new Map<number, Pull>();
  readonly comments = new Map<number, Comment[]>();
  /** Issues and pull requests share one per-repo number counter, as on GitHub. */
  private numberCounter = 0;

  constructor(id: number, owner: string, name: string, description: string, isPrivate: boolean, nowIso: string) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.defaultBranch = 'main';
    this.createdAt = nowIso;
    this.updatedAt = nowIso;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  nextNumber(): number {
    this.numberCounter += 1;
    return this.numberCounter;
  }

  /** The tip commit of a branch, or null when the branch does not exist. */
  branchTip(branch: string): string | null {
    return this.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** All branch names, in ref order. */
  branchNames(): string[] {
    const names: string[] = [];
    for (const ref of this.refs.keys()) {
      if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
    }
    return names.sort();
  }
}

export type MergeCheck =
  | { ok: true; tree: string }
  | { ok: false; reason: string };

/** The whole forge: clock, objects, entities, and the operations on them. */
export class Forge {
  readonly clock: ForgeClock;
  readonly objects = new ObjectStore();
  readonly repos = new Map<string, Repo>();
  private repoIdCounter = 0;
  private entityIdCounter = 0;
  private labelIdCounter = 0;
  private commentIdCounter = 0;

  constructor(clock: ForgeClock) {
    this.clock = clock;
  }

  private nextEntityId(): number {
    this.entityIdCounter += 1;
    return this.entityIdCounter;
  }

  // ------------------------------------------------------------ repositories

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    this.repoIdCounter += 1;
    const now = this.clock.tickIso();
    const repo = new Repo(this.repoIdCounter, OWNER_LOGIN, name, description, isPrivate, now);
    this.repos.set(name, repo);
    return repo;
  }

  repoByName(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  /** Resolve an owner/name pair; any owner but the token's login is a 404. */
  repoByPath(owner: string, name: string): Repo | undefined {
    if (owner !== OWNER_LOGIN) return undefined;
    return this.repos.get(name);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  // ----------------------------------------------------------------- labels

  createLabel(repo: Repo, name: string, color: string, description: string): Label {
    this.labelIdCounter += 1;
    const label: Label = { id: this.labelIdCounter, name, color, description };
    repo.labels.set(name, label);
    repo.updatedAt = this.clock.tickIso();
    return label;
  }

  // ----------------------------------------------------------------- issues

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): Issue {
    const now = this.clock.tickIso();
    const issue: Issue = {
      id: this.nextEntityId(),
      number: repo.nextNumber(),
      title,
      body,
      state: 'open',
      labelNames: [...labelNames],
      createdAt: now,
      updatedAt: now,
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  addComment(repo: Repo, subjectNumber: number, body: string): Comment {
    this.commentIdCounter += 1;
    const comment: Comment = {
      id: this.commentIdCounter,
      subjectNumber,
      body,
      createdAt: this.clock.tickIso(),
    };
    const list = repo.comments.get(subjectNumber) ?? [];
    list.push(comment);
    repo.comments.set(subjectNumber, list);
    return comment;
  }

  commentsOf(repo: Repo, subjectNumber: number): Comment[] {
    return repo.comments.get(subjectNumber) ?? [];
  }

  // ------------------------------------------------------------------ pulls

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull {
    const now = this.clock.tickIso();
    const pull: Pull = {
      id: this.nextEntityId(),
      number: repo.nextNumber(),
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      merged: false,
      mergeCommitSha: null,
      mergedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** The tree a commit points at, or null. */
  treeOfCommit(commitOid: string | null): string | null {
    if (commitOid === null) return null;
    const object = this.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  /**
   * Whether a pull can merge cleanly right now, and if so the resulting
   * tree: merge-base tree vs head tree vs current base tree, three-way.
   */
  checkMerge(repo: Repo, pull: Pull): MergeCheck {
    const headTip = repo.branchTip(pull.headRef);
    const baseTip = repo.branchTip(pull.baseRef);
    if (headTip === null) return { ok: false, reason: `head branch ${pull.headRef} is gone` };
    if (baseTip === null) return { ok: false, reason: `base branch ${pull.baseRef} is gone` };
    if (isAncestor(this.objects, headTip, baseTip)) {
      // Already fully contained in the base: merging is a no-op success.
      return { ok: true, tree: this.treeOfCommit(baseTip)! };
    }
    const base = mergeBase(this.objects, headTip, baseTip);
    const outcome = threeWayMerge(
      this.objects,
      this.treeOfCommit(base),
      this.treeOfCommit(headTip),
      this.treeOfCommit(baseTip),
    );
    if (outcome.conflict || outcome.files === null) {
      return { ok: false, reason: `conflicting changes in ${outcome.conflictPaths.join(', ')}` };
    }
    return { ok: true, tree: buildTreeFromFiles(this.objects, outcome.files) };
  }

  /**
   * Perform the squash merge: one new commit on the base branch whose tree
   * is the three-way result and whose only parent is the base tip. Returns
   * the merge commit id, or null when the merge conflicts.
   */
  mergePull(repo: Repo, pull: Pull): string | null {
    if (pull.merged) return pull.mergeCommitSha;
    const check = this.checkMerge(repo, pull);
    if (!check.ok) return null;
    const baseTip = repo.branchTip(pull.baseRef);
    const timeSec = this.clock.tick();
    const commitData = buildCommit({
      tree: check.tree,
      parents: baseTip === null ? [] : [baseTip],
      name: FORGE_NAME,
      email: FORGE_EMAIL,
      timeSec,
      message: `${pull.title} (#${pull.number})`,
    });
    const sha = this.objects.put('commit', commitData);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = sha;
    pull.mergedAt = isoOf(timeSec);
    pull.updatedAt = pull.mergedAt;
    return sha;
  }
}

/**
 * worktree.ts — Git worktree isolation for agents.
 *
 * Creates a temporary git worktree so the agent works on an isolated copy of
 * the repo. On completion, if no changes were made, the worktree is cleaned
 * up.  If changes exist, a branch is created and returned in the result.
 *
 * All git operations use async child_process.execFile.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function sanitizeBranchSegment(value: string, maxLen = 48): string {
	const sanitized = value
		.trim()
		.replace(/[^a-zA-Z0-9._-]/g, "_")
		.replace(/^[._-]+|[._-]+$/g, "");
	return (sanitized || "unknown").slice(0, maxLen);
}

function makeBranchName(memberName: string, spawnNonce: string): string {
	return [
		"pi",
		sanitizeBranchSegment(memberName),
		sanitizeBranchSegment(spawnNonce, 48),
	].join("/");
}

/** Async wrapper for execFile that returns stdout trimmed. */
export function git(args: string[], cwd: string, timeout = 30_000): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("git", args, { cwd, timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(stderr?.trim() || error.message));
			} else {
				resolve((stdout ?? "").trim());
			}
		});
	});
}

function randomHex(length: number): string {
	return randomUUID().replace(/-/g, "").slice(0, length);
}

/**
 * Check whether `cwd` is inside a git repository that has at least one
 * commit (HEAD exists).  Returns false (not throws) on any error.
 */
export async function isGitRepo(cwd: string): Promise<boolean> {
	try {
		await git(["rev-parse", "--git-dir"], cwd, 5_000);
		await git(["rev-parse", "HEAD"], cwd, 5_000);
		return true;
	} catch {
		return false;
	}
}

/**
 * Create a temporary detached-HEAD worktree for an agent.
 *
 * Returns `{ path, branch }` on success, or `undefined` if the repo is not
 * suitable or worktree creation fails (graceful degradation — the agent will
 * run in the normal cwd).
 */
export async function createWorktree(
	agentName: string,
	cwd: string,
	spawnNonce = randomHex(6),
): Promise<{ path: string; branch: string } | undefined> {
	// Quick pre-check: is it even a git repo?
	if (!(await isGitRepo(cwd))) return undefined;

	const branch = makeBranchName(agentName, spawnNonce);
	const suffix = randomHex(8);
	const worktreePath = join(tmpdir(), `pi-agent-${sanitizeBranchSegment(agentName)}-${suffix}`);

	try {
		const branchRef = `refs/heads/${branch}`;
		const branchExists = await git(["show-ref", "--verify", "--quiet", branchRef], cwd, 5_000)
			.then(() => true)
			.catch(() => false);
		if (branchExists) {
			await git(["worktree", "add", worktreePath, branch], cwd, 30_000);
		} else {
			await git(["worktree", "add", "-b", branch, worktreePath, "HEAD"], cwd, 30_000);
		}
		return { path: worktreePath, branch };
	} catch {
		// Graceful degradation — return undefined so caller falls back to
		// the normal cwd.
		return undefined;
	}
}

export interface WorktreeSnapshotResult {
	hasChanges: boolean;
	hasNewSnapshot?: boolean;
	branch?: string;
	commitOid?: string;
	summary?: string;
	committedAt?: string;
}

async function getCurrentBranch(worktreePath: string): Promise<string | undefined> {
	const branch = await git(["branch", "--show-current"], worktreePath, 5_000);
	return branch || undefined;
}

async function getHeadSnapshotMetadata(worktreePath: string): Promise<Pick<WorktreeSnapshotResult, "commitOid" | "summary" | "committedAt">> {
	const raw = await git(["show", "-s", "--format=%H%n%s%n%cI", "HEAD"], worktreePath, 5_000);
	const [commitOid, summary, committedAt] = raw.split("\n");
	return {
		commitOid: commitOid?.trim() || undefined,
		summary: summary?.trim() || undefined,
		committedAt: committedAt?.trim() || undefined,
	};
}

export async function persistWorktreeSnapshot(
	worktreePath: string,
	options?: { commitMessage?: string },
): Promise<WorktreeSnapshotResult> {
	if (!existsSync(worktreePath)) {
		return { hasChanges: false };
	}

	const branch = await getCurrentBranch(worktreePath).catch(() => undefined);
	const status = await git(["status", "--porcelain"], worktreePath, 10_000);
	if (!status) {
		const head = await getHeadSnapshotMetadata(worktreePath);
		return { hasChanges: false, hasNewSnapshot: false, branch, ...head };
	}

	await git(["add", "-A"], worktreePath, 10_000);
	const commitMessage = options?.commitMessage ?? "pi-agent snapshot";
	await git(
		["-c", "core.hooksPath=", "-c", "user.name=pi-agent", "-c", "user.email=pi-agent@local", "commit", "-m", commitMessage],
		worktreePath,
		10_000,
	);
	const head = await getHeadSnapshotMetadata(worktreePath);
	return { hasChanges: true, hasNewSnapshot: true, branch, ...head };
}

/**
 * Clean up a worktree after agent completion.
 *
 * - No changes → remove worktree entirely, return `{ hasChanges: false }`.
 * - Changes exist → `git add -A`, commit, create a branch pointing to HEAD,
 *   remove the worktree directory, and return `{ hasChanges: true, branch }`.
 * - Callers may override the commit message or branch label while preserving
 *   the same cleanup semantics.
 *
 * Errors are silently swallowed (best-effort cleanup).
 */
export async function cleanupWorktree(
	cwd: string,
	worktreePath: string,
	commitLabel: string,
	options?: { commitMessage?: string; branchLabel?: string },
): Promise<{ hasChanges: boolean; branch?: string; snapshotOid?: string }> {
	if (!existsSync(worktreePath)) {
		return { hasChanges: false };
	}

	try {
		const commitMessage = options?.commitMessage ?? `pi-agent: ${commitLabel.slice(0, 200)}`;
		const snapshot = await persistWorktreeSnapshot(worktreePath, { commitMessage });

		await removeWorktree(cwd, worktreePath);

		if (!snapshot.hasChanges) {
			return { hasChanges: false };
		}
		return { hasChanges: true, branch: snapshot.branch, snapshotOid: snapshot.commitOid };
	} catch {
		// Best-effort cleanup on error
		try { await removeWorktree(cwd, worktreePath); } catch { /* ignore */ }
		return { hasChanges: false };
	}
}

/** Force-remove a worktree, falling back to prune on failure. */
async function removeWorktree(cwd: string, worktreePath: string): Promise<void> {
	try {
		await git(["worktree", "remove", "--force", worktreePath], cwd, 10_000);
	} catch {
		try {
			await git(["worktree", "prune"], cwd, 5_000);
		} catch { /* ignore */ }
	}
}

/** Prune any orphaned worktrees (crash recovery, no-op if not a repo). */
export async function pruneWorktrees(cwd: string): Promise<void> {
	try {
		await git(["worktree", "prune"], cwd, 5_000);
	} catch { /* ignore */ }
}

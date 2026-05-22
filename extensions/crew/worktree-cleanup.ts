import { updateRoomMemberState } from "./storage.ts";
import type { RoomMemberState } from "./types.ts";
import { cleanupWorktree } from "./worktree.ts";

export function buildCleanupArchivePatch(
	member: RoomMemberState,
	result: Awaited<ReturnType<typeof cleanupWorktree>>,
): Pick<RoomMemberState, "worktree" | "worktreeResult"> {
	const patch: Pick<RoomMemberState, "worktree" | "worktreeResult"> = {
		worktree: null,
		worktreeResult: member.worktreeResult ?? null,
	};
	if (result.hasChanges || !member.worktreeResult?.hasChanges) {
		patch.worktreeResult = {
			hasChanges: result.hasChanges,
			branch: result.branch,
			...(result.snapshotOid ? { snapshotOid: result.snapshotOid } : {}),
		};
	}
	return patch;
}

export async function archiveMemberWorktreeCleanup(
	roomDir: string,
	cwd: string,
	member: RoomMemberState,
	options?: { commitMessage?: string; branchLabel?: string },
): Promise<Awaited<ReturnType<typeof cleanupWorktree>> | null> {
	if (!member.worktree?.path) {
		return null;
	}

	const result = await cleanupWorktree(
		cwd,
		member.worktree.path,
		member.name,
		options,
	);
	await updateRoomMemberState(roomDir, member.name, buildCleanupArchivePatch(member, result));
	return result;
}

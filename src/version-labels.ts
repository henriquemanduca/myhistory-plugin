import type { NoteVersionEvent } from "./history/types";

const VERSION_EVENT_LABELS: Record<NoteVersionEvent, string> = {
	baseline: "Baseline",
	created: "Created",
	modified: "Modified",
	deleted: "Deleted",
	restored: "Restored"
};

export function formatVersionEvent(event: NoteVersionEvent) {
	return VERSION_EVENT_LABELS[event] ?? event;
}

export function formatVersionSize(size: number) {
	if (!Number.isFinite(size) || size < 0) {
		return "";
	}

	if (size < 1024) {
		return `${size} B`;
	}

	if (size < 1024 * 1024) {
		return `${(size / 1024).toFixed(1)} KB`;
	}

	return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

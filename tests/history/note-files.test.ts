import { describe, expect, it } from "vitest";
import {
	collectNotesInFolder,
	createFileId,
	createNoteRecordId,
	createPathIndexId,
	createPrefixRange,
	createTextContentHash,
	createVersionId,
	createVersionIdRange,
	getContentSize,
	getFileIdFromNoteRecordId,
	getFileIdFromVersionId,
	getFileNameFromPath,
	getHistoryFolder,
	getHistoryFolderState,
	getParentFolderPath,
	getPathFromPathIndexId,
	isNoteFile,
	isNotePath,
	isPathInsideHistoryFolder,
	isTrackedNote,
	isTrackedNotePath,
	normalizeTextContent
} from "../../src/history/note-files";
import { TFile, TFolder } from "../mocks/obsidian";
import { createFakeVault } from "../mocks/vault";

describe("note identity", () => {
	it("builds and parses record ids", () => {
		expect(createNoteRecordId("abc")).toBe("note:abc");
		expect(getFileIdFromNoteRecordId("note:abc")).toBe("abc");
		expect(getFileIdFromNoteRecordId("version:abc:1")).toBeNull();
		expect(createPathIndexId("Notes/One.md")).toBe("path:Notes/One.md");
		expect(getPathFromPathIndexId("path:Notes/One.md")).toBe("Notes/One.md");
		expect(getPathFromPathIndexId("note:abc")).toBeNull();
	});

	it("creates distinct file ids", () => {
		expect(createFileId()).not.toBe(createFileId());
	});

	it("orders version ids chronologically as strings", () => {
		const earlier = createVersionId("file", 1_700_000_000_000, "aa");
		const later = createVersionId("file", 1_700_000_001_000, "aa");
		const muchLater = createVersionId("file", 99_999_999_999_999, "aa");

		expect([muchLater, earlier, later].sort()).toEqual([earlier, later, muchLater]);
		expect(getFileIdFromVersionId(earlier)).toBe("file");
		expect(getFileIdFromVersionId("note:file")).toBeNull();
	});

	it("keeps version ranges scoped to one file", () => {
		const range = createVersionIdRange("file-a");
		const versionId = createVersionId("file-a", 10, "bb");
		const otherFileVersionId = createVersionId("file-b", 10, "bb");

		expect(versionId >= range.startkey && versionId <= range.endkey).toBe(true);
		expect(otherFileVersionId >= range.startkey && otherFileVersionId <= range.endkey)
			.toBe(false);
	});

	it("builds prefix ranges that exclude neighbouring prefixes", () => {
		const range = createPrefixRange("note:");

		expect("note:abc" >= range.startkey && "note:abc" <= range.endkey).toBe(true);
		expect("path:abc" <= range.endkey).toBe(false);
	});
});

describe("content hashing", () => {
	it("normalizes line endings before hashing", async () => {
		expect(normalizeTextContent("a\r\nb\rc")).toBe("a\nb\nc");
		expect(await createTextContentHash("a\r\nb")).toBe(await createTextContentHash("a\nb"));
	});

	it("changes the hash when the content changes", async () => {
		expect(await createTextContentHash("one")).not.toBe(await createTextContentHash("two"));
	});

	it("measures content size in bytes", () => {
		expect(getContentSize("abc")).toBe(3);
		expect(getContentSize("ação")).toBe(6);
	});
});

describe("tracked note rules", () => {
	it("only accepts Markdown files", () => {
		expect(isNoteFile(new TFile("Notes/One.md"))).toBe(true);
		expect(isNoteFile(new TFile("Notes/One.MD"))).toBe(true);
		expect(isNoteFile(new TFile("Notes/One.pdf"))).toBe(false);
		expect(isNotePath("Notes/One.md")).toBe(true);
		expect(isNotePath("Notes/One.png")).toBe(false);
	});

	it("respects the tracked folder", () => {
		expect(isPathInsideHistoryFolder("Notes/One.md", "/")).toBe(true);
		expect(isPathInsideHistoryFolder("Notes/One.md", "Notes")).toBe(true);
		expect(isPathInsideHistoryFolder("Other/One.md", "Notes")).toBe(false);
		expect(isPathInsideHistoryFolder("NotesArchive/One.md", "Notes")).toBe(false);
		expect(isTrackedNote(new TFile("Notes/One.md"), "Notes")).toBe(true);
		expect(isTrackedNote(new TFile("Notes/One.pdf"), "Notes")).toBe(false);
		expect(isTrackedNotePath("Notes/One.md", "Notes")).toBe(true);
		expect(isTrackedNotePath("Notes/image.png", "Notes")).toBe(false);
	});

	it("collects only Markdown files from nested folders", () => {
		const nested = new TFolder("Notes/Nested", [
			new TFile("Notes/Nested/Deep.md"),
			new TFile("Notes/Nested/image.png")
		]);
		const folder = new TFolder("Notes", [
			new TFile("Notes/One.md"),
			new TFile("Notes/report.pdf"),
			nested
		]);

		expect(collectNotesInFolder(folder).map((file) => file.path).sort())
			.toEqual(["Notes/Nested/Deep.md", "Notes/One.md"]);
	});
});

describe("folder resolution", () => {
	it("returns the vault root or the custom folder", () => {
		const { app } = createFakeVault();

		expect(getHistoryFolder(app, "vault-root", "Notes")).toBe("/");
		expect(getHistoryFolder(app, "custom", "  Notes  ")).toBe("Notes");
	});

	it("reports an invalid custom folder", () => {
		const vault = createFakeVault();
		vault.createNote("Notes/One.md", "one");

		expect(getHistoryFolderState(vault.app, "/")).toEqual({
			valid: true,
			folder: vault.root
		});
		expect(getHistoryFolderState(vault.app, "Missing")).toEqual({
			valid: false,
			message: "Folder not found: Missing"
		});
		expect(getHistoryFolderState(vault.app, "Notes/One.md")).toEqual({
			valid: false,
			message: "Path is not a folder: Notes/One.md"
		});
	});
});

describe("path helpers", () => {
	it("splits names and parents", () => {
		expect(getFileNameFromPath("Notes/Nested/One.md")).toBe("One.md");
		expect(getFileNameFromPath("One.md")).toBe("One.md");
		expect(getParentFolderPath("Notes/Nested/One.md")).toBe("Notes/Nested");
		expect(getParentFolderPath("One.md")).toBe("");
	});
});

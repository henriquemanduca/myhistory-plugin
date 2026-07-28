import type { App } from "obsidian";
import { TAbstractFile, TFile, TFolder } from "./obsidian";

export interface FakeVault {
	app: App;
	root: TFolder;
	createNote: (path: string, content: string, mtime?: number) => TFile;
	createOtherFile: (path: string, mtime?: number) => TFile;
	writeNote: (path: string, content: string, mtime?: number) => TFile;
	deleteFile: (path: string) => TFile | null;
	renameFile: (path: string, newPath: string) => TFile;
	readNote: (path: string) => string | undefined;
	getFile: (path: string) => TFile | null;
	listPaths: () => string[];
}

/**
 * Minimal vault with a real folder tree, used so history tests exercise the
 * same path and folder rules the plugin relies on at runtime.
 */
export function createFakeVault(): FakeVault {
	const root = new TFolder("/");
	const contents = new Map<string, string>();
	const files = new Map<string, TAbstractFile>();
	const folders = new Map<string, TFolder>([["/", root]]);

	function ensureFolder(path: string): TFolder {
		if (!path || path === "/") {
			return root;
		}

		const existing = folders.get(path);

		if (existing) {
			return existing;
		}

		const separatorIndex = path.lastIndexOf("/");
		const parent = ensureFolder(separatorIndex > 0 ? path.slice(0, separatorIndex) : "/");
		const folder = new TFolder(path);
		folder.parent = parent;
		parent.children.push(folder);
		folders.set(path, folder);
		files.set(path, folder);
		return folder;
	}

	function attach(file: TFile) {
		const separatorIndex = file.path.lastIndexOf("/");
		const parent = ensureFolder(separatorIndex > 0 ? file.path.slice(0, separatorIndex) : "/");
		file.parent = parent;
		parent.children.push(file);
		files.set(file.path, file);
		return file;
	}

	function detach(file: TAbstractFile) {
		const parent = file.parent;

		if (parent) {
			parent.children = parent.children.filter((child) => child !== file);
		}

		files.delete(file.path);
		contents.delete(file.path);
	}

	function createNote(path: string, content: string, mtime = 1000) {
		const file = new TFile(path, content.length, mtime);
		contents.set(path, content);
		return attach(file);
	}

	function createOtherFile(path: string, mtime = 1000) {
		return attach(new TFile(path, 0, mtime));
	}

	function getFile(path: string) {
		const file = files.get(path);
		return file instanceof TFile ? file : null;
	}

	function writeNote(path: string, content: string, mtime?: number) {
		const existing = getFile(path);

		if (!existing) {
			return createNote(path, content, mtime);
		}

		contents.set(path, content);
		existing.stat.size = content.length;
		existing.stat.mtime = mtime ?? existing.stat.mtime + 1000;
		return existing;
	}

	function deleteFile(path: string) {
		const file = files.get(path);

		if (!file) {
			return null;
		}

		detach(file);
		return file instanceof TFile ? file : null;
	}

	function renameFile(path: string, newPath: string) {
		const file = getFile(path);

		if (!file) {
			throw new Error(`Cannot rename missing file: ${path}`);
		}

		const content = contents.get(path) ?? "";
		detach(file);
		return createNote(newPath, content, file.stat.mtime);
	}

	const vault = {
		configDir: ".obsidian",
		adapter: {
			exists: async (path: string) => files.has(path),
			stat: async (path: string) => {
				const file = getFile(path);
				return file ? { type: "file" as const, ...file.stat } : null;
			}
		},
		getName: () => "test-vault",
		getRoot: () => root,
		getAbstractFileByPath: (path: string) => files.get(path) ?? null,
		cachedRead: async (file: TFile) => contents.get(file.path) ?? "",
		read: async (file: TFile) => contents.get(file.path) ?? "",
		modify: async (file: TFile, content: string) => {
			writeNote(file.path, content);
		},
		create: async (path: string, content: string) => createNote(path, content, 2000),
		createFolder: async (path: string) => ensureFolder(path)
	};

	return {
		app: { vault } as unknown as App,
		root,
		createNote,
		createOtherFile,
		writeNote,
		deleteFile,
		renameFile,
		readNote: (path: string) => contents.get(path),
		getFile,
		listPaths: () => Array.from(files.keys()).sort()
	};
}

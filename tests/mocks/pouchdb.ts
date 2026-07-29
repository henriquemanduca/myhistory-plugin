interface StoredDocument {
	_id: string;
	_rev: string;
	[key: string]: unknown;
}

interface WritableDocument {
	_id: string;
	_rev?: string;
	_deleted?: boolean;
	[key: string]: unknown;
}

interface AllDocsRow {
	id: string;
	key: string;
	value?: { rev: string; deleted?: boolean };
	error?: string;
	doc?: StoredDocument;
}

interface AllDocsOptions {
	include_docs?: boolean;
	keys?: string[];
	startkey?: string;
	endkey?: string;
	descending?: boolean;
	limit?: number;
}

function createPouchError(status: number, name: string, message: string) {
	return Object.assign(new Error(message), { status, name });
}

function nextRevision(currentRevision: string | undefined) {
	const currentNumber = currentRevision
		? Number.parseInt(currentRevision.split("-")[0] ?? "0", 10)
		: 0;

	return `${currentNumber + 1}-fake`;
}

/**
 * In-memory stand-in for PouchDB covering only the operations the history
 * store uses. Documents are cloned in and out so tests cannot accidentally
 * share mutable state with the store under test.
 */
export class FakePouchDB<T extends { _id: string }> {
	static databases = new Map<string, Map<string, StoredDocument>>();

	static resetAll() {
		FakePouchDB.databases.clear();
	}

	static getDatabase(name: string) {
		return FakePouchDB.databases.get(name);
	}

	closed = false;
	private documents: Map<string, StoredDocument>;

	constructor(public name: string) {
		const existing = FakePouchDB.databases.get(name);

		if (existing) {
			this.documents = existing;
			return;
		}

		this.documents = new Map();
		FakePouchDB.databases.set(name, this.documents);
	}

	async get(id: string): Promise<T & { _rev: string }> {
		const document = this.documents.get(id);

		if (!document) {
			throw createPouchError(404, "not_found", `missing: ${id}`);
		}

		return structuredClone(document) as T & { _rev: string };
	}

	async put(document: WritableDocument) {
		return this.writeDocument(document);
	}

	async remove(document: { _id: string; _rev: string }) {
		return this.writeDocument({ ...document, _deleted: true });
	}

	async bulkDocs(documents: WritableDocument[]) {
		return documents.map((document) => {
			try {
				return this.writeDocument(document);
			} catch (error) {
				return {
					id: document._id,
					error: "conflict",
					reason: error instanceof Error ? error.message : "unknown"
				};
			}
		});
	}

	async allDocs(options: AllDocsOptions = {}) {
		const ids = options.keys ?? this.selectIdsInRange(options);
		const rows: AllDocsRow[] = [];

		for (const id of ids) {
			const document = this.documents.get(id);

			if (!document) {
				if (options.keys) {
					rows.push({ id, key: id, error: "not_found" });
				}

				continue;
			}

			rows.push({
				id,
				key: id,
				value: { rev: document._rev },
				...(options.include_docs ? { doc: structuredClone(document) } : {})
			});
		}

		return {
			total_rows: this.documents.size,
			offset: 0,
			rows
		};
	}

	async info() {
		return {
			db_name: this.name,
			doc_count: this.documents.size
		};
	}

	async close() {
		this.closed = true;
	}

	async destroy() {
		this.documents.clear();
		FakePouchDB.databases.delete(this.name);
		return { ok: true };
	}

	private selectIdsInRange(options: AllDocsOptions) {
		const sortedIds = Array.from(this.documents.keys()).sort();
		const ids = options.descending ? sortedIds.reverse() : sortedIds;
		const filteredIds = ids.filter((id) => {
			if (options.startkey !== undefined) {
				const withinStart = options.descending
					? id <= options.startkey
					: id >= options.startkey;

				if (!withinStart) {
					return false;
				}
			}

			if (options.endkey !== undefined) {
				return options.descending
					? id >= options.endkey
					: id <= options.endkey;
			}

			return true;
		});

		return typeof options.limit === "number"
			? filteredIds.slice(0, options.limit)
			: filteredIds;
	}

	private writeDocument(document: WritableDocument) {
		const existing = this.documents.get(document._id);

		if (existing && document._rev !== existing._rev) {
			throw createPouchError(409, "conflict", `Document update conflict: ${document._id}`);
		}

		if (!existing && document._rev) {
			throw createPouchError(409, "conflict", `Document update conflict: ${document._id}`);
		}

		if (document._deleted) {
			this.documents.delete(document._id);

			return {
				ok: true as const,
				id: document._id,
				rev: nextRevision(existing?._rev)
			};
		}

		const revision = nextRevision(existing?._rev);
		const { _deleted: ignoredDeletion, ...body } = document;
		void ignoredDeletion;
		this.documents.set(document._id, {
			...structuredClone(body),
			_id: document._id,
			_rev: revision
		});

		return {
			ok: true as const,
			id: document._id,
			rev: revision
		};
	}
}

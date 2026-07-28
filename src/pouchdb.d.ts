declare module "pouchdb" {
	namespace PouchDB {
		interface ExistingDocument {
			_id: string;
			_rev: string;
		}

		interface DeletedDocumentStub {
			_id: string;
			_rev: string;
			_deleted: true;
		}

		interface PutResponse {
			ok: boolean;
			id: string;
			rev: string;
		}

		interface BulkDocsSuccessRow {
			ok: true;
			id: string;
			rev: string;
		}

		interface BulkDocsErrorRow {
			id: string;
			error: string;
			reason?: string;
			status?: number;
		}

		type BulkDocsRow = BulkDocsSuccessRow | BulkDocsErrorRow;

		interface AllDocsOptions {
			include_docs?: boolean;
			keys?: string[];
			startkey?: string;
			endkey?: string;
			inclusive_end?: boolean;
			descending?: boolean;
			limit?: number;
			skip?: boolean;
		}

		interface AllDocsRow<T extends { _id: string }> {
			id: string;
			key: string;
			value?: {
				rev: string;
				deleted?: boolean;
			};
			error?: string;
			reason?: string;
			doc?: T & ExistingDocument;
		}

		interface AllDocsResponse<T extends { _id: string }> {
			total_rows: number;
			offset: number;
			rows: Array<AllDocsRow<T>>;
		}

		interface DatabaseInfo {
			db_name: string;
			doc_count?: number;
			update_seq?: string | number;
			error?: string;
			reason?: string;
		}

		type WritableDocument<T extends { _id: string }> =
			| T
			| (T & { _rev: string })
			| DeletedDocumentStub;
	}

	class PouchDB<T extends { _id: string }> {
		constructor(name: string);
		put(doc: T | (T & { _rev: string })): Promise<PouchDB.PutResponse>;
		bulkDocs(docs: Array<PouchDB.WritableDocument<T>>): Promise<PouchDB.BulkDocsRow[]>;
		get(id: string): Promise<T & PouchDB.ExistingDocument>;
		remove(doc: PouchDB.ExistingDocument): Promise<unknown>;
		allDocs(options?: PouchDB.AllDocsOptions): Promise<PouchDB.AllDocsResponse<T>>;
		info(): Promise<PouchDB.DatabaseInfo>;
		close(): Promise<void>;
		destroy(): Promise<unknown>;
	}

	export default PouchDB;
}

declare module "pouchdb/dist/pouchdb" {
	import PouchDB from "pouchdb";
	export default PouchDB;
}

import { describe, expect, it } from "vitest";
import { isPouchNotFound } from "../../src/utils/pouchdb-errors";

describe("PouchDB error guards", () => {
	it("recognizes not-found responses", () => {
		expect(isPouchNotFound({ status: 404 })).toBe(true);
		expect(isPouchNotFound({ status: 409 })).toBe(false);
		expect(isPouchNotFound(new Error("missing"))).toBe(false);
		expect(isPouchNotFound(null)).toBe(false);
	});
});

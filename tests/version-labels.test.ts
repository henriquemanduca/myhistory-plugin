import { describe, expect, it } from "vitest";
import { formatVersionEvent, formatVersionSize } from "../src/version-labels";

describe("formatVersionEvent", () => {
	it("labels every stored event", () => {
		expect(formatVersionEvent("baseline")).toBe("Baseline");
		expect(formatVersionEvent("created")).toBe("Created");
		expect(formatVersionEvent("modified")).toBe("Modified");
		expect(formatVersionEvent("deleted")).toBe("Deleted");
		expect(formatVersionEvent("restored")).toBe("Restored");
	});
});

describe("formatVersionSize", () => {
	it("scales the unit with the size", () => {
		expect(formatVersionSize(0)).toBe("0 B");
		expect(formatVersionSize(1023)).toBe("1023 B");
		expect(formatVersionSize(1024)).toBe("1.0 KB");
		expect(formatVersionSize(1024 * 1024 - 1)).toBe("1024.0 KB");
		expect(formatVersionSize(1024 * 1024)).toBe("1.0 MB");
		expect(formatVersionSize(5 * 1024 * 1024)).toBe("5.0 MB");
	});

	it("returns nothing for an unusable size", () => {
		expect(formatVersionSize(-1)).toBe("");
		expect(formatVersionSize(Number.NaN)).toBe("");
	});
});

import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			obsidian: resolve(import.meta.dirname, "tests/mocks/obsidian.ts")
		}
	},
	test: {
		clearMocks: true,
		environment: "node",
		include: ["tests/**/*.test.ts"],
		restoreMocks: true,
		setupFiles: ["tests/setup.ts"],
		coverage: {
			include: ["src/**/*.ts"],
			exclude: [
				"src/pouchdb.d.ts",
				"src/main.ts",
				"src/settings.ts",
				"src/history-panel-view.ts",
				"src/local-database-reset-modal.ts",
				"src/version-preview-modal.ts",
				"src/utils/button.ts"
			],
			provider: "v8",
			reporter: ["text", "html"]
		}
	}
});

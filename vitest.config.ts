import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Increase timeout for tests that spawn CLI tools (npx can be slow)
		testTimeout: 15000,
		hookTimeout: 15000,
	},
});

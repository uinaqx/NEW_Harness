import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Vite config: backend WS lives at ws://127.0.0.1:3126/transport.
// In dev we proxy nothing — the frontend talks to the backend directly.
export default defineConfig({
	plugins: [react()],
	resolve: {
		alias: {
			"@": resolve(__dirname, "src"),
			"@shared": resolve(__dirname, "..", "shared"),
		},
	},
	server: {
		port: 3125,
		host: "127.0.0.1",
		strictPort: true,
	},
	build: {
		outDir: "dist",
		emptyOutDir: true,
		target: "es2022",
	},
});

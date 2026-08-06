import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Everything inlines into one dist/index.html — open it from the filesystem,
// no server, no build step at run time.
export default defineConfig({
  base: "./",
  plugins: [viteSingleFile()],
  build: {
    target: "es2022",
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    reportCompressedSize: false,
  },
});

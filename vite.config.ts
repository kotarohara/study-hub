import { defineConfig } from "vite";
import { fresh } from "@fresh/plugin-vite";
import tailwindcss from "@tailwindcss/vite";

// Native NAPI addons cannot be bundled by rollup — keep them external in
// the server build; the runtime resolves them via the deno.json import map.
const nativeModules = ["@node-rs/argon2"];

export default defineConfig({
  plugins: [fresh(), tailwindcss()],
  ssr: {
    external: nativeModules,
  },
  environments: {
    ssr: {
      resolve: {
        external: nativeModules,
      },
    },
  },
});

import { defineConfig } from "vite";
import { fresh } from "@fresh/plugin-vite";
import tailwindcss from "@tailwindcss/vite";

// Note: the Fresh plugin bundles all server deps (resolve.noExternal: true),
// so dependencies that reach routes must be bundleable — no native NAPI
// addons (that is why password hashing uses hash-wasm, not @node-rs/argon2).
export default defineConfig({
  plugins: [fresh(), tailwindcss()],
});

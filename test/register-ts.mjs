// Test-only module hook: resolve relative "./x.js" imports to "./x.ts" when a
// TypeScript source file exists, so tests can run directly against src with
// type stripping while the compiled output still uses real .js specifiers.
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register(
  new URL("./ts-resolve-hook.mjs", import.meta.url),
  import.meta.url,
);

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js")) {
    if (context.parentURL) {
      const candidate = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
      if (candidate.protocol === "file:" && existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, shortCircuit: true, format: "module" };
      }
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  const isTs =
    (url.startsWith("file:") && /\.ts($|\?)/.test(url)) ||
    (!/^[a-z]+:/.test(url) && /\.ts$/.test(url)) ||
    (/^[a-zA-Z]:[\\/]/.test(url) && /\.ts$/.test(url));
  if (isTs) {
    const path = url.startsWith("file:") ? fileURLToPath(url) : url;
    const source = readFileSync(path, "utf8");
    return {
      format: "module",
      source: stripTypeScriptTypes(source, { mode: "transform" }),
      shortCircuit: true,
    };
  }
  return nextLoad(url, context);
}

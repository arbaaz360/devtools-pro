import type { PluginManifest } from "../../../../packages/plugin-contract/ts/generated.ts";
import { describePackage, type EngineTool } from "./describe.ts";

/**
 * Build-time discovery for the webview engine. Vite inlines every bundled
 * package manifest, so adding a package directory under plugins/ registers its
 * tools without a hand-maintained list. Discovery (the Rust crate and the SDK)
 * has already validated these manifests; a package that fails validation
 * fails the build before this module runs.
 */
const manifests = import.meta.glob("../../../../plugins/*/manifest.json", {
  eager: true,
  import: "default",
}) as Record<string, PluginManifest>;

/**
 * Packages whose processors import Node built-ins cannot run in the webview.
 * They stay on the native engine (hash) or wait for a browser-safe processor
 * (uuid, packet AG-106). The worker's glob excludes the same directories.
 */
export const NODE_ONLY_PACKAGES: readonly string[] = ["hash", "uuid"];

const packageDir = (path: string): string => path.split("/").at(-2) ?? path;

export const packageTools: readonly EngineTool[] = Object.entries(manifests)
  .map(([path, manifest]) => [packageDir(path), manifest] as const)
  .filter(([dir]) => !NODE_ONLY_PACKAGES.includes(dir))
  .sort(([a], [b]) => a.localeCompare(b))
  .flatMap(([dir, manifest]) => describePackage(manifest, dir));

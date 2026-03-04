#!/usr/bin/env bun
/**
 * Install the plugin locally for development.
 */
import { $ } from "bun";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const packageRoot = join(import.meta.dirname, "..");
const packageJson = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf-8"),
);
const PACKAGE_NAME: string = packageJson.name;

const OPENCODE_DIR = join(homedir(), ".config", "opencode");
const OPENCODE_JSON = join(OPENCODE_DIR, "opencode.json");
const PLUGINS_DIR = join(OPENCODE_DIR, "plugins");
const SYMLINK_PATH = join(PLUGINS_DIR, `${PACKAGE_NAME.split('/')[1]}.js`);
const distEntry = join(packageRoot, "dist", "index.js");

type Mode = "npm" | "symlink";
const mode: Mode = (process.argv[2] as Mode) || "npm";

if (mode !== "npm" && mode !== "symlink") {
  console.error(`Unknown mode: ${mode}`);
  console.error("Usage: bun scripts/plugin-install.ts [npm|symlink]");
  process.exit(1);
}

// -- helpers ----------------------------------------------------------------

/** Add or remove the plugin from the "plugin" array in opencode.json. */
function setPluginRegistered(registered: boolean) {
  let config: Record<string, unknown> = {};
  if (existsSync(OPENCODE_JSON)) {
    try {
      config = JSON.parse(readFileSync(OPENCODE_JSON, "utf-8"));
    } catch {
      console.warn(
        `Warning: could not parse ${OPENCODE_JSON}, will overwrite.`,
      );
      config = {};
    }
  }

  const plugins: unknown[] = Array.isArray(config.plugin) ? config.plugin : [];
  const idx = plugins.indexOf(PACKAGE_NAME);

  if (registered && idx === -1) {
    plugins.push(PACKAGE_NAME);
    console.log(`Added "${PACKAGE_NAME}" to ${OPENCODE_JSON}`);
  } else if (!registered && idx !== -1) {
    plugins.splice(idx, 1);
    console.log(`Removed "${PACKAGE_NAME}" from ${OPENCODE_JSON}`);
  } else {
    console.log(
      `"${PACKAGE_NAME}" already ${registered ? "in" : "absent from"} ${OPENCODE_JSON}`,
    );
    return;
  }

  config.plugin = plugins;
  writeFileSync(OPENCODE_JSON, JSON.stringify(config, null, 2) + "\n");
}

// -- mode: npm --------------------------------------------------------------
// No explicit build needed: npm install triggers prepublishOnly (clean + build).

if (mode === "npm") {
  mkdirSync(OPENCODE_DIR, { recursive: true });

  // npm install the local package
  console.log(`Installing ${PACKAGE_NAME} into ${OPENCODE_DIR}...`);
  await $`npm install ${packageRoot}`.cwd(OPENCODE_DIR);

  // Remove old symlink if present
  if (existsSync(SYMLINK_PATH)) {
    console.log(`Removing old symlink: ${SYMLINK_PATH}`);
    rmSync(SYMLINK_PATH);
  }

  setPluginRegistered(true);
}

// -- mode: symlink ----------------------------------------------------------

if (mode === "symlink") {
  console.log("Building plugin...");
  await $`bun run build`.cwd(packageRoot);

  mkdirSync(PLUGINS_DIR, { recursive: true });

  // Create or replace the symlink
  if (existsSync(SYMLINK_PATH)) {
    rmSync(SYMLINK_PATH);
  }
  symlinkSync(distEntry, SYMLINK_PATH);
  console.log(`Symlinked ${distEntry} → ${SYMLINK_PATH}`);

  setPluginRegistered(false);
}

console.log("Done.");

/**
 * Runtime detection — terminal type and user identity.
 *
 * Replicates Claude Code's logic for detecting terminal emulators
 * and generating a persistent anonymous user ID.
 */

import { randomBytes } from "crypto"
import { readFileSync, writeFileSync, existsSync } from "fs"
import { join } from "path"
import { homedir } from "os"

// ---------------------------------------------------------------------------
// Terminal detection (mirrors Claude Code's nQK() / detectTerminal)
// ---------------------------------------------------------------------------

/**
 * Detect the terminal emulator or IDE from environment variables.
 * Returns undefined if no terminal can be identified.
 *
 * Priority mirrors Claude Code: IDE-specific env vars first,
 * then TERM/TERM_PROGRAM, then terminal-specific env vars.
 */
export function detectTerminal(): string | undefined {
  const env = process.env

  // --- IDE detection ---
  const askpass = env.VSCODE_GIT_ASKPASS_MAIN ?? ""
  if (askpass.includes("cursor")) return "cursor"
  if (askpass.includes("windsurf")) return "windsurf"
  if (askpass.includes("code") || env.VSCODE_PID) return "vscode"

  if (env.TERMINAL_EMULATOR === "JetBrains-JediTerm") return "jetbrains"
  if (env.VisualStudioVersion) return "visualstudio"

  // --- Terminal emulators ---
  if (env.TERM === "xterm-ghostty") return "ghostty"
  if (env.TERM?.includes("kitty")) return "kitty"
  if (env.TERM_PROGRAM) return env.TERM_PROGRAM
  if (env.TMUX) return "tmux"
  if (env.STY) return "screen"
  if (env.KONSOLE_VERSION) return "konsole"
  if (env.GNOME_TERMINAL_SERVICE) return "gnome-terminal"
  if (env.XTERM_VERSION) return "xterm"
  if (env.VTE_VERSION) return "vte-based"
  if (env.TERMINATOR_UUID) return "terminator"
  if (env.KITTY_WINDOW_ID) return "kitty"
  if (env.ALACRITTY_LOG) return "alacritty"
  if (env.TILIX_ID) return "tilix"
  if (env.WT_SESSION) return "windows-terminal"
  if (env.SESSIONNAME && env.TERM === "cygwin") return "cygwin"
  if (env.MSYSTEM) return env.MSYSTEM.toLowerCase()

  return undefined
}

// ---------------------------------------------------------------------------
// User ID (mirrors Claude Code's fL())
// ---------------------------------------------------------------------------

/**
 * Path to the user-level config file where the anonymous user ID is persisted.
 * Claude Code uses ~/.claude.json; we use the same file to share identity.
 */
const CLAUDE_CONFIG_PATH = join(homedir(), ".claude.json")

interface ClaudeConfig {
  userID?: string
  [key: string]: unknown
}

/**
 * Get or create a persistent anonymous user ID.
 *
 * Claude Code generates `randomBytes(32).toString("hex")` (64-char hex string)
 * and stores it as `userID` in `~/.claude.json`. We read from the same file
 * to share the identity. If the file doesn't exist, we generate a new ID
 * but only persist it if we can.
 */
export function getUserId(): string {
  try {
    if (existsSync(CLAUDE_CONFIG_PATH)) {
      const raw = readFileSync(CLAUDE_CONFIG_PATH, "utf-8")
      const config: ClaudeConfig = JSON.parse(raw)
      if (config.userID && typeof config.userID === "string") {
        return config.userID
      }
    }
  } catch {
    // File doesn't exist or isn't valid JSON — generate new ID
  }

  // Generate new ID (same format as Claude Code: 32 random bytes → 64 hex chars)
  const userId = randomBytes(32).toString("hex")

  // Try to persist it (best-effort, don't fail)
  try {
    let config: ClaudeConfig = {}
    if (existsSync(CLAUDE_CONFIG_PATH)) {
      try {
        config = JSON.parse(readFileSync(CLAUDE_CONFIG_PATH, "utf-8"))
      } catch {
        // Overwrite invalid file
      }
    }
    config.userID = userId
    writeFileSync(CLAUDE_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n")
  } catch {
    // Can't persist — that's OK, just use the generated ID for this session
  }

  return userId
}

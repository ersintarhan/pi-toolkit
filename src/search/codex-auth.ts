import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CODEX_AUTH_PATH = join(homedir(), ".codex", "auth.json");

let cachedHasCodexAuth = false;

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

interface CodexAuthFile {
  auth_mode?: string;
  tokens?: {
    id_token?: string;
    access_token: string;
    refresh_token?: string;
    account_id: string;
    /** Optional expiry (ms epoch) emitted by some codex CLI versions. */
    expires_at?: number;
  };
}

export async function getCodexAuth(): Promise<{ accessToken: string; accountId: string }> {
  try {
    const raw = await readFile(CODEX_AUTH_PATH, "utf-8");
    const auth = JSON.parse(raw) as CodexAuthFile;

    if (!auth.tokens?.access_token) {
      throw new AuthError(
        "No access token found in Codex auth file. Please run `codex login` to authenticate."
      );
    }
    if (!auth.tokens?.account_id) {
      throw new AuthError(
        "No account ID found in Codex auth file. Please run `codex login` to authenticate."
      );
    }
    // If the auth file carries an expiry, fail early instead of round-tripping
    // to the API for a 401. (Older codex CLI builds omit this field; in that
    // case the API's 401 path in codex-search.ts still handles expiry.)
    if (typeof auth.tokens.expires_at === "number" && Date.now() >= auth.tokens.expires_at) {
      throw new AuthError(
        "Codex access token has expired. Please run `codex login` to re-authenticate."
      );
    }
    cachedHasCodexAuth = true;
    return {
      accessToken: auth.tokens.access_token,
      accountId: auth.tokens.account_id,
    };
  } catch (error) {
    if (error instanceof AuthError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AuthError(
        "Codex auth file not found at ~/.codex/auth.json.\n\n" +
          "Please run `codex login` to authenticate with OpenAI/Codex."
      );
    }
    throw new AuthError(
      `Failed to read Codex auth file: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function checkCodexAuth(): Promise<void> {
  await getCodexAuth();
}

export async function refreshCodexAuthStatus(): Promise<boolean> {
  try {
    await getCodexAuth();
    return true;
  } catch {
    cachedHasCodexAuth = false;
    return false;
  }
}

export function hasCodexAuth(): boolean {
  // Synchronous capability checks should not parse the auth file, but returning
  // false before the async session_start refresh causes misleading UI flicker.
  // Use file existence as an optimistic hint; executeCodexSearch still validates
  // tokens asynchronously via getCodexAuth().
  return cachedHasCodexAuth || existsSync(CODEX_AUTH_PATH);
}

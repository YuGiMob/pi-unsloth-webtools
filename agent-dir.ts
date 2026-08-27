import { homedir } from "node:os";
import { join } from "node:path";

function expandAgentDir(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

export function agentDir(): string {
  const env = (process.env.PI_CODING_AGENT_DIR ?? process.env.PI_AGENT_DIR)?.trim();
  if (env) return expandAgentDir(env);
  try {
    const home = homedir();
    if (home) return join(home, ".pi", "agent");
  } catch {}
  return "";
}

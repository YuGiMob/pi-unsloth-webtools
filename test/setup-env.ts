import { tmpdir } from "node:os";
import { join } from "node:path";

const ISOLATED_ENV_NAMES = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "JINA_API_KEY",
  "PI_AGENT_DIR",
  "PI_UNSLOTH_CACHE_DIR",
  "PI_UNSLOTH_WEBTOOLS_STATS",
];

for (const name of ISOLATED_ENV_NAMES) delete process.env[name];

process.env.PI_CODING_AGENT_DIR = join(tmpdir(), "pi-unsloth-webtools-test-agent");
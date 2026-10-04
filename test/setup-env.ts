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
  "PI_AGENT_DIR",
  "PI_UNSLOTH_CACHE_DIR",
  "PI_UNSLOTH_WEBTOOLS_STATS",
  "PI_LIGHTPANDA_BIN",
  "XDG_DATA_HOME",
];

for (const name of ISOLATED_ENV_NAMES) delete process.env[name];

process.env.PI_CODING_AGENT_DIR = join(tmpdir(), "pi-unsloth-webtools-test-agent");
process.env.XDG_DATA_HOME = join(tmpdir(), "pi-unsloth-webtools-test-data");
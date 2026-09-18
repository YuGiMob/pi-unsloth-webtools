const PROXY_ENV_NAMES = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
];

for (const name of PROXY_ENV_NAMES) delete process.env[name];
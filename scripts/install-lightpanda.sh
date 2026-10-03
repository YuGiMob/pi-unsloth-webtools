#!/usr/bin/env bash
set -euo pipefail

REPO="lightpanda-io/browser"
DEFAULT_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/pi-unsloth-webtools/lightpanda"
PINNED_FALLBACK_VERSION="1.0.0"

DIR="$DEFAULT_DIR"
VERSION=""
FORCE=0
ALLOW_SHIM=1
PRINT_PATH=0

usage() {
  cat <<'EOF'
Install the Lightpanda browser used by this package's local rendering tier.

Usage: bash scripts/install-lightpanda.sh [options]

  --version=X    Release tag to install (default: the newest stable release, e.g. 1.0.0;
                 pass --version=nightly for the nightly build)
  --dir=PATH     Install directory (default: $XDG_DATA_HOME/pi-unsloth-webtools/lightpanda)
  --force        Reinstall even when a working binary is already present
  --no-shim      Fail instead of bundling a newer libc when the system glibc is too old
  --print-path   Print only the launcher path (for scripts and CI)
  -h, --help     Show this message

On Linux, if the release needs a newer glibc than the system provides, the script
downloads Debian's libc6 for the current stable suite, extracts it into the install
directory, and writes a launcher shim that runs the binary with that libc. Point
`webRender.lightpandaPath` (settings.json) or `PI_LIGHTPANDA_BIN` at the printed path.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --version=*) VERSION="${arg#*=}" ;;
    --dir=*) DIR="${arg#*=}" ;;
    --force) FORCE=1 ;;
    --no-shim) ALLOW_SHIM=0 ;;
    --print-path) PRINT_PATH=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

need curl
need awk
need sed

os="$(uname -s)"
arch="$(uname -m)"
deb_arch=""
case "$os/$arch" in
  Linux/x86_64) asset="lightpanda-x86_64-linux"; deb_arch="amd64" ;;
  Linux/aarch64|Linux/arm64) asset="lightpanda-aarch64-linux"; deb_arch="arm64" ;;
  Darwin/x86_64) asset="lightpanda-x86_64-macos" ;;
  Darwin/arm64) asset="lightpanda-aarch64-macos" ;;
  MINGW*|MSYS*|CYGWIN*)
    cat >&2 <<'EOF'
Lightpanda ships no native Windows build. Run it inside WSL2 instead:

  1. in WSL:   bash scripts/install-lightpanda.sh
               (it prints a path such as /home/<you>/.local/share/pi-unsloth-webtools/lightpanda/lightpanda-run)

  2. in Windows settings.json, drive that binary through wsl.exe:

     {
       "webRender": {
         "lightpandaCommand": ["wsl.exe", "-e", "/home/<you>/.local/share/pi-unsloth-webtools/lightpanda/lightpanda-run"]
       }
     }

Everything else in this package (search, the browser-fingerprint transport) runs natively on Windows.
EOF
    exit 1 ;;
  *) echo "unsupported platform: $os/$arch" >&2; exit 1 ;;
esac

if [ -z "$VERSION" ]; then
  VERSION="$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=30" 2>/dev/null \
    | grep -o '"tag_name":[[:space:]]*"[^"]*"' \
    | sed -n 's/.*"\([^"]*\)"$/\1/p' \
    | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' \
    | head -1 || true)"
  if [ -z "$VERSION" ]; then
    echo "could not resolve the newest release; falling back to $PINNED_FALLBACK_VERSION" >&2
    VERSION="$PINNED_FALLBACK_VERSION"
  fi
fi

mkdir -p "$DIR"
binary="$DIR/lightpanda"
shim="$DIR/lightpanda-run"

report_path() {
  if [ "$PRINT_PATH" = 1 ]; then
    printf '%s\n' "$1"
  else
    echo "already installed and working: $1" >&2
  fi
  exit 0
}

if [ "$FORCE" = 0 ] && [ -x "$shim" ] && "$shim" version >/dev/null 2>&1; then
  report_path "$shim"
fi
if [ "$FORCE" = 0 ] && [ -x "$binary" ] && "$binary" version >/dev/null 2>&1; then
  report_path "$binary"
fi

url="https://github.com/$REPO/releases/download/$VERSION/$asset"
if [ "$PRINT_PATH" = 1 ]; then
  echo "downloading $VERSION ($asset)" >&2
  curl -fL --silent --show-error "$url" -o "$binary.part"
else
  echo "downloading $VERSION ($asset)"
  curl -fL --progress-bar "$url" -o "$binary.part"
fi
chmod +x "$binary.part"
mv -f "$binary.part" "$binary"
rm -f "$shim"

run_path="$binary"
if ! "$binary" version >/dev/null 2>&1; then
  run_path=""
  if [ "$ALLOW_SHIM" = 0 ] || [ "$os" != "Linux" ]; then
    echo "the $VERSION binary cannot run on this system:" >&2
    "$binary" version 2>&1 | head -3 >&2
    exit 1
  fi
  required="$({ "$binary" version 2>&1 || true; } | sed -n "s/.*GLIBC_\([0-9][0-9.]*\).*/\1/p" | sort -V | tail -1)"
  if [ -z "$required" ]; then
    echo "the $VERSION binary failed to start and the cause is not a glibc version:" >&2
    "$binary" version 2>&1 | head -3 >&2
    exit 1
  fi
  system_glibc="$(ldd --version 2>/dev/null | head -1 | sed -n 's/.* \([0-9][0-9.]*\)$/\1/p')"
  echo "binary needs glibc $required, system has ${system_glibc:-unknown}: bundling a newer libc"
  need dpkg-deb
  glibc_dir="$DIR/glibc"
  rm -rf "$glibc_dir"
  for suite in trixie stable sid; do
    index="https://deb.debian.org/debian/dists/$suite/main/binary-$deb_arch/Packages.gz"
    deb_path="$(curl -fsSL "$index" 2>/dev/null | gzip -dc 2>/dev/null \
      | awk '/^Package: libc6$/{found=1} found && /^Filename:/{print $2; exit}' || true)"
    [ -n "$deb_path" ] || continue
    echo "fetching libc6 from debian/$suite"
    curl -fsSL "https://deb.debian.org/debian/$deb_path" -o "$DIR/libc6.deb" || continue
    mkdir -p "$glibc_dir"
    dpkg-deb -x "$DIR/libc6.deb" "$glibc_dir"
    rm -f "$DIR/libc6.deb"
    loader="$(find "$glibc_dir" -path "*-linux-gnu/ld-linux-*.so.1" | head -1)"
    [ -n "$loader" ] || continue
    bundled_glibc="$("$loader" --version 2>/dev/null | head -1 | sed -n 's/.* \([0-9][0-9.]*\)$/\1/p')"
    if [ -z "$bundled_glibc" ]; then
      rm -rf "$glibc_dir"
      continue
    fi
    newest="$(printf '%s\n%s\n' "$required" "$bundled_glibc" | sort -V | tail -1)"
    if [ "$newest" != "$bundled_glibc" ]; then
      echo "bundled glibc $bundled_glibc is older than required $required, trying the next suite" >&2
      rm -rf "$glibc_dir"
      continue
    fi
    libdir="$(dirname "$loader")"
    {
      echo "#!/bin/sh"
      echo "exec \"$loader\" --library-path \"$libdir\" \"$binary\" \"\$@\""
    } > "$shim"
    chmod +x "$shim"
    if "$shim" version >/dev/null 2>&1; then
      run_path="$shim"
      echo "bundled glibc $bundled_glibc at $glibc_dir"
      break
    fi
    rm -rf "$glibc_dir" "$shim"
  done
  if [ -z "$run_path" ]; then
    echo "could not make $VERSION runnable on this system." >&2
    echo "Options: upgrade the distribution, run Lightpanda in a container, or install an older" >&2
    echo "release that targets this glibc (for example 0.2.9)." >&2
    exit 1
  fi
fi

installed_version="$("$run_path" version 2>/dev/null | head -1)"
if [ "$PRINT_PATH" = 1 ]; then
  printf '%s\n' "$run_path"
  exit 0
fi

echo
echo "Lightpanda $installed_version installed"
echo "  run this:          $run_path"
echo "  configure one of:"
echo "    export PI_LIGHTPANDA_BIN=$run_path"
echo "    settings.json:   { \"webRender\": { \"lightpandaPath\": \"$run_path\" } }"
echo "  verify:            $run_path fetch --dump markdown --wait-until networkidle https://example.com/"

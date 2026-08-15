#!/bin/sh
# Run the built server under the macOS seatbelt sandbox (sandbox.sb).
#
# - all file writes are blocked outside the OS temp dir
# - conversation history is persisted to $PI_WEB_DATA_DIR (~/.pi-web) and
#   explicitly allowed in the generated profile
# - no new processes can be spawned (bash tool is removed server-side)
set -eu

cd "$(dirname "$0")"

NODE_BIN="$(command -v node)"
PROFILE="$(mktemp "${TMPDIR:-/tmp}/pi-web-sandbox.XXXXXX")"
DATA_DIR="${PI_WEB_DATA_DIR:-$HOME/.pi-web}"
mkdir -p "$DATA_DIR"
trap 'rm -f "$PROFILE"' EXIT

# The static profile denies the initial exec of the node binary; append an
# allow for it (plus the persistent data dir) to a generated copy.
{
	cat sandbox.sb
	printf '(allow process-exec (literal "%s"))\n' "$NODE_BIN"
	printf '(allow file-write* (subpath "%s"))\n' "$DATA_DIR"
} > "$PROFILE"

export PI_WEB_SANDBOX=1
export PI_WEB_DATA_DIR="$DATA_DIR"
exec sandbox-exec -f "$PROFILE" node --env-file-if-exists=.env build

#!/bin/bash

__dirname="$(CDPATH= cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
electron_version=$(electron --version)

display_usage() {
    npm run electron-builder -- --help
}

if [ $# -le 1 ]; then
    display_usage
    exit 1
fi 

if [[ ( $# == "--help") ||  $# == "-h" ]]; then
    display_usage
    exit 0
fi

pushd "$__dirname/../dist/cncjs"
echo "Cleaning up \"`pwd`/node_modules\""
rm -rf node_modules
echo "Installing packages..."
npm install --production
npm dedupe
popd

echo "Rebuild native modules using electron ${electron_version}"
npm run electron-rebuild -- \
    --version=${electron_version:1} \
    --module-dir=dist/cncjs \
    --which-module=serialport

# macOS DMG creation can flake on GitHub runners with:
#   hdiutil: couldn't eject "diskN" - Resource busy
# Retry the electron-builder invocation a few times before failing.
max_attempts=3
attempt=1
while true; do
    set +e
    cross-env USE_HARD_LINKS=false npm run electron-builder -- "$@"
    exit_code=$?
    set -e

    if [ "$exit_code" -eq 0 ]; then
        break
    fi

    if [ "$attempt" -ge "$max_attempts" ]; then
        echo "electron-builder failed after ${max_attempts} attempts (exit ${exit_code})" >&2
        exit "$exit_code"
    fi

    echo "electron-builder failed (exit ${exit_code}); retrying (${attempt}/${max_attempts}) after cleanup..." >&2
    if command -v hdiutil >/dev/null 2>&1; then
        # Best-effort cleanup of leftover DMG mounts from a failed build.
        hdiutil info 2>/dev/null | awk '/\/dev\/disk[0-9]+/ { print $1 }' | while read -r disk; do
            hdiutil detach -force "$disk" >/dev/null 2>&1 || true
        done
    fi
    rm -rf output/*.dmg output/.icon-* 2>/dev/null || true
    attempt=$((attempt + 1))
    sleep $((attempt * 5))
done

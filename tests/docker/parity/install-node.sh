#!/bin/sh
# Install the official Node.js 22 binary for the capability runner in the test distro.
set -eu
work_dir=$(mktemp -d)
trap 'rm -f "$work_dir/SHASUMS256.txt" "$work_dir"/*.tar.xz; rmdir "$work_dir"' EXIT
curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$work_dir/SHASUMS256.txt"
node_archive=$(awk '$2 ~ /^node-v22\.[0-9]+\.[0-9]+-linux-x64.tar.xz$/ {print $2}' "$work_dir/SHASUMS256.txt")
[ -n "$node_archive" ] || exit 1
curl -fsSL "https://nodejs.org/dist/latest-v22.x/$node_archive" -o "$work_dir/$node_archive"
(cd "$work_dir" && grep "  $node_archive\$" SHASUMS256.txt | sha256sum -c -)
install -d /opt/freshrss-parity-node
tar -xJf "$work_dir/$node_archive" --strip-components=1 -C /opt/freshrss-parity-node
ln -sfn /opt/freshrss-parity-node/bin/node /usr/local/bin/node
ln -sfn /opt/freshrss-parity-node/bin/npm /usr/local/bin/npm
node --version

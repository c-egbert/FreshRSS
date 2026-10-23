#!/bin/sh
# Run as root only inside a disposable WSL/Linux test distribution.
set -eu

[ "$(id -u)" = 0 ] || { echo 'Provisioning requires the test distro administrator.' >&2; exit 1; }
. /etc/os-release
[ "$ID" = ubuntu ] && [ "$VERSION_ID" = 24.04 ] || exit 1

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl uidmap dbus-user-session slirp4netns python3 xz-utils
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
printf 'deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable\n' >/etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin docker-ce-rootless-extras

test_user=${FRESHRSS_TEST_USER:-freshrss-test}
if ! id "$test_user" >/dev/null 2>&1; then
	useradd --create-home --shell /bin/bash "$test_user"
fi
test_uid=$(id -u "$test_user")
test_gid=$(id -g "$test_user")
test_home=$(getent passwd "$test_user" | cut -d: -f6)
test_runtime_dir=/run/user/$test_uid
# Explicit subordinate mappings make the test daemon usable in a dedicated environment.
sed -i "/^$test_user:/d" /etc/subuid /etc/subgid
printf '%s:200000:65536\n' "$test_user" >>/etc/subuid
printf '%s:200000:65536\n' "$test_user" >>/etc/subgid
systemctl enable --now docker.service
loginctl enable-linger "$test_user"
systemctl start "user@$test_uid.service"
runuser -u "$test_user" -- env HOME="$test_home" XDG_RUNTIME_DIR="$test_runtime_dir" \
	dockerd-rootless-setuptool.sh install --force
runuser -u "$test_user" -- env HOME="$test_home" XDG_RUNTIME_DIR="$test_runtime_dir" \
	systemctl --user enable --now docker.service
docker --host unix:///var/run/docker.sock info --format '{{json .SecurityOptions}}'
runuser -u "$test_user" -- env HOME="$test_home" XDG_RUNTIME_DIR="$test_runtime_dir" \
	docker --host "unix://$test_runtime_dir/docker.sock" info --format '{{json .SecurityOptions}}'
sh "$(dirname "$0")/install-node.sh"

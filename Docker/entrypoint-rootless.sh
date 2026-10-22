#!/bin/sh

# Rootless image preparation for entrypoint.sh. This file is sourced so the
# runtime environment prepared here remains available to FreshRSS and Apache.

# --- Validate the rootless image identity and runtime mount ---
prepare_rootless_runtime() {
	umask 077
	[ "${FRESHRSS_ENTRYPOINT_PROFILE:-}" = rootless ] || die 'FRESHRSS_ENTRYPOINT_PROFILE must be rootless.'
	[ "$(id -u)" = 33 ] && [ "$(id -g)" = 33 ] || die 'This image requires UID/GID 33:33; prepare volume ownership before startup.'
	[ "${FRESHRSS_RUNTIME_DIR:-}" = /run/freshrss ] || die 'FRESHRSS_RUNTIME_DIR must be /run/freshrss.'
	runtime=$FRESHRSS_RUNTIME_DIR
	mkdir -p "$runtime" "$HOME" "$TMPDIR" "$runtime/php" "$runtime/apache" "$runtime/sessions" "$runtime/uploads" ||
		die 'Cannot prepare /run/freshrss; mount a tmpfs owned by 33:33 with mode 0700.'
	chmod 700 "$runtime" || die 'Could not secure /run/freshrss.'

	# --- Generate PHP runtime paths and session/upload configuration ---
	data_path=$(/usr/bin/php -r 'require "constants.php"; echo DATA_PATH;') || die 'Could not determine FreshRSS DATA_PATH.'
	case "$data_path" in
		/*) ;;
		*) die 'DATA_PATH must be an absolute path.' ;;
	esac
	newline='
'	carriage_return=$(printf '\r')
	case "$data_path" in
		*"$newline"*|*"$carriage_return"*) die 'DATA_PATH must not contain newlines.' ;;
	esac
	mkdir -p "$data_path/.tmp" || die "DATA_PATH '$data_path' must be writable by UID/GID 33:33."
	ini_path=$(printf '%s' "$data_path" | sed 's/[\\"]/\\&/g') || die 'Could not escape DATA_PATH for PHP configuration.'
	printf 'date.timezone = "%s"\npost_max_size = 32M\nupload_max_filesize = 32M\nsession.save_path = "%s/sessions"\nupload_tmp_dir = "%s/uploads"\nsys_temp_dir = "%s/.tmp"\n' \
		"$TZ" "$runtime" "$runtime" "$ini_path" >"$runtime/php/zz-rootless.ini" || die 'Could not write PHP runtime configuration.'

	# --- Generate writable Apache configuration ---
	listen=${LISTEN:-8080}
	if ! printf '%s\n' "$listen" | grep -Eq '^([[:alnum:]_.-]+:|\[[[:xdigit:]:]+\]:)?[0-9]{1,5}$'; then
		die 'LISTEN must be a port or address:port.'
	fi
	case "${ENABLE_ACCESS_LOG:-1}" in
		0|1) ;;
		*) die 'ENABLE_ACCESS_LOG must be 0 or 1.' ;;
	esac
	proxy=${TRUSTED_PROXY:-}
	case "$proxy" in
		*"$newline"*|*"$carriage_return"*|*\\*|*\"*) die 'Invalid TRUSTED_PROXY value.' ;;
	esac
	APACHE_CONFIG="$runtime/FreshRSS.Apache.conf"
	export APACHE_CONFIG
	sed "s/^Listen .*/Listen $listen/" /etc/apache2/sites-available/FreshRSS.Apache.conf >"$APACHE_CONFIG" || die 'Could not generate the FreshRSS Apache configuration.'
	if [ "${ENABLE_ACCESS_LOG:-1}" = 0 ]; then
		sed -i '/^[[:space:]]*CustomLog[[:space:]]/s/^/#/' "$APACHE_CONFIG" || die 'Could not disable the Apache access log.'
	fi
	if [ "$proxy" = 0 ]; then
		sed -i '/^[[:space:]]*RemoteIP/s/^/#/' "$APACHE_CONFIG" || die 'Could not disable trusted-proxy handling.'
	elif [ -n "$proxy" ]; then
		proxy=$(printf '%s' "$proxy" | sed 's/[#&\\]/\\&/g') || die 'Could not escape TRUSTED_PROXY.'
		sed -i "s#^[[:space:]]*RemoteIPInternalProxy .*#RemoteIPInternalProxy $proxy#" "$APACHE_CONFIG" || die 'Could not configure the trusted-proxy range.'
	fi
	printf 'Include /etc/apache2/apache2.conf\nInclude %s\n' "$APACHE_CONFIG" >"$runtime/apache2.conf" || die 'Could not write the Apache runtime configuration.'

	# --- Translate the optional CRON_MIN schedule ---
	if [ -n "${CRON_MIN:-}" ]; then
		/bin/bash ./Docker/rootless-cron.sh --translate "$CRON_MIN" >"$runtime/cron-minutes" || die 'Invalid CRON_MIN schedule.'
	fi

}

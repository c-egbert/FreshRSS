# Rootless image scope and architecture decisions

This document records the rootless image's implementation contract and test environment. The permanent rationale and decision history are in [DESIGN-DECISIONS.md](DESIGN-DECISIONS.md). The current image uses Debian-packaged snooze with a `CRON_MIN` translation/recurring runner. The same current image digest passed the v13 capability suite and baseline comparison on both the conventional engine and actual rootless WSL2 daemon. Focused identity/storage checks also passed on both engines. See the [current plan and reports](ROOTLESS-IMAGE-PLAN.md#current-build-and-parity-evidence). Remaining validation is focused on scheduler edge/lifecycle behavior and native arm64 execution; image-hardening work is out of scope.

## Scope and platform decisions

| Area | Decision |
| --- | --- |
| Application | Frozen comparison reference: commit `b33749fe6c9b0a4fec0ccb210b20202282444bfe`, archive SHA256 `dbef26efc5b6725796ef977f683c523f8f31876c619c493fdce584e2779ee0ac`. The current candidate uses the working tree and is identified by digest in the [current test reports](ROOTLESS-IMAGE-PLAN.md#current-build-and-parity-evidence). Older [Supercronic build identities](../tests/docker/reports/rootless-supercronic-build.json) are historical |
| Web and CLI | One `debian:13-slim` application image containing Apache `mod_php`, PHP CLI, mandatory `mod_auth_openidc`, and an optional nonroot scheduler |
| Application identity | Fixed `www-data`, UID `33`, GID `33`; all startup, web, CLI, and scheduled work use this identity. Operators prepare persistent storage; arbitrary UID overrides are outside scope |
| Default container port | `8080`, approved by the user for the new rootless image. Document container-side mappings such as `-p 8080:8080`; existing image tags retain port `80`. Preserve `LISTEN` overrides within runtime permissions |
| Rootless engine | Docker Rootless mode on Linux, tested independently of the image's application identity. A conventional rootful Linux Docker engine supplies the other test configuration |
| New image platforms | `linux/amd64` and `linux/arm64`, as approved by the user. Debian also offers `arm/v7`, but this base change does not expand the initial application support matrix |
| Existing image platforms | Existing Debian/Alpine publishing remains `linux/amd64`, `linux/arm/v7`, and `linux/arm64`, as declared in [docker-publish.yml](../.github/workflows/docker-publish.yml) |
| PHP changes | Keep the Debian PHP 8.4 line for this conversion. The Alpine reference's PHP 8.5 is a recorded baseline difference. Any unavoidable patch/package change must be measured in a refreshed root-running Debian reference before comparing rootless behaviour |
| Scheduler | Debian-packaged snooze with a validated `CRON_MIN` minute-list translation and recurring runner inside the application container. Start directly as UID/GID `33:33`; keep external scheduling available with `CRON_MIN` empty |

The two definitions have separate evidence requirements: the image must declare a nonzero default identity and work under a conventional engine; the deployment must also work under an actual rootless daemon. Current image metadata and full-suite reports cover the same amd64 digest under both engines. The focused [identity/storage report](../tests/docker/reports/rootless-identity-storage-v1.md) confirms runtime identities and operator-prepared storage under both engines, including rootless host mappings. Both capability reports identify the same immutable image digest and suite version.

## Frozen reference measurements

Both reference images were built from the same `git archive` rather than the modified working directory. Source revision labels and image digests are recorded in [step1-baselines.json](../tests/docker/reports/step1-baselines.json); [Debian](../tests/docker/reports/step1-debian-build.log) and [Alpine](../tests/docker/reports/step1-alpine-build.log) build logs record resolved bases and package installation/cache use.

| Measurement | Debian reference | Alpine reference |
| --- | --- | --- |
| Image | `freshrss:scope-step1-debian` | `freshrss:scope-step1-alpine` |
| Image digest | `sha256:97f22bbfe9359e8a7ddc4f8139993745405505f62df69fc312aea7a16a417ca0` | `sha256:29c6f49f356552658a6ca89a625986894a44a9e3b298e3db9ec0db2f4506f9f5` |
| Image size, bytes | 368,225,931 | 119,738,528 |
| PHP | 8.4.26 | 8.5.12 |
| Apache | 2.4.69, `/usr/sbin/apache2` | 2.4.69, `/usr/sbin/httpd` |
| PHP executable | `/usr/bin/php8.4`, exposed as `/usr/bin/php` | `/usr/bin/php85`, exposed as `/usr/bin/php` |
| Existing application identity | `www-data`, `33:33` | `apache`, UID `100`, primary GID `101`, supplementary `www-data` GID `82` |
| PDO drivers | MySQL, PostgreSQL, SQLite | MySQL, PostgreSQL, SQLite |
| Median HTTP startup | 460 ms | 459 ms |
| Median CLI fixture refresh | 229 ms | 231 ms |
| Median memory after fixture work | 27.50 MiB | 24.64 MiB |

Each image had three sequential disposable installations with a limit of one CPU and 256 MiB. Startup includes `docker start`, port discovery, and installer readiness, with image caches already warm. The refresh changes one deterministic local RSS feed from one article to two and verifies the newly imported article through the authenticated API. Memory is Docker's reported working usage after that work. This provides a small repeatable comparison, not production capacity or latency guarantees. Engine/kernel/resources and every raw measurement are in the JSON report. The full PHP extension inventories are also stored there; Debian additionally provides `pcntl`, `sodium`, `pgsql`, and `sqlite3`, while both provide the required PDO and feed-processing modules.

## Debian base contract

Use `debian:13-slim`, exactly matching [the default Dockerfile](Dockerfile). The [live inventory](../tests/docker/reports/step1-base-inventory.json) derives its reference from that file, checks that the rootless Dockerfile agrees, and records the resolved index/platform digests, image configuration, tools, and reference PHP versions.

| Item | Observed contract |
| --- | --- |
| Resolved base | `debian:13-slim@sha256:62bd423aeee912639ca8ee681c2b762cb3e25137e0a92b20be455898a9f034ad`; the tag may change on later builds |
| Default identity/startup | UID/GID `0:0`, no entrypoint, command `["bash"]`; the final application image must explicitly declare `USER 33:33` and its own launcher |
| Available tools | Apt/dpkg, `/usr/bin/sh`, `/usr/bin/bash`, and `/usr/bin/su`; no PHP, Apache, or cron built in |
| Timezone data | `Europe/Paris` zoneinfo is present in the inspected base; retain explicit `tzdata` installation as an application dependency |
| Platforms | Base includes amd64, arm/v5, arm/v7, arm64/v8, 386, ppc64le, riscv64, and s390x. The application targets only the approved amd64/arm64 pair |
| Packaging | Install Apache, PHP 8.4, OIDC, and runtime dependencies directly through signed Debian repositories, matching the default Dockerfile's process. Keep Apt/dpkg and package metadata; remove Apt lists and build-only artifacts |

A separate dev/runtime base pair and copying a package filesystem into a different runtime are not required. Debian Apt installs all application packages, including snooze, directly in the runtime image. The Supercronic download stage has been removed. Record resolved bases/package versions and coordinate future digest pins with the default Dockerfile.

Track the selected Debian release and PHP package security support before promotion; do not reuse the superseded DHI label's support deadline. Record applicable support dates and update policy in Step 7. The scheduler, Apache, PHP, and OIDC module also need maintenance and vulnerability evidence. Native arm64 execution remains a later release test.

The [DHI inventory](../tests/docker/reports/step1-dhi-inventory.json), Step 0 build logs, and original scheduler/engine reports are historical evidence from the previous base selection. Keep their recorded identities unchanged. Current rootless-image functional parity is recorded in the [v13 reports](ROOTLESS-IMAGE-PLAN.md#current-build-and-parity-evidence). Earlier [Supercronic engine/scheduler assumption probes](../tests/docker/reports/step1-engines-debian.md) describe only that superseded scheduler.

The earlier root-running Debian parity results remain in [the prior report](../tests/docker/reports/rootless-debian-parity-v13.md). The [previous integrated Supercronic candidate](../tests/docker/reports/rootless-supercronic.md) is historical. The current snooze image passed all v13 capability assertions and a real scheduled refresh on both engines; focused process identity and storage ownership checks also passed. See the [current plan](ROOTLESS-IMAGE-PLAN.md#current-build-and-parity-evidence). Scheduler edge/lifecycle checks and native arm64 execution remain open. Frozen PHP 8.4.26 performance measurements are historical and not part of the current rootless-definition objective.

## Nonroot runtime and scheduling contract

| Path or resource | Ownership and behaviour |
| --- | --- |
| Application and public code | Root-owned, readable by `33:33`, unwritable during routine operation; public root remains `/var/www/FreshRSS/p` |
| `data/` or `DATA_PATH` | Operator-prepared persistent storage writable by `33:33`, including SQLite and extension data. Preserve current path and configuration precedence |
| Installed extension code | Read-only mount at `/var/www/FreshRSS/extensions`; write extension state below the configured data path |
| Runtime configuration, PID, locks, OIDC cache, PHP INI/session/upload files | Private per-container `/run/freshrss`, owned by `33:33`, mode `0700`; use a tmpfs for a read-only root filesystem. Recreate runtime contents on startup without edits to `/etc` or application code |
| Home and PHP scan environment | Image defaults `HOME=/run/freshrss/home` and `PHP_INI_SCAN_DIR=:/run/freshrss/php`; prepare both directories as `33:33`. Preserve PHP's distro scan path through the leading empty component |
| Refresh mutex | Default PHP temporary storage and `TMP_PATH` use shared `DATA_PATH/.tmp`; containers sharing data must use consistent paths. An explicit `TMP_PATH` override still needs matching shared storage. Cross-container contention is additional coverage outside the current two-definition acceptance check |
| Scheduler configuration | Private `/run/freshrss/cron-minutes` containing only a validated, sorted, deduplicated list of minutes. The refresh command is fixed in the runner; no general environment snapshot |
| Logs | Access logs retain redaction and the enable/disable setting. Scheduler output, exit failures, and shutdown events reach container stdout/stderr |

The launcher prepares runtime configuration/storage and optional automatic setup, then starts foreground Apache and the optional snooze runner under default `33:33`. It supervises their process groups, forwards termination with an eight-second bound, reaps children, and exits nonzero if either required service exits. The runner forwards termination to its active child. Snooze and PHP remain in the scheduler's process group for bounded shutdown. The current capability suite proves a scheduled refresh; waiting/active-job shutdown, service failures, bootstrap interruption, and restart/recovery still need targeted snooze validation. Older [lifecycle checks](../tests/docker/reports/rootless-supercronic.md) apply only to Supercronic.

Direct `docker exec` CLI commands must read the same generated PHP configuration from the stable image-declared scan path; exporting a new path only inside the entrypoint would not update the environment of later exec processes. Explicit CLI command launches prepare their configuration/storage and run that command without starting another Apache or scheduler process. Keep the shared refresh mutex outside private runtime storage when multiple containers share the same data.

The [translation layer and recurring runner](rootless-cron.sh) validate the single `CRON_MIN` minute field, expand wildcards/lists/ranges/steps, sort and deduplicate the result, and write it into the private runtime directory during startup. Minutes must be 0–59 and steps 1–59; leading zeroes are read as decimal. A single stepped value such as `20/15` means `20,35,50`. Reject empty list elements, extra fields/whitespace/newlines, descending ranges, invalid characters, zero steps, and values outside the supported bounds. The [Docker documentation](README.md#rootless-image) lists translation examples. Empty `CRON_MIN` disables the runner. A real scheduled refresh was observed as UID/GID `33:33`; the remaining translation and lifecycle checks are listed below.

The runner waits using `/usr/bin/snooze -v -H '*' -M MINUTES -S 0`, then executes `/usr/bin/php /var/www/FreshRSS/app/actualize_script.php` and waits for completion before scheduling again. It inherits the application environment and PHP configuration. Use `TZ` consistently without replacing `/etc/localtime` during nonroot startup. Serial refreshes skip schedules elapsed while busy rather than replaying them; snooze's default 60-second lateness allowance applies while waiting. A guard prevents duplicate starts in one epoch minute. Start/completion timestamps, job output, and exit status go to container logs. Job failures are logged and scheduling continues; a failed snooze wait exits the required runner and stops the container. Retain FreshRSS's shared refresh exclusion for manual/external refresh as well.

Snooze is available through [Debian 13 Apt repositories](https://packages.debian.org/trixie/snooze) for both approved architectures. Its scheduling flags, one-command execution, timefile behaviour, and dry-run mode are described in the [Debian manual](https://manpages.debian.org/trixie/snooze/snooze.1.en.html). Record the resolved package version/origin in new build evidence; no upstream binary download or separate builder stage is used.

**Validation status:** the current snooze image has been built and the v13 capability suite, including a real `CRON_MIN='*'` refresh, passes on both engines using the same digest. The focused scheduler checks for translation/invalid input, selected-minute timing and duplicate starts, serial/long-running jobs, skipped ticks, failure recovery, inherited environment/PHP settings and timezone, disabled scheduling, and shutdown during waits/jobs also pass on both engines. See the [scheduler edge report](../tests/docker/reports/rootless-scheduler-edges-v1.md). DST transitions and simulated wall-clock changes were not tested. Earlier [Supercronic assumption results](../tests/docker/reports/step1-engines-debian.md) and [integration results](../tests/docker/reports/rootless-supercronic.md) retain their historical identities and do not establish those snooze-specific behaviours.

## Operator interfaces to preserve

Sources are [Docker documentation](README.md), [entrypoint.sh](entrypoint.sh), [Apache configuration](FreshRSS.Apache.conf), [constants.php](../constants.php), and the [capability suite](../tests/docker/README.md). The table records the behavior to preserve. Current functional, identity, storage, and scheduler evidence is summarized in the [current plan](ROOTLESS-IMAGE-PLAN.md#current-build-and-parity-evidence); DST/clock-step and native arm64 validation remain open.

| Setting | Existing behaviour/default | Nonroot implementation contract |
| --- | --- | --- |
| `TZ` | `UTC`; regional timezones supported | Keep tzdata, export `TZ`, and generate PHP INI override; scheduler uses the same timezone |
| `CRON_MIN` | Empty disables the built-in scheduler | Preserve optional minute expressions through the nonroot snooze translation/recurring runner; external scheduling remains supported |
| `DATA_PATH` | Empty falls back to configured/default data path | Honour the same precedence; require operator-prepared ownership and run preparation as `33:33` |
| `ENABLE_ACCESS_LOG` | `1`; `0` disables Apache access logging | Generate runtime Apache configuration with the requested logging state and existing credential redaction |
| `FRESHRSS_ENV` | Application falls back to `production`; `development` increases diagnostics | Preserve environment delivery and debug behaviour through web, CLI, and scheduled jobs |
| `COPY_LOG_TO_SYSLOG`, `COPY_SYSLOG_TO_STDERR` | Both `On` in the images | Preserve PHP flag values and useful stderr delivery; end-to-end syslog-daemon delivery remains separately unverified |
| `LISTEN` | Current images listen on port `80`; optional address/port override | Use user-approved default port `8080` for the new rootless image, preserve overrides through generated configuration, and document container-side mapping changes |
| `TRUSTED_PROXY` | Default private IPv4 proxy ranges from Apache configuration; `0` disables handling | Preserve range override and disable behaviour without modifying root-owned configuration |
| `INTERNAL_HOST_ALLOWLIST` | Empty blocks internal feed targets unless configured otherwise | Preserve allowlist precedence/validation and the negative internal-host test |
| `FRESHRSS_INSTALL` | Runs `cli/do-install.php`; preserves already-installed state | Preserve supported arguments and exit behaviour; replace shell evaluation with an explicit parser without breaking existing quoting |
| `FRESHRSS_USER` | Runs `cli/create-user.php`; preserves an existing user | Preserve supported arguments and exit behaviour, including creation with no default feeds and best-effort initial refresh |
| `OIDC_ENABLED` | Empty/`0` disables OIDC; positive integer enables it | Load the module at build time; generate conditional protection and validate configuration before Apache starts |
| `OIDC_PROVIDER_METADATA_URL` | Required provider discovery URL when OIDC is enabled | Preserve discovery and TLS verification; keep client/provider credentials out of logs |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | Required registered client settings | Preserve settings and protected runtime handling |
| `OIDC_CLIENT_CRYPTO_KEY` | Required module crypto passphrase setting | Preserve stable operator-provided key and private runtime access |
| `OIDC_REMOTE_USER_CLAIM` | Defaults to `preferred_username` | Preserve configured identity mapping in `http_auth` mode |
| `OIDC_SCOPES` | Defaults to `openid`; colons are accepted as separators | Preserve default and normalisation |
| `OIDC_X_FORWARDED_HEADERS` | Unset accepts no additional forwarded OIDC headers | Preserve explicit trusted-proxy configuration and identity-header rejection |
| `OIDC_SESSION_INACTIVITY_TIMEOUT` | `300` seconds | Preserve setting; module minimum observed as 10 seconds; keep inactivity-expiry test |
| `OIDC_SESSION_MAX_DURATION` | `27200` seconds in the shared entrypoint | Preserve setting independently of inactivity timeout |
| `OIDC_SESSION_TYPE` | `server-cache` | Preserve supported modes and provide writable private cache paths |
| `OIDC_DEFAULT_URL` | `/i/` | Preserve callback/default landing behaviour; keep public assets, API, and WebSub access rules |

Keep the interactive installer, automatic setup, administrator CLI, all advertised databases, form/HTTP Basic/OIDC authentication, APIs, WebSub, proxy/subpath handling, OPML/ZIP import/export, extensions, backup/restore, and persistent recreation in scope. Preserve read-only `constants.local.php`, `config.custom.php`, and `config-user.custom.php` mounts and their precedence. `PHP_INI_SCAN_DIR`, `TMPDIR`, and the configurable `TMP_PATH` must remain compatible with the runtime and shared-lock design. Tests under both engines must cover this contract; future untested checks remain unchecked in the main plan.

## Linux test environment and ownership preparation

The user approved a dedicated WSL2 distribution named `FreshRSS-Rootless-Step1`, stored below the ignored `tests/docker/.step1/wsl` directory. Its Ubuntu 24.04 rootfs was verified against the publisher's checksum, SHA256 `8251e27ffff381a4af5f41dcb94d867de3e0d9774a9241908ab34555d99315ea`. Reproduction scripts are in [tests/docker/step1](../tests/docker/step1/); raw [provisioning](../tests/docker/reports/step1-wsl-provision.log) and [replacement-base engine probe](../tests/docker/reports/step1-engines-debian.log) logs accompany the [refreshed engine report](../tests/docker/reports/step1-engines-debian.json). The [original DHI engine report](../tests/docker/reports/step1-engines.json) remains historical evidence.

| Test context | Explicit Docker endpoint | Identity and isolation |
| --- | --- | --- |
| Conventional Linux engine | `unix:///var/run/docker.sock` | Rootful Docker daemon, separate image/container/volume store |
| Rootless Linux engine | `unix:///run/user/1001/docker.sock` | Daemon owned by `freshrss-test` UID `1001`; user namespace maps UID/GID 1 onward to subordinate range `200000:65536`; separate image/container/volume store |

Use `wsl -d FreshRSS-Rootless-Step1 -u root` for administrative/rootful test commands. Use `wsl -d FreshRSS-Rootless-Step1 -u freshrss-test` with `XDG_RUNTIME_DIR=/run/user/1001` and the explicit rootless Docker endpoint for unprivileged test commands. Both daemons are managed by their respective systemd service managers. The test account is not granted access to the rootful Docker socket. Node.js 22.23.4 is installed for the capability runner; Docker and kernel versions and resource-controller warnings are recorded by the probes.

The rootless test environment reports unavailable cpuset and I/O resource controllers. Do not claim enforcement for those controls from this environment; CPU-quota/memory limits and final resource budgets still require the later operational tests.

Rootful storage for application `33:33` has host UID/GID `33:33`; the rootless test namespace maps it to `200032:200032`. Determine both host UID and GID from the actual namespace maps before preparing bind mounts. The probe caught a real preparation failure when the test user's UID was used as its GID despite a different primary group; it passes only when both ownership mappings are correct.

For an operator-owned empty directory or a newly created named volume, an explicit preparation container running as namespace UID 0 can assign `33:33`. This is an operator step; routine application startup remains nonroot. For example, run under the selected endpoint, using the inspected helper image digest:

```sh
docker volume create freshrss_data
docker run --rm --user 0:0 \
  --mount type=volume,source=freshrss_data,target=/data \
  alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 \
  chown 33:33 /data

mkdir -p ./freshrss-data
docker run --rm --user 0:0 \
  --mount type=bind,source="$(pwd)/freshrss-data",target=/data \
  alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 \
  chown 33:33 /data
```

Under the rootless endpoint, namespace UID 0 remains an unprivileged host user and can prepare ownership within its subordinate range; under the conventional endpoint, the operator must already be authorised to administer Docker. These empty-storage commands do not migrate an existing tree. Legacy Debian/Alpine data require a backup and a separately reviewed ownership migration on copies, including original group/write modes. Do not recursively change a live deployment as part of routine startup. Keep extension code read-only and separately mount its writable state.

The engine probe uses nonroot containers to verify bridge DNS, inter-container traffic, loopback-published HTTP, named-volume persistence, and mapped bind ownership on both endpoints. It also runs the scheduler assumption probe under both engines. Only disposable probe containers, networks, volumes, and temporary directories are removed; installed test daemons, helper images, and the dedicated distribution remain available for subsequent stages. The WSL virtual disk and downloaded/saved images are excluded from Git and Docker build contexts.

## Current status and next checks

The current snooze image is built and passes the v13 capability suite on both a conventional engine and the actual rootless WSL2 daemon using one immutable digest. Focused checks confirm application process identities, prepared-volume ownership/persistence, and scheduler edge behavior under both engines; see the [reports and build identity](ROOTLESS-IMAGE-PLAN.md#current-build-and-parity-evidence). DST transitions, simulated clock steps, and native arm64 execution remain unvalidated. Supply-chain, vulnerability, signing, and image-hardening gates are outside this rootless-definition effort.

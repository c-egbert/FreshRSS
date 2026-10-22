# Rootless image identity and storage verification

## Result

Passed on 2026-10-21 against image digest
`sha256:90288c8f56be65e008d668038261246abeb562912a8112f5944c4d08a6afd28f`
(`freshrss:entrypoint-refactor-rootless`, `USER 33:33`). The probes ran on the
dedicated WSL2 Linux conventional Docker daemon and the actual rootless Docker
daemon. Neither run used a runtime `--user` override.

## Process identity

Both engines reported `33:33` for PID 1 (`rootless-run.sh`), Apache, the
rootless cron runner, snooze, the container's visible process tree, and a
direct PHP CLI process. A process monitor also captured the scheduled
`/usr/bin/php /var/www/FreshRSS/app/actualize_script.php` process at `33:33`.
The entrypoint's initialization runs before PID 1 replaces itself with the
runtime launcher, under the image's declared default identity.

The engine probes were distinguished by their daemon security options: the
conventional daemon did not report `name=rootless`; the second reported
`name=rootless`. The rootless daemon runs as host UID `1001`, GID `1002`, and
maps container UID/GID `33:33` to host UID/GID `200032:200032`.

## Persistent storage

On each engine, a fresh named volume and a fresh bind mount were separately
prepared for `33:33`. FreshRSS startup and an application-user write succeeded
on each mount. The probe confirmed file ownership as `33:33` inside each
container, then recreated the container and confirmed the marker persisted and
the application user could write again.

| Engine | Storage | Owner inside container | Owner on Linux host | Write and recreation |
| --- | --- | --- | --- | --- |
| Conventional | Named volume | `33:33` | `33:33` | Passed |
| Conventional | Bind mount | `33:33` | `33:33` | Passed |
| Rootless | Named volume | `33:33` | `200032:200032` | Passed |
| Rootless | Bind mount | `33:33` | `200032:200032` | Passed |

The tests used only newly created, disposable storage. They do not test
migration or ownership changes for existing operator data. All probe
containers and named volumes were removed; the rootless bind directory was
removed by the WSL administrator after the test user's mapped ownership
prevented that user from deleting it.

## Commands and evidence

The temporary probe script was `tests/docker/.step1/verify-rootless-identity-storage.sh`.
The default-nonroot image and same-digest capability results are documented in
the [rootless image plan](../../../Docker/ROOTLESS-IMAGE-PLAN.md) and its
[conventional-engine](entrypoint-refactor-rootless-rootful-v13-retest.json) and
[rootless-engine](entrypoint-refactor-rootless-actual-rootless-v13.json)
reports. Those capability tests independently verify an end-to-end scheduled
feed refresh.

# Plan for the FreshRSS rootless image

## Goal and scope

This work produces an additional FreshRSS image that satisfies both rootless
definitions:

1. The image runs FreshRSS as its documented nonzero UID/GID by default under
   a conventional (rootful) container engine.
2. The same image and deployment work under an actual rootless container
   engine/runtime.

Preserve the existing FreshRSS operator workflows while meeting these two
requirements. This plan is not an image-hardening effort: image minimization,
read-only-root requirements, capability reduction, vulnerability gates, SBOMs,
signing, and supply-chain policy are outside this scope. Existing Debian and
Alpine image variants remain unchanged.

## Agreed image contract

- Base: `debian:13-slim`, matching the default Dockerfile's Debian release and
  package-install approach.
- Web/PHP: Apache `mod_php` and PHP CLI, including `mod_auth_openidc`.
- Default application identity: `www-data`, UID/GID `33:33`; operators prepare
  persistent storage ownership. Arbitrary runtime UID/GID overrides are not
  supported.
- Default internal HTTP port: `8080`; `LISTEN` remains configurable.
- Scheduling: preserve optional `CRON_MIN` in the application container using
  Debian-packaged snooze and the translation/runner scripts. Empty
  `CRON_MIN` disables the scheduler.
- Initial platform target: `linux/amd64` and `linux/arm64`. Native arm64
  execution has not yet been validated.
- Preserve install and user-creation paths, configuration mounts, custom data
  paths, CLI operations, advertised database backends, proxy/sub-path handling,
  WebSub, OIDC, and persistence.

See [the design decisions](DESIGN-DECISIONS.md) for rationale and
[the runtime scope](ROOTLESS-SCOPE.md) for implementation and operator details.

## Current build and parity evidence

The current rootless source was built as `freshrss:entrypoint-refactor-rootless`
with image digest
`sha256:90288c8f56be65e008d668038261246abeb562912a8112f5944c4d08a6afd28f`.
It declares `USER 33:33`. The same amd64 image digest passed the v13 capability
suite and baseline comparison on both Docker Desktop's conventional engine and
the dedicated WSL2 Docker Rootless daemon:

- [Conventional-engine report](../tests/docker/reports/entrypoint-refactor-rootless-rootful-v13-retest.json)
- [Actual rootless-engine report](../tests/docker/reports/entrypoint-refactor-rootless-actual-rootless-v13.json)

The suite covers 24 named capability assertions, including SQLite,
PostgreSQL/MySQL/MariaDB, reverse-proxy sub-path setup, WebSub delivery, OIDC
login/logout/inactivity expiry/rejection, and a scheduled feed refresh. Both
reports show completed runs, no failed assertions, and a passing baseline
comparison. The standard root image also passed its 24-assertion v13 run on the
conventional engine:
[report](../tests/docker/reports/entrypoint-refactor-root-v13.json).

The first rootless run exposed missing PHP runtime defaults. The rootless
runtime INI now sets the configured timezone, `post_max_size=32M`, and
`upload_max_filesize=32M`; the rebuilt digest above contains this fix. The
earlier failed run remains preserved as
[diagnostic evidence](../tests/docker/reports/entrypoint-refactor-rootless-rootful-v13.json).

The focused [identity and storage verification](../tests/docker/reports/rootless-identity-storage-v1.md)
also passed on both engines with no runtime user override. PID 1, Apache,
snooze, the cron runner, PHP CLI, and an observed scheduled refresh process ran
as `33:33`. Fresh named volumes and bind mounts accepted writes and retained
them across container recreation. On the rootless daemon, host ownership was
`200032:200032`, matching its subordinate UID/GID mappings.

These capability, identity/storage, and scheduler results demonstrate the two
rootless definitions for the tested amd64 candidate. They do not prove native
arm64 execution or behavior under simulated wall-clock changes.

## Remaining work, in order

1. **Complete scheduler checks.** Test `CRON_MIN` translation and invalid
   inputs; verify execution at selected minutes, no duplicate starts, serial
   jobs, skipped schedules during a long refresh, continued operation after a
   refresh failure, inherited PHP/environment/timezone settings, disabled
   scheduling, scheduler failure, and shutdown while waiting or refreshing.
   **Complete:** all listed cases passed on both engines for the digest above;
   see the [scheduler edge report](../tests/docker/reports/rootless-scheduler-edges-v1.md).
   DST transitions and simulated wall-clock changes remain outside this probe.
2. **Refresh this evidence and the operator guide** if code or tested behavior
   changes. Keep both definition-specific reports tied to the same immutable
   image digest and test suite version.

After those checks, review the two rootless-definition gates against the
evidence and document the image as an opt-in deployment. Do not infer native
arm64 validation from an amd64 run. Image publication and general release
readiness are separate decisions and are not implied by this plan.

## Acceptance checklist

- [x] Image metadata declares the fixed nonzero default identity `33:33`.
- [x] Same current image digest passes the v13 capability suite and baseline
  comparison on a conventional engine.
- [x] Same current image digest passes the v13 capability suite and baseline
  comparison on an actual rootless engine.
- [x] Confirm image default and running process identities: PID 1, Apache,
  snooze, cron runner, direct PHP CLI, and scheduled refresh all ran as `33:33`.
  See [identity/storage report](../tests/docker/reports/rootless-identity-storage-v1.md).
- [x] Verify prepared named-volume and bind-mount ownership, writes, and
  persistence on both engines, including rootless host mapping `200032:200032`.
  Existing operator data migration is not covered.
- [x] Complete scheduler edge and lifecycle checks on both engines for the tested
  schedule contract; DST transitions and simulated wall-clock changes remain
  unverified. See the [scheduler report](../tests/docker/reports/rootless-scheduler-edges-v1.md).
- [x] Keep deployment documentation and final evidence aligned with the tested
  image digest and supported contract.

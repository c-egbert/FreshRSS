# Docker design decisions

This file is the ongoing decision record for FreshRSS Docker images and their
runtime. Add an entry whenever a design choice affects image contents, build or
runtime behaviour, operator configuration, supported platforms, security
properties, or compatibility. Keep decisions here even after implementation;
use the plan and test reports to track delivery and evidence.

## How to maintain this record

1. Add the next sequential `DD-NNN` entry when a decision is made. Record the
   date, status, context, decision, and consequences.
2. Mark user-approved constraints as such. Distinguish an accepted design from
   implementation or validation: source code alone does not establish that a
   runtime behaviour works.
3. When a decision changes, keep the original entry, mark it `Superseded`, and
   link to the new entry. Do not rewrite historical test reports or image
   identities to make them appear to cover a later design.
4. Link implementation locations and relevant plan or test evidence. Update
   status and links when the image is built and validated.
5. Keep this file focused on *why* a choice was made and its constraints. Keep
   detailed procedures in `README.md`, rootless acceptance criteria in
   `ROOTLESS-IMAGE-PLAN.md`, and observed results in `tests/docker/reports/`.

New Docker work that changes one of these decisions should update this register
in the same change as the implementation or documentation update.

## Current decisions

### DD-001: Keep the existing Debian and Alpine image families

- **Date:** 2026-10-21
- **Status:** Accepted
- **Context:** FreshRSS already provides Debian and Alpine images with different
  package sets, user accounts, and platform support.
- **Decision:** The rootless image is an additional image design. Changes to it
  do not silently change existing image tags, their port defaults, or their
  supported platforms.
- **Consequences:** Preserve existing variants independently and compare the
  new image against the documented existing behaviour. The Docker user guide
  remains the operator-facing interface.

### DD-002: Require both nonroot execution and a rootless engine deployment

- **Date:** 2026-10-21
- **Status:** Accepted
- **Context:** A nonroot process can run under a conventional engine, and a
  rootless engine can run a process that is UID 0 inside its namespace. These
  properties are independent.
- **Decision:** The goal has two separate acceptance requirements: the image
  runs as a nonroot identity by default, and the complete deployment works
  under an actual rootless container engine.
- **Consequences:** Test the same image digest under conventional and actual
  rootless Docker engines. Record engine identity and namespace mappings; a
  runtime UID override alone does not satisfy either engine test.

### DD-003: Base the rootless image on the default Debian image

- **Date:** 2026-10-21
- **Status:** Accepted
- **Context:** The Debian image provides the existing OIDC implementation and
  matches the default Docker build and package-management process. An earlier
  DHI base proposal was replaced at the user's direction.
- **Decision:** Use `debian:13-slim`, install runtime packages through Debian
  Apt, and retain Apache `mod_php` plus PHP CLI in one application image.
- **Consequences:** Keep PHP, Apache, OIDC, and runtime dependencies compatible
  with Debian's package versions and ABI. Record package inputs when needed to
  reproduce a test build. Do not change the base without a new decision and
  refreshed parity evidence.
- **Implementation:** `Dockerfile-Rootless`.

### DD-004: Preserve OIDC through Apache's OIDC module

- **Date:** 2026-10-21
- **Status:** Accepted
- **Context:** OIDC is an existing Debian-image capability that operators need
  to keep when moving to the rootless image.
- **Decision:** Retain `mod_auth_openidc`, existing OIDC configuration, and the
  Apache request flow. Validate the authorization flow against the local test
  provider, including logout, expiry, and rejection cases.
- **Consequences:** The module must be present and enabled in the image so the
  application can start nonroot. Keep OIDC capability checks in the parity
  suite.
- **Implementation:** `Dockerfile-Rootless`, `entrypoint.sh`, and the local
  OIDC fixtures in `tests/docker/`.

### DD-005: Use the fixed `www-data` identity and operator-prepared storage

- **Date:** 2026-10-21
- **Status:** Accepted; image default, process identities, prepared-storage
  ownership/persistence, and full capability parity verified on both engines
- **Context:** Supporting arbitrary runtime IDs would add separate requirements
  for account lookup, Apache configuration, and mounted paths. The user chose a
  documented identity with operator-managed ownership.
- **Decision:** Default to UID/GID `33:33` (`www-data`) for startup, Apache,
  PHP CLI, and scheduled refresh. Operators prepare persistent volume
  ownership for this identity. Arbitrary UID/GID overrides are unsupported.
- **Consequences:** Keep application code read-only during routine operation,
  put transient configuration under `/run/freshrss`, and keep the refresh mutex
  in shared data storage so external and scheduled refreshes coordinate.
  Validate ownership through both engine types.
- **Implementation:** `Dockerfile-Rootless`, `entrypoint-rootless.sh`,
  `rootless-run.sh`, and `rootless-cron.sh`.

### DD-006: Give the new image its own internal port default

- **Date:** 2026-10-21
- **Status:** Accepted
- **Context:** A nonroot process should not need permission to bind a privileged
  port, while existing tags must preserve their current operator mappings.
- **Decision:** The new image listens on port `8080` by default and keeps the
  `LISTEN` override. Existing image variants keep their current port default.
- **Consequences:** Document mappings such as `-p 8080:8080` for the new image.
- **Implementation:** `Dockerfile-Rootless` and `entrypoint-rootless.sh`.

### DD-007: Preserve in-container `CRON_MIN` scheduling

- **Date:** 2026-10-21
- **Status:** Accepted; snooze build, scheduled-refresh capability, and
  scheduler edge/lifecycle checks passed on both engines for the tested
  contract. DST and clock-step behavior remain unverified.
- **Context:** Operators already use `CRON_MIN` to schedule feed refreshes. The
  user chose to preserve this path in the application container.
- **Decision:** Preserve `CRON_MIN` as the operator interface for the optional
  in-container feed refresh. An empty value disables the scheduler; external
  scheduling remains available.
- **Consequences:** Reject unsupported or malformed minute expressions before
  service startup, and keep scheduled work under the application identity.
  Scheduler-specific behaviour is recorded separately
  below.

### DD-008: Use Debian-packaged snooze for scheduled refresh

- **Date:** 2026-10-21
- **Status:** Accepted; implementation, full capability parity, and targeted
  scheduler validation passed on both engines for the tested contract. DST and
  clock-step behavior remain unverified.
- **Context:** The initial rootless implementation used checksum-pinned
  Supercronic `v0.2.43`, which passed capability and lifecycle checks on both
  engines. The user requested a scheduler available from Debian's package
  manager.
- **Decision:** Supersede the Supercronic binary with Debian's `snooze` package
  installed through Apt. Translate the existing single `CRON_MIN` minute
  field into a sorted, deduplicated list, then run snooze and the FreshRSS
  refresh command serially as `33:33`.
- **Consequences:** Reject unsupported minute expressions before service
  startup. Log job output and status, continue after refresh failures, skip
  schedules missed while a refresh is active, and supervise shutdown with
  Apache. Timing, timezone inheritance, failures, and shutdown have been
  validated; DST and clock changes remain untested.
- **Implementation:** `Dockerfile-Rootless`, `entrypoint-rootless.sh`,
  `rootless-cron.sh`, and `rootless-run.sh`.
- **Historical evidence:** Reports named `rootless-supercronic-*` describe the
  superseded scheduler. They are preserved, but do not validate snooze.
- **Current evidence:** The v13 capability suite, including a real scheduled
  refresh, and the targeted scheduler edge suite passed on both engines using image digest
  `sha256:90288c8f56be65e008d668038261246abeb562912a8112f5944c4d08a6afd28f`.
  See `ROOTLESS-IMAGE-PLAN.md` and
  `tests/docker/reports/rootless-scheduler-edges-v1.md`. DST transitions and
  simulated clock steps remain unverified.

### DD-009: Limit the initial platform target for the new image

- **Date:** 2026-10-21
- **Status:** Accepted
- **Context:** The new base supports more platforms than the initial validation
  environment can cover.
- **Decision:** Initially target `linux/amd64` and `linux/arm64` for the new
  image. Existing image variants retain their existing platform matrix.
- **Consequences:** Run native arm64 validation before claiming release
  readiness for that platform. Do not infer new-image platform support from the
  base image's manifest alone.

### DD-010: Preserve operator setup paths

- **Date:** 2026-10-21
- **Status:** Accepted
- **Context:** Install, user creation, configuration mounts, CLI administration,
  databases, reverse proxies, WebSub, OIDC, and persistence are established
  operator workflows.
- **Decision:** Preserve these workflows while adapting startup and runtime
  storage for nonroot operation. Keep one-time setup variables
  (`FRESHRSS_INSTALL` and `FRESHRSS_USER`) available during initialization,
  then remove them before long-running services start.
- **Consequences:** Re-run capability and migration checks for changes that
  touch entrypoint setup or mounted storage. Never treat a passing scheduler
  check as proof of overall feature parity.
- **Implementation and acceptance:** `entrypoint.sh`,
  `entrypoint-rootless.sh`, `tests/docker/README.md`, and
  `ROOTLESS-IMAGE-PLAN.md`.

### DD-011: Use an explicit entrypoint image profile

- **Date:** 2026-10-21
- **Status:** Accepted; implementation present and capability-validated for
  standard/root and rootless profiles; focused process-identity/storage checks
  also passed for the rootless profile
- **Context:** The shared entrypoint inferred the rootless image from the
  presence of snooze, a specific runtime directory, and a scheduler script.
  Image identity and process identity are independent, and this inference
  coupled unrelated startup behaviour to incidental files.
- **Decision:** Select the image startup contract with
  `FRESHRSS_ENTRYPOINT_PROFILE` (`standard` or `rootless`), independently of
  whether the current process is root. The main entrypoint sources both profile
  helpers and invokes only the selected profile's runtime preparation. Keep
  FreshRSS preparation, optional install, optional user creation, and final
  command execution in the shared path.
- **Consequences:** Profile values must be validated early. Standard root and
  generic nonroot compatibility remains in the standard profile; rootless
  runtime setup is owned by `entrypoint-rootless.sh`. Standard-only cron and
  root permission handling stay in `entrypoint-standard.sh`; shared OIDC and
  FreshRSS initialization run once for either profile. Changes to shared
  setup require capability checks for both profiles.
- **Implementation:** `Dockerfile-Rootless`, `entrypoint.sh`,
  `entrypoint-common.sh`, `entrypoint-standard.sh`, and
  `entrypoint-rootless.sh`.

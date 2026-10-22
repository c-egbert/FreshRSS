Closes #8362

Changes proposed in this pull request:

- Add an opt-in Debian image that runs FreshRSS as the documented non-root
  `www-data` identity (`33:33`) under both conventional and rootless container
  engines.
- Follow the existing Debian image's Apache `mod_php`, OIDC, PHP package, and
  database-driver setup. Default the new image to internal port `8080` and
  preserve scheduled refresh through `CRON_MIN` using Debian's `snooze` package.
- Preserve the existing Debian and Alpine image variants and operator setup
  paths. Image hardening and general release certification are outside this
  change's scope.
- Document the image contract, storage ownership requirements, scheduler
  behavior, and design decisions.

Relevant design decisions (see [DESIGN-DECISIONS.md](DESIGN-DECISIONS.md) for
the full rationale):

- Ship this as an additional image; keep existing Debian and Alpine tags,
  defaults, and platform support unchanged.
- Treat nonroot application execution and operation under an actual rootless
  engine as separate requirements, and validate the same image under both.
- Keep Debian 13 as the base to preserve the existing Debian-packaged Apache
  OIDC module and OIDC configuration. Run startup, web, CLI, and scheduled work
  as fixed `www-data` UID/GID `33:33`; operators prepare persistent-volume
  ownership.
- Default the new image to port `8080` and preserve `CRON_MIN` with Debian's
  packaged `snooze`, running scheduled refreshes serially as `33:33`.
- Keep shared FreshRSS setup in the main entrypoint and select standard or
  rootless runtime preparation with an explicit image profile, preserving
  existing install, user-creation, and configuration-mount workflows.

How to test the feature manually:

1. Build the image from the repository root:

   ```sh
   docker build -f Docker/Dockerfile-Rootless -t freshrss:rootless .
   ```

2. Create a data volume and prepare it for the image's default identity:

   ```sh
   docker volume create freshrss_rootless_data
   docker run --rm --user 0:0 --entrypoint /usr/bin/chown \
     --mount type=volume,source=freshrss_rootless_data,target=/data \
     freshrss:rootless 33:33 /data
   ```

3. Run the image against the selected conventional or rootless Docker engine:

   ```sh
   docker run -d --name freshrss_rootless \
     --mount type=volume,source=freshrss_rootless_data,target=/var/www/FreshRSS/data \
     -p 8080:8080 -e TZ=Europe/Paris -e CRON_MIN=13,43 \
     freshrss:rootless
   ```

4. Open `http://localhost:8080`, complete setup, sign in, and verify feed
   refresh. For OIDC, configure the local provider settings used by the test
   fixture. Confirm the container and its Apache/PHP/scheduler processes run as
   UID/GID `33:33`.

Automated and manual test coverage:

- **Functional parity:** 24 capability checks passed for the standard-image
  control and the rootless image. The rootless image passed under both
  conventional and actual rootless Docker engines using the same image digest;
  baseline comparisons passed. Checks covered:
  - Installer availability, interactive and CLI installation, user creation,
    repeatable setup, custom `DATA_PATH`, and read-only custom configuration
    mounts including precedence and persistence.
  - PHP runtime modules/defaults, database drivers, timezone, upload limits,
    and disabled in-app updates.
  - Form login, session cookies, CSRF rejection, logout, Google Reader and Fever
    API authentication, forwarded API headers and `PATH_INFO`, invalid
    credentials, and user isolation.
  - RSS/Atom parsing, gzip redirects, Unicode entries, CLI refresh, entry state,
    OPML and ZIP import/export, and data persistence after container recreation.
  - SQLite, PostgreSQL, MySQL, and MariaDB installation and operations,
    including feed refresh and persistence after web-container recreation.
  - Reverse-proxy setup under `/freshrss/`, forwarded host/scheme/port/prefix,
    and canonical and sub-path URLs.
  - WebSub subscription, verification challenge, pushed content, and entry
    visibility.
  - OIDC authorization-code login and user mapping, provider logout, session
    expiry, invalid state/nonce/signature rejection, and public asset/WebSub
    callback access while authentication is enabled.
  - Private-host allowlisting, denial of private paths and PHP source, static
    asset MIME types, API security headers, access-log redaction, and Apache
    listener, trusted-proxy, and access-log settings.
  - Scheduled feed refresh that imports an entry visible through the API.
- **Identity and storage:** PID 1, Apache, scheduler services, PHP CLI, and
  scheduled refresh ran as `33:33`. Prepared named volumes and bind mounts
  allowed writes and retained data after container recreation under both
  engines.
- **Scheduler edges:** Minute lists, ranges, steps, wildcard and leading-zero
  inputs translated correctly; malformed/out-of-range schedules were rejected.
  Disabled scheduling, selected-minute execution, duplicate prevention, serial
  jobs, missed ticks, refresh failure recovery, timezone inheritance, scheduler
  failure, and shutdown during waits/active jobs were checked on both engines.
- **Extension Manager (manual smoke test):** With a prepared writable
  extensions mount, installed and enabled ReadingTime; reading estimates
  appeared, disappeared when disabled, and returned when re-enabled.

Known test gaps: Native arm64 execution, DST/system-clock changes, ownership
migration of existing operator data, and the scheduler's restart-specific
lateness-window duplicate case were not tested. A restart within `snooze`'s
60-second lateness window may trigger an immediate repeat because the last-run
guard is not persisted.

Pull request checklist:

- [ ] clear commit messages
- [x] code manually tested
- [ ] unit tests written (optional if too hard; Docker capability and scheduler
  integration checks were added, but no unit tests were added)
- [x] documentation updated

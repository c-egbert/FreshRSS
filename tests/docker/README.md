# Container capability tests

This suite establishes a functional baseline for the existing FreshRSS container and compares later deployments against it. It uses Node.js 20 or later, the Docker CLI, and a Linux Docker engine; no npm packages or public feed services are required.

Each run creates an isolated network, two containers, and fresh data/extension volumes with unique names. HTTP ports bind to `127.0.0.1` on randomly allocated ports. The test data and resources are removed after success or an ordinary test failure. Run only against disposable deployments; custom adapters must provide equivalent isolation and cleanup.

## Run against the POC or a published image

Run from the repository root:

```sh
node tests/docker/capabilities.mjs --image freshrss/freshrss:poc --report tests/docker/reports/poc.json
```

To test the current public Debian image, pull it explicitly first:

```sh
docker pull freshrss/freshrss:latest
node tests/docker/capabilities.mjs --image freshrss/freshrss:latest --report tests/docker/reports/latest.json
```

For an Alpine-based image, select its web-server user:

```sh
node tests/docker/capabilities.mjs --image freshrss/freshrss:edge-alpine --cli-user apache --report tests/docker/reports/alpine.json
```

The default adapter supports the existing port-80 images and detects the rootless contract from `USER 33:33` plus `FRESHRSS_RUNTIME_DIR=/run/freshrss`. For that image it defaults to port 8080, explicitly prepares data-volume ownership, and preserves the default application identity for CLI operations. This preparation isolates broad capability checks from volume-driver copy-up behavior; it does not test the fresh-volume ownership contract. The adapter also runs its fixture with a read-only root filesystem, dropped capabilities, `no-new-privileges`, and a private runtime tmpfs; these are extra test-launch constraints, not requirements of the rootless definitions. PHP CLI and FreshRSS remain at `/var/www/FreshRSS`. Use `--fixture-image IMAGE` to keep the fixture image fixed; immutable image IDs/digests are recorded in reports.

The capability adapter prepares storage so functional parity checks remain
independent of volume-driver copy-up behavior. Use the focused rootless contract
test below to verify fresh named-volume permissions and first-run behavior
without that helper.

## Covered capabilities

The tests check observable application behaviour against the existing images and the rootless image:

- Installation page, CLI installation, user creation, and already-installed/already-created exit codes.
- CLI PHP extension inventory, SQLite/MySQL/PostgreSQL PDO driver availability, timezone, upload limits, and disabled application updater.
- Google Reader login, `Authorization` forwarding, API `PATH_INFO`, rejected invalid API credentials, and OIDC-mode checks that client-supplied identity headers cannot bypass web or API authentication.
- Explicit private-host allowlisting, while an unapproved alias of the same fixture service remains blocked.
- HTTP form login using FreshRSS's nonce/bcrypt protocol, session cookies, CSRF rejection, and logout.
- RSS and Atom parsing, gzip responses behind an HTTP redirect, Unicode titles, and OPML import through the HTTP API.
- A changed feed discovered by a separate CLI process and observed through the HTTP API.
- Read and starred state, Fever API reads, and isolation between two users.
- OPML export over CLI/HTTP with all feed URLs checked, plus a ZIP export/import round trip into another user with feed URLs and entry titles checked.
- Denial of private paths and PHP source, static SVG MIME type, and API security headers.
- Password/token query-value redaction in actual access logs, with a sentinel proving the request was logged.
- Container recreation using existing volumes, retaining credentials, feed subscriptions, entries, IDs, and read/star state.
- OpenID Connect authorization-code login against a deterministic local provider, including state/nonce round-trip, acceptance of a signed ID token, `preferred_username` mapping to an existing user, access to a protected FreshRSS page in `http_auth` mode, and an unauthenticated navigation redirect.
- OIDC relying-party logout through the configured callback, redirect to the provider's discovered end-session endpoint, return to an unprotected URL, local session invalidation, and a fresh authorization redirect on the next protected request.
- OIDC inactivity expiry using the module's ten-second minimum timeout: the authenticated page works before the idle window, then redirects to provider authorization after at least eleven seconds on the server clock without protected requests. Unauthenticated static-asset clock probes do not renew the session.
- OIDC rejection of a tampered callback state, a mismatched ID-token nonce, and an invalid ID-token signature; each case must leave the protected page unauthenticated.
- Live PostgreSQL 18, MySQL 8.4, and MariaDB 11.4 services, each with FreshRSS install, API login, feed subscription and entry writes, explicit feed refresh, and data reads after web-container recreation. MariaDB uses FreshRSS's `mysql` PDO/database type, as documented by the project.
- Reverse-proxy installation through a prefix-stripping `/freshrss/` proxy that supplies forwarded host, HTTPS scheme, port, and prefix; asserts saved canonical base URL and generated sub-path URLs.
- WebSub subscription registration with the local hub, challenge echo during subscription verification, XML content push through the public callback, acknowledgement, and visibility of the pushed entry through the API.
- Interactive web installation through SQLite, including administrator creation and completion of FreshRSS migrations.
- Entrypoint-driven `FRESHRSS_INSTALL` and `FRESHRSS_USER` setup using a non-default mounted `DATA_PATH`, API authentication, and persistence across recreation.
- Read-only `config.custom.php` and `config-user.custom.php` mounts applied during auto-install and user creation, including precedence, regional timezone, development logging, syslog flags, and persistence across container recreation.
- Apache `LISTEN` on a non-default internal port, `TRUSTED_PROXY` selection of the forwarded client address, and `ENABLE_ACCESS_LOG=0` disabling request logs.
- A real `CRON_MIN` scheduled refresh: the test adds a feed, advances its deterministic fixture, and confirms the cron job imports the new entry. The test sets the disposable user's feed TTL to zero so the scheduled run is observable immediately.
- OIDC-mode access rules for public static assets and WebSub callback reachability, including malformed-key validation and the unauthenticated unknown-unsubscribe challenge response.

The fixture has two feed revisions and a local OIDC provider, served by [router.php](fixtures/router.php). FreshRSS permits only `fixtures:8080` through `INTERNAL_HOST_ALLOWLIST`. The runner reduces the fixture deployment's feed-cache minimum so revision changes can be tested immediately; it does not relax internal-host blocking or authentication. Passwords are generated per run and are not saved in reports. Form-login tests reproduce the HTTP login protocol using the repository's existing bcrypt implementation; they do not exercise a real browser or its JavaScript rendering.

The OIDC check switches the disposable installation to FreshRSS `http_auth` mode before enabling Apache `mod_auth_openidc`; FreshRSS only consumes Apache's `REMOTE_USER` identity in that mode. It uses Node's raw HTTP client for top-level navigation requests so the `Sec-Fetch-Mode: navigate` header is sent as a browser would send it. The local fixture exercises authorization-code login, provider logout, inactivity expiry, and state, nonce, and signature rejection, but does not replace testing with a production identity provider or a real browser.

The database and proxy checks use disposable services and a test-only Node reverse proxy. WebSub maps the callback advertised by the fixture namespace to the loopback-published FreshRSS container while preserving its callback path and key; this keeps all requests local while testing the real FreshRSS callback handler and hub registration.

## Coverage boundaries

This is a functional capability subset, not the complete release matrix. It verifies the listed database versions and common operations, but does not yet cover database failover, TLS database connections, or every supported server version. The proxy test confirms installer-derived canonical URL handling and sub-path URLs; it does not exercise a deployed reverse proxy's TLS termination or every authenticated route. WebSub verifies registration, challenge response, and pushed content with a deterministic local hub, not public DNS, a third-party hub, retries, or lease renewal. OIDC logout and inactivity expiry now use the deterministic local provider; provider-specific interoperability and real-browser behavior remain untested. Custom configuration precedence/mounts are covered. The rootless adapter runs the suite with a read-only root filesystem, all capabilities dropped, and no-new-privileges. Third-party extension behaviour and broader failure/recovery cases remain release work.

## Compare a candidate to the baseline

Keep the baseline report and write the candidate to a different file:

```sh
node tests/docker/capabilities.mjs --image freshrss/freshrss:candidate --baseline tests/docker/reports/poc.json --report tests/docker/reports/candidate.json
```

The runner exits nonzero on failed tests, failed cleanup, invalid/incomplete baselines, or any baseline capability that did not pass for the candidate. Dependent tests are explicitly skipped when a prerequisite fails; skipped tests do not count as preserved capabilities. Reports contain named results, durations, tested image identity/platform, and the CLI module/configuration inventory. They omit Docker context names and full baseline paths; failure diagnostics redact common host paths. The suite version must match the baseline; regenerate the baseline deliberately when changing the test contract.

## Test the rootless image

[Dockerfile-Rootless](../../Docker/Dockerfile-Rootless) builds the additional Debian-based image with Apache, PHP CLI, OIDC, and the `CRON_MIN` scheduler. Build it from the repository root, then run the same broad functional suite used for the existing variants:

```sh
docker build -f Docker/Dockerfile-Rootless -t freshrss:rootless-test .
node tests/docker/capabilities.mjs --image freshrss:rootless-test --report tests/docker/reports/rootless-capabilities-rootful.json
```

Run the image against both a conventional Docker daemon and an actual rootless Docker daemon. The `--engine` option verifies the selected daemon using Docker's reported security options; it fails if the requested engine type does not match. Docker daemons have separate image stores, so load/copy the built image into the second daemon. The JSON report records its immutable image ID; pass that ID as `--expected-image-id` on the second engine to ensure both runs use the exact same build. For example, on Linux:

```sh
node tests/docker/rootless-contract.mjs --image freshrss:rootless-test --engine rootful --report tests/docker/reports/rootless-contract-rootful.json
docker save freshrss:rootless-test -o /tmp/freshrss-rootless-test.tar
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DOCKER_HOST="unix://${XDG_RUNTIME_DIR}/docker.sock"
docker load -i /tmp/freshrss-rootless-test.tar
node tests/docker/capabilities.mjs --image freshrss:rootless-test --report tests/docker/reports/rootless-capabilities-rootless.json
node tests/docker/rootless-contract.mjs --image freshrss:rootless-test --engine rootless \
  --expected-image-id sha256:IMAGE_ID_FROM_ROOTFUL_REPORT \
  --report tests/docker/reports/rootless-contract-rootless.json
```

The focused contract test checks the image's fixed `33:33` default identity and port `8080`, verifies that a changed runtime UID/GID is rejected, confirms Apache, PHP CLI, and the in-container scheduler run as `33:33`, and checks the default listener and `LISTEN` override. It also starts with a **fresh named volume without running a chown helper**, checks its `33:33`/`0700` data-directory permissions, confirms the installer is reachable, and verifies data persists across container recreation. These checks intentionally run without read-only-root or capability-drop options because those are outside the rootless-definition acceptance criteria.

The focused runner uses Node's built-in `node:test` subtests, the shared Docker command helper, and a versioned JSON report with per-test status/duration and cleanup status.

To also check a host bind mount, prepare an empty disposable Linux directory with ownership that maps to container UID/GID `33:33` for the selected daemon, then pass it to the same test:

```sh
mkdir -p /tmp/freshrss-rootless-bind-test
chown 33:33 /tmp/freshrss-rootless-bind-test  # conventional/rootful Docker example
node tests/docker/rootless-contract.mjs --image freshrss:rootless-test --engine rootful \
  --bind-data /tmp/freshrss-rootless-bind-test
```

For a rootless daemon, prepare the host directory using the UID/GID mapping configured for that daemon; container `33:33` commonly maps to a subordinate host UID/GID. The test requires the path to be empty and does not change its ownership. It writes a sentinel, checks host-side visibility and persistence across container recreation, and removes only that sentinel during cleanup.

The broad capability adapter explicitly prepares its named volume, so use `rootless-contract.mjs` for the no-helper volume contract and rootless-specific identity checks. Older [Supercronic reports](reports/rootless-supercronic.md) describe a superseded scheduler; the current image uses Debian `snooze` through its translation/runner layer. The capability suite tests a real scheduled refresh, while the focused contract test confirms the scheduler process identity.

The assertions in [capabilities.mjs](capabilities.mjs) are separate from deployment control in [image-target.mjs](image-target.mjs). A local adapter module selected with `--adapter FILE.mjs` must export `createTarget(options)` returning:

| Member | Contract |
| --- | --- |
| `baseUrl` | Disposable HTTP deployment URL ending in `/`; remains stable after recreation |
| `feedUrl` | Internal fixture URL reachable by PHP, supporting `/rss.xml`, `/atom.xml`, and `/redirect-gzip` |
| `start()` | Start fresh, uninstalled services and fixtures, with only the required fixture host allowlisted |
| `cli(args, { input })` | Run PHP CLI arguments against the same application/data; return `{ code, stdout, stderr }` with Buffer output |
| `advanceFixture()` | Switch the RSS fixture from its initial entry to the two-entry revision |
| `recreate()` | Recreate application services with their existing data, keeping the public URL and fixture state |
| `logs()` | Return HTTP access logs as a string so redaction can be verified |
| `metadata()` | Return non-secret identities/digests and platforms for the tested service images |
| `cleanup()` | Remove only this run's resources, including after partial startup failures |

CLI commands must run as the intended application user and can write only to test data and temporary paths.

The fixture must also resolve inside the stack as `blocked-fixtures:8080`, serving the same `/rss.xml` feed without that alias being allowlisted. This makes the private-network rejection check independent of feed validity or server availability.

The same assertion file can run unchanged against a later deployment adapter:

```sh
node tests/docker/capabilities.mjs --adapter ./path/to/rootless-target.mjs --fixture-image freshrss/freshrss:poc --baseline tests/docker/reports/poc.json --report tests/docker/reports/rootless.json
```

The adapter extension point is provided; a future multi-service adapter can be added if the architecture changes after parity review. Do not point it at an existing personal or production installation.

## Rootless-definition status and coverage limits

The additional image's operator-facing setup and storage instructions are in the [Rootless image guide](../../Docker/README-Rootless.md). Historical base and scheduler assumption probes are documented in [parity/README.md](parity/README.md); they are not a substitute for running the current image tests above.

This is a capability baseline, not the complete application test matrix. Suite v13 exercises SQLite, PostgreSQL, MySQL, and MariaDB, plus custom configuration mounts, documented operator settings, local proxy/sub-path handling, WebSub delivery, and OIDC login/rejection/logout/inactivity expiry. Run it alongside the focused rootless contract test on both engine types. Neither suite covers every database version, DST/clock-step behavior, or native multi-architecture execution. HTTP Basic Auth, extension hooks, HTTPS/custom CAs, backup restoration, and schema upgrades/rollback are broader coverage items, not rootless-definition requirements.

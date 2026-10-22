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

The default adapter supports the existing port-80 images and detects the rootless contract from `USER 33:33` plus `FRESHRSS_RUNTIME_DIR=/run/freshrss`. For that image it defaults to port 8080, explicitly prepares new data-volume ownership, and preserves the default application identity for CLI operations. The adapter also runs the capability fixture with a read-only root filesystem, dropped capabilities, `no-new-privileges`, and a private runtime tmpfs; these are test-launch constraints, not image-hardening deliverables or acceptance requirements for the rootless work. PHP CLI and FreshRSS remain at `/var/www/FreshRSS`. Use `--fixture-image IMAGE` to keep the fixture image fixed; immutable image IDs/digests are recorded in reports.

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

The runner exits nonzero on failed tests, failed cleanup, invalid/incomplete baselines, or any baseline capability that did not pass for the candidate. Dependent tests are explicitly skipped when a prerequisite fails; skipped tests do not count as preserved capabilities. Reports contain named results, durations, image identity, and the CLI module/configuration inventory. The suite version must match the baseline; regenerate the baseline deliberately when changing the test contract.

## Use the same assertions with the rootless image

[Dockerfile-Rootless](../../Docker/Dockerfile-Rootless) installs Debian-packaged snooze on the default `debian:13-slim` base, with Apache `mod_php`, CLI, OIDC, and explicit `tzdata`. Build with `docker build -f Docker/Dockerfile-Rootless -t freshrss:rootless-snooze .`, then select it with `--image freshrss:rootless-snooze`. The image defaults to `33:33` and port 8080. The current v13 capability suite passed on both a conventional engine and the actual rootless WSL2 daemon using the same image digest; reports are [here](reports/entrypoint-refactor-rootless-rootful-v13-retest.json) and [here](reports/entrypoint-refactor-rootless-actual-rootless-v13.json). A scheduled refresh is covered. The older [Supercronic integration results](reports/rootless-supercronic.md) are historical and do not validate the current snooze scheduler.

The [scheduler contract](../../Docker/ROOTLESS-SCOPE.md#nonroot-runtime-and-scheduling-contract) defines minute-list translation, invalid-input rejection, serial execution, skipped schedules during long jobs, lateness allowance, failure recovery, environment/timezone inheritance, and bounded shutdown. The separate [identity/storage report](reports/rootless-identity-storage-v1.md) verifies process identities and prepared-volume ownership/persistence on both engines. Remaining focused work is the scheduler edge cases. The capability suite's `CRON_MIN='*'` test confirms a real scheduled feed refresh, but not all translation expressions, DST/clock changes, failure cases, or scheduler lifecycle behavior.

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

Step 1 scope, frozen reference measurements, selected Debian base, fixed application identity, scheduler assumption probes, and the dedicated rootful/rootless Linux environments are recorded in [ROOTLESS-SCOPE.md](../../Docker/ROOTLESS-SCOPE.md). Reproduction tools and their limits are documented in [step1/README.md](step1/README.md).

This is a capability baseline, not the complete application test matrix. Suite v13 exercises SQLite, PostgreSQL, MySQL, and MariaDB, plus custom configuration mounts, documented operator settings, local proxy/sub-path handling, WebSub delivery, and OIDC login/rejection/logout/inactivity expiry. The integrated image defaults to nonroot and passes this subset under both engine types. Scheduler translation, timing, failure, and shutdown checks also passed under both engines. See the [rootless-image plan](../../Docker/ROOTLESS-IMAGE-PLAN.md) for the two definition-specific acceptance criteria and current validation limits, including DST/clock-step and native multi-architecture execution. HTTP Basic Auth, extension hooks, HTTPS/custom CAs, backup restoration, and schema upgrades/rollback are broader coverage items, not image-hardening requirements for this work.

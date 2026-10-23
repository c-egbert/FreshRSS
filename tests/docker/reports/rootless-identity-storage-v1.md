# Rootless identity and storage verification

## Result

The rootless image was exercised with its declared `33:33` identity on both a conventional Docker daemon and a rootless Docker daemon. Both runs used the image default identity without a runtime user override. The tested image digest is retained below; machine-specific operating system, daemon account, and UID mapping details are omitted because they vary by installation.

Image: `freshrss:entrypoint-refactor-rootless`

Digest: `sha256:90288c8f56be65e008d668038261246abeb562912a8112f5944c4d08a6afd28f`

## Process identity

Both daemon types ran PID 1, Apache, the scheduler, and PHP CLI as container UID/GID `33:33`. A scheduled refresh process was also observed with that identity.

## Persistent storage

Fresh named volumes and fresh bind mounts were tested separately on each daemon type. FreshRSS startup and application-user writes succeeded, and data remained available after container recreation.

| Engine | Storage | Owner inside container | Write and recreation |
| --- | --- | --- | --- |
| Conventional Docker daemon | Named volume | `33:33` | Passed |
| Conventional Docker daemon | Bind mount | `33:33` | Passed |
| Rootless Docker daemon | Named volume | `33:33` | Passed |
| Rootless Docker daemon | Bind mount | `33:33` | Passed |

The tests used only newly created disposable storage. They do not test migration or ownership changes for existing operator data. Rootless host UID/GID mappings vary by daemon configuration and were intentionally not recorded.

## Coverage limits

These checks do not cover native execution on every supported architecture. They validate the default image identity and storage behavior on the two daemon types described above.

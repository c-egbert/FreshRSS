# Rootless image scheduler edge checks

- **Date:** 2026-10-21
- **Image:** `freshrss:entrypoint-refactor-rootless`
- **Digest:** `sha256:90288c8f56be65e008d668038261246abeb562912a8112f5944c4d08a6afd28f`
- **Engines:** conventional Docker Engine in WSL2 and actual rootless Docker Engine in WSL2
- **Identity:** image default `33:33`; scheduler and PHP fixture also observed as `33:33`
- **Result:** all exercised checks passed on both engines

## Checks and results

| Behavior | Result on each engine | Evidence |
|---|---|---|
| Minute-field translations: lists, steps, ranges, single stepped values, leading zeroes, and wildcard | Pass | `13,43` → `13,43`; `*/20` → `0,20,40`; `5-25/10` → `5,15,25`; `1,10-20/5` → `1,10,15,20`; `20/15` → `20,35,50`; `08,8-10` → `8,9,10`; `000` → `0`; `*` expands to `0..59` |
| Malformed/out-of-range inputs | Pass | Empty values in a nonempty expression, whitespace/newlines, empty list elements, minute 60, descending/out-of-range ranges, zero/oversized steps, multiple `/` fields, injected punctuation, and value `999` were rejected |
| Invalid schedule at container startup | Pass | Startup failed and logged `Invalid CRON_MIN schedule` |
| Empty `CRON_MIN` | Pass | Apache stayed running; no snooze or scheduler process was present |
| Selected-minute schedule, duplicate guard, and timezone inheritance | Pass | One scheduled fixture run occurred at the selected local minute; environment `TZ` and PHP timezone were both `Europe/Paris`; UID/GID was `33:33`; no duplicate run occurred |
| Long serial job, missed schedule, failure logging, and recovery | Pass | First job ran 75–80 seconds and exited 17. It did not overlap another run. A minute scheduled while it was running was skipped; the next run began at the following scheduled minute. The scheduler logged status 17 and remained running |
| Scheduler wait failure | Pass | Replacing snooze with a test executable that exited 42 caused the required scheduler service and container to exit nonzero |
| Shutdown during scheduler wait | Pass | Container stopped with exit code 0 |
| Shutdown during a scheduled refresh | Pass | Container stopped in 0 seconds with exit code 0; the fixture did not reach its completion record |

The serial-run records on the conventional daemon were:

```text
START|1|1792647066|31|06|33:33|Europe/Paris|Europe/Paris|0|0
END|1|1792647141|32|21|33:33|Europe/Paris|Europe/Paris|0|17
START|2|1792647186|33|06|33:33|Europe/Paris|Europe/Paris|0|0
```

The rootless daemon showed the same behavior, with its run occurring at local
minutes 37 and 39. These records show that the 38:00 schedule was skipped while
the first job was still active, and no overlapping invocation began.

## Limits

The probes covered actual timing in `Europe/Paris`, but did not simulate a DST
transition or a wall-clock step forward/backward. Native arm64 execution was
also not part of this scheduler run. The ignored local harness and fixture used
for the probes are under `tests/docker/.step1/`; this report records the
verified image digest and observed outcomes.

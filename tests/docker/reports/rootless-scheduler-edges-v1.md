# Rootless image scheduler edge checks

## Result

The rootless image scheduler checks passed on both a conventional Docker daemon and a rootless Docker daemon. The image default identity and scheduled PHP fixture process ran as `33:33`. The report records scheduler behavior without machine-specific timestamps, timezone names, daemon versions, account IDs, or host paths.

## Checks and results

| Behavior | Result on each engine |
|---|---|
| Minute-field translations: lists, steps, ranges, single stepped values, leading zeroes, and wildcard | Passed |
| Malformed and out-of-range schedule values | Rejected |
| Invalid schedule at container startup | Startup failed with an invalid-schedule error |
| Empty `CRON_MIN` | Apache remained available; no scheduler process started |
| Selected-minute schedule and duplicate guard | One scheduled fixture run occurred; no duplicate run was observed |
| Timezone inheritance | Scheduler and PHP used the configured container timezone |
| Long serial job, missed schedule, failure logging, and recovery | Jobs did not overlap; a missed tick was skipped; a later tick ran; scheduler remained available after a job failure |
| Scheduler wait failure | Container exited nonzero when the scheduler wait command failed |
| Shutdown during scheduler wait | Container stopped successfully |
| Shutdown during a scheduled refresh | Container stopped successfully without recording a completed fixture run |

The long-job check verified that a schedule arriving during an active job was skipped and did not start a concurrent job. The next eligible tick ran after the first job completed.

## Limits

These probes do not simulate daylight-saving transitions or a wall-clock step, and do not establish native execution on every supported architecture. They describe behavior, not the host configuration used for the original run.

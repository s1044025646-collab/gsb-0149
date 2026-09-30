# Directional Borehole Trajectory & Inter-Well Distance Backend

A fully local Windows-runnable backend for managing directional-drilling survey
data, reconstructing wellbore trajectories with the **minimum curvature method**,
and evaluating the **3-D segment-to-segment proximity between two wells**.

It deliberately provides **only**:

- A JSON HTTP **API** (loopback only, auto-selected free port)
- A **CLI**
- A **synthetic (fictional) survey generator** with seeded randomness
- Automated **tests**

It does **not** include a web UI, aquifer/hydrogeological inversion, or any
control of real drilling equipment.

## Scope and conventions

- Coordinates are in a **local plane frame** only; no map projection or earth
  curvature is applied. Frame: `north`, `east`, `tvd`.
- **Inclination** is measured **from vertical**: `0°` straight down,
  `90°` horizontal, `180°` straight up (valid range `[0,180]`).
- **Azimuth** is **clockwise from the declared north reference**, valid range
  `[0,360)` (`0` north, `90` east, `180` south, `270` west).
- **TVD is positive downward.**
- Lengths may be entered in metres (`m`) or feet (`ft`, international foot
  `0.3048 m`); all storage and computation use metres.
- Every well declares a **north reference** (`true`, `grid`, or `mag`). Wells
  with different references can never be directly compared
  (`NORTH_REF_MISMATCH`).
- Survey revisions always create a **new immutable trajectory version**; prior
  versions remain available and isolated.

### Minimum curvature

For a course of measured length `L` between unit tangents `uA`, `uB` with
dogleg angle `beta`:

```
delta = L * (uA + uB)/2 * f(beta),   f(beta) = tan(beta/2)/(beta/2)
```

`f` is evaluated with a stable Taylor series (`1 + beta^2/12 + beta^4/720`) for
small `beta`, so straight sections have a well-defined limit of exactly 1.
Dogleg severity is reported in degrees per 30 m. Near-opposite tangents (dogleg
at/near 180°) are rejected (`NEAR_OPPOSITE_TANGENT`), as are non-finite or
out-of-range angles and measured depths that are not strictly increasing
(`MD_NOT_STRICTLY_INCREASING`). Azimuth wrap across zero is handled by the
tangent dot product and short-arc interpolation, so `359° -> 1°` is a 2° turn,
never the 358° long arc.

### Inter-well distance — important caveats

- Proximity is the minimum **segment-to-segment** distance over every pair of
  reconstructed polyline segments, not a station-to-station comparison.
- The polyline **approximates** the continuous wellbore; the true minimum can be
  marginally smaller between stations. Each report exposes
  `approximationBoundMetres`, a conservative half-chord budget.
- A threshold **warning is geometric proximity only**. It is **not** proof of
  safety. With no error-ellipsoid/uncertainty model, this system provides **no
  probabilistic collision risk**.

## Requirements

- Node.js **>= 22.5** (developed and tested on Node 25).
  Uses the built-in `node:sqlite` — no native compilation required.
- npm.
- Windows PowerShell (commands below), though everything is standard Node and
  also runs on macOS/Linux.

All data, databases and temp files stay inside this project (`./data`).

## Install

```powershell
npm install
```

## Build

```powershell
npm run build
```

`npm run typecheck` type-checks sources **and** tests (tests run directly on
TypeScript via type stripping; no separate build is needed for them).

## Tests

```powershell
npm test
```

The suite (57+ tests) covers: vertical wells, constant-inclination straight
lines, build-up arcs, the 359°->1° zero crossing, long/short courses, crossing
and near-parallel wells, analytic displacement checks, distance symmetry,
translation/rotation invariance, measured-depth interpolation boundaries,
metre/foot equivalence, historical version isolation, parameter validation and
error codes, pagination, idempotent resubmission, transaction rollback,
repeatable migrations, CLI before/after state, and persistence across restart.

## Repeatable end-to-end demo

```powershell
npm run demo
```

This regenerates `data/demo.sqlite` from scratch with fixed, seeded inputs
(vertical well, foot-unit build arc, revised version, azimuth crossing zero,
crossing wells, thresholded parallel wells, and a position interpolation).

## Run the API server (start / stop)

```powershell
npm run build      # required once
npm run server:start
npm run server:stop
```

- Binds **only** to `127.0.0.1`; the OS assigns a free port automatically.
- The chosen `pid`/`port`/database path are written to `data/server.json`.
- Start/stop manage only the process recorded in that file.
- Override the database path with the `BOREHOLE_DB` environment variable.

Health check (use the printed port):

```powershell
$port = (Get-Content data/server.json | ConvertFrom-Json).port
Invoke-RestMethod "http://127.0.0.1:$port/health"
```

## CLI

The CLI runs against TypeScript sources directly and defaults to
`data/borehole.sqlite`.

```powershell
# create a well (north reference true|grid|mag, unit m|ft, wellhead tie-in)
npm run cli -- create-well --id W1 --name "Pilot" --north-ref grid --unit m `
  --head-north 0 --head-east 0

# import stations from JSON (array or {"stations":[...]}) or CSV (md,inc,azi[,clientId])
npm run cli -- import --well W1 --file stations.json --reason "initial survey"

# reconstruct trajectory, query a depth, find the max dogleg
npm run cli -- trajectory --well W1
npm run cli -- position --well W1 --md 125.5
npm run cli -- max-dogleg --well W1

# compare two wells with a proximity threshold (warning only, not safety proof)
npm run cli -- compare --well-a W1 --well-b W2 --threshold 10 --threshold-unit m

# export per-course increments to CSV
npm run cli -- export-increments --well W1 --out data/courses.csv

npm run cli -- list-wells
```

Idempotent imports repeat safely with the same key:

```powershell
npm run cli -- import --well W1 --file stations.json --idempotency-key run-001
```

Key mutating commands print state before and after the operation (existence,
latest version, station count, measured-depth range).

## HTTP API summary

All responses are JSON. Errors have the shape
`{"error":{"code","message","details"}}`. List endpoints accept
`?limit=<1..500>&offset=<n>` and return
`{"data":[...], "pagination":{"total","limit","offset","hasMore"}}`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness |
| POST | `/wells` | Create a well |
| GET | `/wells` | List wells (paged) |
| GET | `/wells/{id}` | Fetch a well |
| GET | `/wells/{id}/versions` | List trajectory versions (paged) |
| POST | `/wells/{id}/versions` | Add a revised survey -> new version (idempotency key supported) |
| GET | `/wells/{id}/versions/{v}/stations` | Stations of a version (paged) |
| GET | `/wells/{id}/versions/{v}/courses` | Per-course increments (paged) |
| GET | `/wells/{id}/trajectory?version=` | Reconstructed relative + world points |
| GET | `/wells/{id}/position?md=&version=` | Interpolated position at a measured depth |
| GET | `/wells/{id}/max-dogleg?version=` | Steepest course and DLS |
| POST | `/comparisons` | Compare two wells (`wellA`,`wellB`, optional versions/threshold) |
| GET | `/reports` | Persisted proximity reports (paged) |

Main error codes: `VALIDATION`, `BAD_REQUEST`, `NOT_FOUND`, `CONFLICT`,
`MD_NOT_STRICTLY_INCREASING`, `INVALID_ANGLE`, `NEAR_OPPOSITE_TANGENT`,
`NORTH_REF_MISMATCH`, `OUT_OF_RANGE`.

Example create + import:

```powershell
$port = (Get-Content data/server.json | ConvertFrom-Json).port
$base = "http://127.0.0.1:$port"
Invoke-RestMethod "$base/wells" -Method Post -ContentType "application/json" `
  -Body '{"id":"W1","name":"Pilot","northRef":"grid","lengthUnit":"m","headNorth":0,"headEast":0}'
Invoke-RestMethod "$base/wells/W1/versions" -Method Post -ContentType "application/json" `
  -Body '{"reason":"initial","stations":[{"md":0,"inc":0,"azi":0},{"md":50,"inc":15,"azi":90}]}'
```

## Cleanup

```powershell
npm run clean
```

Removes only project-generated artifacts (`dist/` and project-local databases in
`data/`). Source, tests and `node_modules` are left untouched.

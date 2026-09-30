# Directional-Drilling Trajectory & Inter-Well Distance Backend

A Windows-runnable, **local-only** backend for evaluating directional borehole
trajectories and the shortest distance between wells. Built with TypeScript,
Node.js (built-in test runner + native type stripping) and the built-in
`node:sqlite` database — **no native compilation or third-party runtime deps**.

It provides an HTTP API, a CLI, a fictional survey-data generator and automated
tests. It does **not** provide a web UI, aquifer inversion, or any control of
real drilling equipment.

## Scope and non-goals

- Calculations are limited to a **local plane coordinate system** (north/east/TVD).
- No geographic projection, curvature-of-earth, aquifer inversion, or control logic.
- Survey data produced by the generator is **entirely synthetic/fictional**.
- **No error-ellipsoid / positional-uncertainty model**: the system therefore
  reports geometric screening distances only and gives **no probabilistic
  collision risk**. A distance-threshold warning is **not proof of safe clearance**.

## Coordinate & angle conventions

- **Inclination** is measured from vertical: `0°` = straight down, `90°` = horizontal.
- **Azimuth** is measured clockwise in the horizontal plane from the declared
  north reference (`0°` north, `90°` east). Azimuth wrap across `0°` (e.g.
  `359° -> 1°`) is integrated along the **short 2° arc**, never 358°.
- **Measured depth (MD)** strictly increases along the hole.
- Coordinates are north `N`, east `E`, true vertical depth `TVD` with **TVD
  positive downward**. All internal lengths are metres; feet are converted on input.
- The north reference is a property of a well (`TRUE_NORTH`, `MAGNETIC_NORTH`,
  `GRID_NORTH`). Wells with different references **cannot be compared**.

## Minimum-curvature method

For each survey interval with tangents `a`, `b` and drilled length `ΔMD`:

- dog-leg angle `β = atan2(|a × b|, a · b)` (stable, always the minor angle);
- ratio factor `f = 2·tan(β/2)/β`, with the **straight-section limit `f → 1`**
  applied for very small `β`;
- displacements `ΔN = ΔMD/2·(aN + bN)·f`, likewise for `ΔE` and `ΔTVD`;
- dog-leg severity `DLS = β / ΔMD · 30` in degrees per 30 m.

MD that is not strictly increasing, non-finite/out-of-range inclination, and
near-opposite tangents (dog-leg `> 175°`) are explicitly rejected.

## Inter-well proximity

Distances are computed between the **line segments of the reconstructed
polylines** of two wells (not merely between survey stations), so a crossing
mid-segment is detected. The rebuilt path is a piecewise-linear approximation of
the true smooth well path and carries a **chord-approximation error** that shrinks
as station density increases; this limitation is attached to every report.

## Requirements

- Node.js **>= 22.5** (developed/tested on Node 25; uses `--experimental-strip-types`
  and the built-in `node:sqlite`). No network access is required at runtime.

Install dev tooling (only TypeScript types/compiler):

```powershell
npm install
```

## Tests

```powershell
npm test          # node:test suite (geometry, proximity, repo, API, generator)
npm run typecheck # tsc --noEmit
```

Fixtures cover vertical wells, constant-inclination straight lines, build arcs,
the `359° -> 1°` zero crossing, short/long intervals, crossing and near-parallel
wells. Assertions include analytic displacement checks, distance symmetry and
translation/rotation invariance, MD-interpolation boundaries, metre/foot
equivalence, history/version isolation, idempotent re-submission, transaction
rollback on invalid geometry, and persistence across reopening the database.

## Repeatable end-to-end demo

```powershell
npm run demo
```

Uses a throwaway DB under `tmp/demo/`, generates two crossing wells and a build
arc, locates the max dog-leg, compares wells, exports per-segment increments,
revises a version (showing isolation), exercises the north-reference guard, and
reopens the DB to prove persistence.

## Start / stop (local only)

```powershell
powershell -File scripts/start.ps1   # binds 127.0.0.1, auto free port; prints URL
powershell -File scripts/stop.ps1    # stops only the pid recorded for this project
```

The chosen port is written to `tmp/server.port`, the pid to `tmp/server.pid`,
the database to `data/app.sqlite`. The listener is bound to the loopback
interface only. To run in the foreground instead:

```powershell
npm start
```

## CLI

`node --experimental-strip-types src/cli.ts <command>` (or `npm run cli -- ...`).
Set `DRILL_DB` to override the default `data/app.sqlite`. Mutating commands print
state before/after.

```powershell
node --experimental-strip-types src/cli.ts init
node --experimental-strip-types src/cli.ts add-well --name W1 --northRef TRUE_NORTH [--unit ft] [--n0 0 --e0 0 --tvd0 0]
node --experimental-strip-types src/cli.ts list-wells [--limit N --offset M]
node --experimental-strip-types src/cli.ts import --well 1 --file stations.json [--key k] [--note n]
node --experimental-strip-types src/cli.ts gen --well 1 --stations 21 --spacing 30 --inc 0 --build 3 --azi 0 --seed 7 [--out f.json] [--key k]
node --experimental-strip-types src/cli.ts trajectory 1
node --experimental-strip-types src/cli.ts position --version 1 --md 150 [--unit ft]
node --experimental-strip-types src/cli.ts max-dogleg 1
node --experimental-strip-types src/cli.ts compare --a 1 --b 2 --threshold 10 [--key k]
node --experimental-strip-types src/cli.ts export-increments 1 tmp/segs.json
```

`stations.json` is either `[ {md, inc, azi}, ... ]` or `{ "stations": [...] }`.

## HTTP API

JSON in/out. Validation failures return `{ "error": { "code", "message" } }`
with an appropriate HTTP status (400/404/409/422). List endpoints are paginated.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | liveness |
| POST | `/wells` | create well `{name,northRef,unit?,n0?,e0?,tvd0?}` |
| GET | `/wells?limit=&offset=` | paginated wells |
| GET | `/wells/{id}` | one well |
| GET/POST | `/wells/{id}/versions` | list / add trajectory version |
| GET | `/versions/{id}/segments` | per-segment minimum-curvature increments |
| GET | `/versions/{id}/position?md=&unit=` | interpolated position at MD |
| GET | `/versions/{id}/max-dogleg` | interval with highest DLS |
| POST | `/compare` | `{wellAId,wellBId,threshold,idempotencyKey?}` |
| GET | `/reports?limit=&offset=` | paginated stored distance reports |

Repeated POSTs carrying the same `idempotencyKey` return the original version or
report instead of creating a duplicate.

## Revisions & versions

Importing or revising stations always creates a **new immutable trajectory
version** for that well; older versions remain queryable and are used verbatim
by stored reports, giving history isolation.

## Data & cleanup

All databases, logs, pid/port files and temporary output stay inside this
project (`data/`, `tmp/`). Migrations are idempotent and safe to re-run. To fully
reset: stop the server (`scripts/stop.ps1`) and delete `data/` and `tmp/`.

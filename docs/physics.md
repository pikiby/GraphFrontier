# Physics Model

This page explains GraphFrontier movement in simple terms.

## Core Idea

Free nodes can be affected by these force families:

- Link force: connected nodes pull/push toward target link distance
- Repel force: nodes push away from each other
- Center force: free nodes are pulled toward the graph origin
- Gravity-node force: query-matched free nodes are attracted to configured centers

Then velocity is damped and position is updated each frame.

## Main Controls And Meaning

- `Link strength`: stronger spring between linked nodes
- `Link distance`: preferred distance of all linked nodes
- `Repel strength`: stronger anti-overlap spreading
- `Repel radius`: distance cutoff for repel interactions
- `Center strength`: stronger pull toward center
- `Damping`: stronger velocity decay per frame
- `Strong pull x`: per-node multiplier used by strong pull action

## Repel Radius Logic

Repel is distance-limited:

- if two nodes are farther than `Repel radius`, repel between them is skipped
- this keeps movement smooth on large graphs and avoids over-computation on distant pairs

Derived radii:

- orphan-related repel uses a slightly wider radius (`Repel radius * 1.25`)

## Stabilization Logic

There is no fixed three-second stop or additional timed velocity brake.
Ordinary Damping remains active while nodes move toward equilibrium.

- A node sleeps after eight consecutive frames with speed and net acceleration below 0.02.
- During active simulation, a sleeping node wakes at speed or acceleration of 0.04 or higher.
- The higher wake threshold suppresses small oscillations near equilibrium.
- Physics pauses once all movable nodes are asleep and no nodes are being dragged.
- Layout-changing actions clear sleep state and restart simulation.
- Competing forces can still prevent convergence; a fixed settling time is not guaranteed.

Autosave stabilization:

- when autosave is enabled, layout is saved after movement stays still for several frames

## Pinned Modes

- `Pin`: node keeps exact coordinates
- `Pin to grid`: node snaps to nearest free grid cell when pinned/drag released
- `Orbit pin`: node is constrained around anchor node at a fixed radius/angle

Pinning constrains movement, not influence. Exact/grid/orbit-pinned nodes still
repel eligible free neighbors and exert link forces, including Strong pull.
The pinned node itself does not move under those forces; orbit-pinned nodes
follow their anchor's position. Force calculations between two fixed nodes are
skipped because neither can move. This applies equally to notes and attachments.

## Orbit Geometry

Orbit radius is computed from desired spacing:

- `radius = max(minRadius, (count * orbitDistance) / (2π))`

Where:

- `count`: number of orbit nodes around the same anchor
- `orbitDistance`: slider value
- `minRadius`: typically not smaller than link distance

Explicit orbit pinning can also arrange attachments around an anchor.

## Node Classes In Simulation

Notes and attachments share the same simulation. Only topology distinguishes
connected nodes from orphans (`degree = 0`), including within a filtered graph.
A note linked only to attachments is an ordinary connected node. Attachments
participate equally in springs, repulsion, center pull and gravity-node forces.
The layout center includes all connected nodes, falling back to all nodes if none are connected.
There is no attachment isolation or automatic attachment orbit placement.

## Orphan Repel

Additional repel layers separate orphan/orphan and orphan/connected pairs.
These depend only on node degree, not file classification.

## Why Graph Can Still Move

Even with many controls low, movement may continue if:

- some forces are still non-zero
- links remain stretched
- center pull remains active
- nodes are being dragged or constraints are changing
- orphan interactions are still active

If needed, reduce link/center/repel and increase damping to calm down faster.

## Related Docs

- Settings: `settings.md`
- Usage: `usage.md`

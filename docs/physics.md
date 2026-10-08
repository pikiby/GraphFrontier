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
- `Link distance`: preferred distance of regular linked nodes
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
- attachment-only orphan-like interactions use base radius or orphan radius depending on pair type

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

Pinned/orbit nodes do not behave like fully free simulation nodes.

## Orbit Geometry

Orbit radius is computed from desired spacing:

- `radius = max(minRadius, (count * orbitDistance) / (2π))`

Where:

- `count`: number of orbit nodes around the same anchor
- `orbitDistance`: slider value
- `minRadius`: typically not smaller than link distance

Explicit orbit pinning can also arrange attachments around an anchor.

## Node Classes In Simulation

GraphFrontier now treats several node classes differently for stability:

- Main nodes: regular non-attachment nodes with regular links
- Orphans: nodes with `degree = 0`
- Attachments: non-Markdown files; isolation mode limits interaction to their main node and sibling attachments
- Attachment-only anchors: regular nodes linked only to attachments

Attachment-only anchors use orphan-like mechanics with reduced force.  
This prevents jitter while keeping them integrated with orphan/main repulsion behavior.

## Orphan And Attachment-Oriented Repel

Additional repel layers are applied on top of main repel:

- orphan <-> orphan
- orphan <-> main
- attachment-only <-> attachment-only
- orphan <-> attachment-only
- attachment-only <-> main

These layers help keep peripheral nodes separated from the core while preserving smooth motion.

## Why Graph Can Still Move

Even with many controls low, movement may continue if:

- some forces are still non-zero
- links remain stretched
- center pull remains active
- nodes are being dragged or constraints are changing
- orphan/attachment class interactions are still active

If needed, reduce link/center/repel and increase damping to calm down faster.

## Related Docs

- Settings: `settings.md`
- Usage: `usage.md`

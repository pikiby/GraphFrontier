# Physics Model

This page explains GraphFrontier movement in simple terms.

## Core Idea

Every free node is affected by three force families:

- Link force: connected nodes pull/push toward target link distance
- Repel force: nodes push away from each other
- Center force: free nodes are pulled toward current layout center

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

The solver has a short “search boost” window after major changes:

- after layout-changing action, movement boost decays over about 2 seconds
- this helps nodes move quickly first, then settle

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

Attachments can also be auto-distributed around anchors using similar logic.

## Node Classes In Simulation

GraphFrontier now treats several node classes differently for stability:

- Main nodes: regular non-attachment nodes with regular links
- Orphans: nodes with `degree = 0`
- Attachments: non-markdown files, usually auto-orbited around anchors
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

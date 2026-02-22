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
- `Center strength`: stronger pull toward center
- `Damping`: stronger velocity decay per frame
- `Strong pull x`: per-node multiplier used by strong pull action

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

## Why Graph Can Still Move

Even with many controls low, movement may continue if:

- some forces are still non-zero
- links remain stretched
- center pull remains active
- nodes are being dragged or constraints are changing

If needed, reduce link/center/repel and increase damping to calm down faster.

## Related Docs

- Settings: `settings.md`
- Usage: `usage.md`

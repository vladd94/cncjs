# Mobile CNCjs fork

This branch modernizes the workspace at widths up to 1100 px (including a
1024×600 Pi display): bottom navigation, View/Controls/Tools panes, a shorter
visualizer, larger touch controls, and a refreshed Autolevel landing flow. It
retains the existing desktop layout above that width. No additional runtime
dependencies are introduced.

Mobile/Pi shell performance notes (Chromium on Raspberry Pi):
- No Google Fonts, `backdrop-filter`, soft shadows, or multi-layer gradients.
- Machine/pane chrome is `position: fixed` (not sticky) with solid paints.
- Visualizer uses 1× pixel ratio, no MSAA/soft shadows, capped canvas height,
  and skips WebGL renders/resizes while the View pane is hidden.

Autolevel file pickers no longer filter by extensions, because mobile file
providers may disable unfamiliar `.nc`, `.gcode` and `.probe` files. Probe files
with a `.txt` suffix work too. Their contents must still be whitespace-separated
XYZ coordinates, with optional numeric auxiliary columns, in millimetres.
Invalid rows, nonfinite values and empty maps show an error. The server also
rejects duplicate XY locations and collinear maps.

## Applying a map

1. Keep the same fixture, work origin and tool-length reference used for probing.
2. In Autolevel, load the probe map or finish a new probe run.
3. Use **Load G-code file in Autolevel** to apply compensation. An ordinary
   workspace upload does not automatically apply the map.
4. Wait for **Compensation applied — corrected G-code loaded in workspace**.
   The corrected filename starts with `AL_`. Loading another workspace file or
   unloading G-code clears this success state.
5. Export the corrected file if needed. Compensated output starts with
   `; cncjs-autolevel-applied` and filenames use an `AL_` prefix; the UI and
   server both refuse to apply compensation a second time.

## Supported toolpaths

This first version supports absolute G0/G1 XYZ moves in G54 with a single units
mode. Specify G90, G54 and G20/G21 in the program header. Probe data is in mm;
G20 output is converted by the existing compensation engine. Establish all XYZ
coordinates with a safe G0 approach before the first cutting move. Initial
partial-axis rapid moves are preserved without inventing missing coordinates.
Machine-coordinate G53 parking/retracts are preserved and invalidate the tracked
work position until explicitly established again.

IJK arcs (G2/G3) in G17/G18/G19 are linearized into compensated G1 segments.
R-word arcs, incremental positioning (G91), G28, coordinate resets and other
unsupported G modes return an error instead of silently creating a misleading
compensated file. A failed compensation does not replace the current job.
Compensation also works without an open serial port via `/api/autolevel/apply`.

A negative-Y work area is valid: for example Start Y = -100, End Y = 0. These
fields describe minimum/maximum coordinates, not selectable probe travel
orientation. This change does not reverse the machine axes or homing settings.

## Verification and remaining checks

Automated tests cover interpolation, invalid surfaces, negative coordinates,
startup retracts, unsupported modes, non-motion word preservation, file parsing,
and controller error callbacks. Compile the frontend with the repository's
production webpack configuration. No live controller or Pi is connected to the
development workspace.

Before using this branch for a cut:

- Verify phone portrait/landscape and 1024×600 layouts, panel toggles, scrolling,
  file selection and jog controls. Browser/device visual checks are still pending.
- Use a small known tilted plane, compare exported Z values against the expected
  surface height, then run above the work with the spindle off.
- Verify G54 alignment, units, probe clearance and probe input operation on the
  actual controller. Keep all cutting XY positions inside the measured area;
  out-of-map XY is clamped to the nearest probe-grid edge height (not
  extrapolated).
- Verify reconnect/reload behavior before resuming a job; the success banner is
  session-local and is not a persistent machine-level certificate of compensation.

The branch is not installed on the Raspberry Pi and does not change its service,
Node installation or GRBL settings. Use a separate test installation before
replacing the working service.

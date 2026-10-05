import {
  ensurePlainObject,
} from 'ensure-type';
import * as gcodeParser from 'gcode-parser';
import {
  IMPERIAL_UNITS,
  METRIC_UNITS,
} from '../controllers/constants';
import {
  mm2in,
  in2mm,
} from '../controllers/utils/units';
import logger from './logger';

const log = logger('autolevel');

/**
 * @typedef {object} Point3
 * @property {number} x - X coordinate
 * @property {number} y - Y coordinate
 * @property {number} z - Z coordinate
 */

/**
 * @typedef {object} ProbeGrid
 * @property {number[]} xs - Sorted unique X grid coordinates
 * @property {number[]} ys - Sorted unique Y grid coordinates
 * @property {number[][]} matrix - Heights; matrix[j][i] is the height at (xs[i], ys[j])
 */

// Default probe-grid spacing (mm) when the data isn't a usable rectangular grid.
const DEFAULT_GRID_STEP = 5;

// Written as the first line of compensated output; refuse to apply again if present.
export const AUTOLEVEL_APPLIED_MARKER = 'cncjs-autolevel-applied';

// Second header line. The value is the probe reading (mm) at the work origin,
// which is the height that was absorbed when work Z was zeroed.
export const AUTOLEVEL_REFERENCE_PREFIX = 'cncjs-autolevel-reference-z=';

// Max sagitta of a linearized arc, in mm. Linear moves still follow the probe
// grid; this only controls G2/G3 so small holes are not collapsed into chords.
export const ARC_CHORD_ERROR_MM = 0.02;

// One enormous arc (or a chord step that underflows to 0) must not allocate
// millions of points. Past this, chords get coarser instead of growing.
const MAX_ARC_STEPS = 4096;

// A single move chopped by a tiny detected gap. Hit this and throw; do not
// keep allocating until V8 abort()s.
const MAX_POINTS_PER_MOVE = 20000;

// Whole compensated program. The request handler can return this error;
// an unbounded join cannot.
const MAX_OUTPUT_LINES = 200000;

// Match buildProbeGrid / duplicate detection (1 µm).
const roundProbeXY = (v) => Math.round(v * 1000) / 1000;

// Vector subtraction: p1 - p2
const sub3 = (p1, p2) => ({
  x: p1.x - p2.x,
  y: p1.y - p2.y,
  z: p1.z - p2.z,
});

// 2D distance squared (ignores Z)
const distanceSquared2 = (p1, p2) => {
  return (p2.x - p1.x) * (p2.x - p1.x) + (p2.y - p1.y) * (p2.y - p1.y);
};

// 3D distance squared
const distanceSquared3 = (p1, p2) => {
  return (p2.x - p1.x) * (p2.x - p1.x) +
         (p2.y - p1.y) * (p2.y - p1.y) +
         (p2.z - p1.z) * (p2.z - p1.z);
};

// Cross product of two 3D vectors
const crossProduct3 = (u, v) => ({
  x: (u.y * v.z - u.z * v.y),
  y: -(u.x * v.z - u.z * v.x),
  z: (u.x * v.y - u.y * v.x),
});

// Check if two 2D vectors are colinear
const isColinear = (u, v) => {
  return Math.abs(u.x * v.y - u.y * v.x) < 0.00001;
};

/**
 * Subdivide a segment into smaller subsegments for Z compensation.
 *
 * Why subdivision is needed:
 * Without splitting, a long diagonal move from point A to B would only get
 * Z compensation at the endpoints. But the surface may vary along the path.
 *
 * Without splitting:          With splitting:
 * A ─────────────── B         A ── • ── • ── • ── B
 * (Z adjusted at A,B only)    (Z adjusted at each point)
 *
 * Example:
 * - Move from (0,0) to (50,50) with maxSegmentLength = 10mm
 * - Creates ~7 intermediate points along the path
 * - Each point gets Z compensation interpolated from the probe surface
 * - Results in a toolpath that follows the actual surface contour
 *
 * @param {Point3} p1 - Start point
 * @param {Point3} p2 - End point
 * @param {number} maxSegmentLength - Maximum length between subdivided points
 * @returns {Point3[]} Points from p1 to p2, including both endpoints
 */
const subdivideSegment = (p1, p2, maxSegmentLength) => {
  const result = [];
  const v = sub3(p2, p1);
  const dist = Math.sqrt(distanceSquared3(p1, p2));

  if (dist < 1e-10) {
    return [];
  }

  // A zero or non-finite step makes `d += step` spin forever.
  if (!Number.isFinite(maxSegmentLength) || maxSegmentLength <= 0) {
    return [
      { x: p1.x, y: p1.y, z: p1.z },
      { x: p2.x, y: p2.y, z: p2.z },
    ];
  }

  // Direction vector
  const dir = {
    x: v.x / dist,
    y: v.y / dist,
    z: v.z / dist,
  };

  // First point
  result.push({ x: p1.x, y: p1.y, z: p1.z });

  // Intermediate points
  for (let d = maxSegmentLength; d < dist; d += maxSegmentLength) {
    if (result.length >= MAX_POINTS_PER_MOVE) {
      throw new Error('Probe spacing is too fine to compensate this move without running out of memory');
    }
    const pt = {
      x: p1.x + dir.x * d,
      y: p1.y + dir.y * d,
      z: p1.z + dir.z * d,
    };
    // Skip duplicate points
    if (result.length === 0 || distanceSquared3(pt, result[result.length - 1]) > 1e-10) {
      result.push(pt);
    }
  }

  // Last point
  if (result.length === 0 || distanceSquared3(p2, result[result.length - 1]) > 1e-10) {
    result.push({ x: p2.x, y: p2.y, z: p2.z });
  }

  return result;
};

const normalizeAngleDelta = (delta, clockwise) => {
  if (clockwise) {
    return delta > 0 ? delta - (2 * Math.PI) : delta;
  }
  return delta < 0 ? delta + (2 * Math.PI) : delta;
};

/**
 * Linearize a G2/G3 arc (IJK form) into XYZ points for Z compensation.
 * Plane axes follow GRBL: G17 XY, G18 ZX (axis0=Z, axis1=X), G19 YZ.
 * Positive sweep is G3. Step size comes from chord error, not probe spacing.
 */
const linearizeArc = (start, end, offsets, plane, clockwise, maxChordError) => {
  const i = Number.isFinite(offsets.i) ? offsets.i : 0;
  const j = Number.isFinite(offsets.j) ? offsets.j : 0;
  const k = Number.isFinite(offsets.k) ? offsets.k : 0;
  let axis0Start;
  let axis1Start;
  let axis0End;
  let axis1End;
  let center0;
  let center1;
  let linear0;
  let linear1;
  let toPoint;

  if (plane === 18) {
    // G18: axis0=Z, axis1=X, linear=Y. G3 sweeps from +Z toward +X.
    axis0Start = start.z;
    axis1Start = start.x;
    axis0End = end.z;
    axis1End = end.x;
    center0 = start.z + k;
    center1 = start.x + i;
    linear0 = start.y;
    linear1 = end.y;
    toPoint = (axis0, axis1, linear) => ({ x: axis1, y: linear, z: axis0 });
  } else if (plane === 19) {
    // G19: axis0=Y, axis1=Z, linear=X. G3 sweeps from +Y toward +Z.
    axis0Start = start.y;
    axis1Start = start.z;
    axis0End = end.y;
    axis1End = end.z;
    center0 = start.y + j;
    center1 = start.z + k;
    linear0 = start.x;
    linear1 = end.x;
    toPoint = (axis0, axis1, linear) => ({ x: linear, y: axis0, z: axis1 });
  } else {
    // G17: axis0=X, axis1=Y, linear=Z. G3 sweeps from +X toward +Y.
    axis0Start = start.x;
    axis1Start = start.y;
    axis0End = end.x;
    axis1End = end.y;
    center0 = start.x + i;
    center1 = start.y + j;
    linear0 = start.z;
    linear1 = end.z;
    toPoint = (axis0, axis1, linear) => ({ x: axis0, y: axis1, z: linear });
  }

  const radius0 = Math.hypot(axis0Start - center0, axis1Start - center1);
  const radius1 = Math.hypot(axis0End - center0, axis1End - center1);
  if (!(radius0 > 1e-9) || Math.abs(radius0 - radius1) > 0.05) {
    throw new Error('Invalid arc offsets for compensation');
  }

  const theta0 = Math.atan2(axis1Start - center1, axis0Start - center0);
  const theta1 = Math.atan2(axis1End - center1, axis0End - center0);
  const sameEndpoint = Math.hypot(axis0End - axis0Start, axis1End - axis1Start) < 1e-6;
  let delta;
  if (sameEndpoint) {
    // Identical plane endpoints with a real radius are a full turn, not a no-op.
    delta = clockwise ? -(2 * Math.PI) : (2 * Math.PI);
  } else {
    delta = normalizeAngleDelta(theta1 - theta0, clockwise);
    if (Math.abs(delta) < 1e-12) {
      return [];
    }
  }

  const chordError = Math.min(Math.max(maxChordError, 1e-6), radius0 * 0.5);
  const dTheta = 2 * Math.acos(Math.min(1, Math.max(-1, 1 - (chordError / radius0))));
  // dTheta is 0 when chord/radius underflows, and `abs(delta) / 1e-6` is then
  // millions of steps. Cap the count so a huge radius stays a normal array.
  let steps = Math.max(1, Math.ceil(Math.abs(delta) / Math.max(dTheta, 1e-9)));
  if (steps > MAX_ARC_STEPS) {
    steps = MAX_ARC_STEPS;
  }
  const points = [toPoint(axis0Start, axis1Start, linear0)];
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const theta = theta0 + (delta * t);
    const axis0 = center0 + (radius0 * Math.cos(theta));
    const axis1 = center1 + (radius0 * Math.sin(theta));
    const linear = linear0 + ((linear1 - linear0) * t);
    points.push(toPoint(axis0, axis1, linear));
  }
  // Snap endpoint exactly
  points[points.length - 1] = { x: end.x, y: end.y, z: end.z };
  return points;
};

/**
 * Find three closest non-collinear probed points to a given point.
 * Used as a fallback for non-grid data (see planeFitZ).
 * @param {object} pt - Query point in mm
 * @param {number} pt.x - X coordinate
 * @param {number} pt.y - Y coordinate
 * @param {Point3[]} probedPositions - Probed positions in mm
 * @returns {Point3[]} The 3 closest non-collinear points, or empty if not enough points
 */
const getThreeClosestPoints = (pt, probedPositions) => {
  const result = [];

  if (probedPositions.length < 3) {
    return result;
  }

  // Sort by 2D distance to target point
  const sorted = [...probedPositions].sort((a, b) => {
    return distanceSquared2(a, pt) - distanceSquared2(b, pt);
  });

  let i = 0;
  while (result.length < 3 && i < sorted.length) {
    if (result.length === 2) {
      // Make sure the third point is not collinear with the first two
      if (!isColinear(sub3(result[1], result[0]), sub3(sorted[i], result[0]))) {
        result.push(sorted[i]);
      }
    } else {
      result.push(sorted[i]);
    }
    i++;
  }

  return result;
};

/**
 * Interpolate the probe-surface Z at (x, y) by fitting a plane through the three
 * closest non-collinear probed points. Used as a fallback when the probe data is
 * not a complete rectangular grid.
 * @param {number} x - X in mm
 * @param {number} y - Y in mm
 * @param {Point3[]} probedPositions - Probed positions in mm
 * @returns {number|null} Surface Z in mm, or null if it cannot be computed
 */
const planeFitZ = (x, y, probedPositions) => {
  const points = getThreeClosestPoints({ x, y }, probedPositions);
  if (points.length < 3) {
    return null;
  }
  const normal = crossProduct3(sub3(points[1], points[0]), sub3(points[2], points[0]));
  if (normal.z === 0) {
    return null;
  }
  const base = points[0];
  return base.z - (normal.x * (x - base.x) + normal.y * (y - base.y)) / normal.z;
};

/**
 * Build a lattice for bilinear interpolation from probed points.
 * @param {Point3[]} probedPositions - Probed positions in mm
 * @returns {ProbeGrid|null} Grid (see ProbeGrid typedef); matrix[j][i] is
 *   undefined for an unprobed node. null when there are fewer than two distinct
 *   X or Y values.
 */
const buildProbeGrid = (probedPositions) => {
  const xs = [...new Set(probedPositions.map(p => roundProbeXY(p.x)))].sort((a, b) => a - b);
  const ys = [...new Set(probedPositions.map(p => roundProbeXY(p.y)))].sort((a, b) => a - b);
  if (xs.length < 2 || ys.length < 2) {
    return null;
  }
  const xIndex = new Map(xs.map((x, i) => [x, i]));
  const yIndex = new Map(ys.map((y, j) => [y, j]));
  const matrix = ys.map(() => new Array(xs.length).fill(undefined));
  for (const p of probedPositions) {
    matrix[yIndex.get(roundProbeXY(p.y))][xIndex.get(roundProbeXY(p.x))] = p.z;
  }
  return { xs, ys, matrix };
};

// Largest cell index i with values[i] <= v, clamped to a valid cell [0, n-2].
// Combined with clamped bilinear weights, out-of-map queries use the nearest edge height.
const findCell = (values, v) => {
  let i = 0;
  while ((i < values.length - 2) && (values[i + 1] <= v)) {
    i += 1;
  }
  return i;
};

// Typical gap between consecutive sorted grid coordinates (assumes >= 2 values).
// A 1 µm quantisation glitch must not become the subdivision size: that turns
// one move into hundreds of thousands of G1 lines and aborts the process.
const minSpacing = (sorted) => {
  const gaps = [];
  for (let k = 1; k < sorted.length; k += 1) {
    const gap = sorted[k] - sorted[k - 1];
    if (gap > 0) {
      gaps.push(gap);
    }
  }
  if (gaps.length === 0) {
    return Infinity;
  }
  const ordered = gaps.slice().sort((a, b) => a - b);
  const median = ordered[Math.floor((ordered.length - 1) / 2)];
  const noise = Math.max(median * 0.05, 1e-6);
  let min = Infinity;
  for (const gap of gaps) {
    if (gap >= noise && gap < min) {
      min = gap;
    }
  }
  return Number.isFinite(min) ? min : median;
};

/**
 * Bilinear interpolation of the probe-surface Z at (x, y) over the grid.
 * @param {ProbeGrid} grid - Grid from buildProbeGrid (mm)
 * @param {number} x - X in mm
 * @param {number} y - Y in mm
 * @returns {number|null} Surface Z in mm, or null if any of the four surrounding
 *   grid nodes is missing (caller falls back to plane fit)
 */
const bilinearZ = (grid, x, y) => {
  const { xs, ys, matrix } = grid;
  const i = findCell(xs, x);
  const j = findCell(ys, y);
  const z00 = matrix[j][i];
  const z10 = matrix[j][i + 1];
  const z01 = matrix[j + 1][i];
  const z11 = matrix[j + 1][i + 1];
  if (z00 === undefined || z10 === undefined || z01 === undefined || z11 === undefined) {
    return null;
  }
  // Clamp to the edge of the nearest cell so out-of-map XY cannot amplify Z.
  const a = Math.min(1, Math.max(0, (x - xs[i]) / (xs[i + 1] - xs[i])));
  const b = Math.min(1, Math.max(0, (y - ys[j]) / (ys[j + 1] - ys[j])));
  return z00 * (1 - a) * (1 - b) +
    z10 * a * (1 - b) +
    z01 * (1 - a) * b +
    z11 * a * b;
};

/**
 * Build a queryable probe surface. zAt(x, y) returns the surface Z (mm) at a
 * point (mm), using bilinear interpolation over the grid and falling back to a
 * 3-point plane fit for non-grid data or grid cells with missing nodes.
 * @param {Point3[]} probedPositions - Probed positions in mm
 * @returns {{ zAt: (x: number, y: number) => (number|null), stepX: number, stepY: number }}
 */
const buildSurface = (probedPositions) => {
  // Bilinear interpolation lattice; null when the probe data has fewer than two
  // distinct X or Y values (per-cell plane-fit fallback handles sparse grids).
  const grid = buildProbeGrid(probedPositions);

  // Grid spacing controls how finely moves are subdivided; derive it from the
  // probe lattice instead of rescanning every point pair.
  const stepX = grid ? minSpacing(grid.xs) : DEFAULT_GRID_STEP;
  const stepY = grid ? minSpacing(grid.ys) : DEFAULT_GRID_STEP;

  const zAt = (x, y) => {
    const z = grid ? bilinearZ(grid, x, y) : null;
    return z !== null ? z : planeFitZ(x, y, probedPositions);
  };

  return { zAt, stepX, stepY };
};

/**
 * Calculate Z compensation for a point. Uses bilinear interpolation over the
 * probe grid, falling back to a 3-point plane fit for non-grid data or grid
 * cells with missing nodes.
 *
 * Probe Z is the work-coordinate trigger height, which includes the probe
 * device. Only the difference from the work-origin reading is a surface error:
 * correctedZ = commandedZ + probeAtXY - referenceProbeZ.
 *
 * @param {Point3} pt - Point in current units
 * @param {object} surface - Probe surface from buildSurface
 * @param {string} units - Current units (METRIC_UNITS or IMPERIAL_UNITS)
 * @param {number} referenceProbeZ - Probe height at the work origin, in mm
 * @returns {Point3} Compensated point in current units
 */
const compensatePoint = (pt, surface, units = METRIC_UNITS, referenceProbeZ = 0) => {
  // Probed positions are in mm; convert the query point to match.
  const x = units === IMPERIAL_UNITS ? in2mm(pt.x) : pt.x;
  const y = units === IMPERIAL_UNITS ? in2mm(pt.y) : pt.y;
  const z = units === IMPERIAL_UNITS ? in2mm(pt.z) : pt.z;

  const probeZ = surface.zAt(x, y);
  if (probeZ === null) {
    log.warn('Cannot compute Z compensation for point');
    return pt;
  }

  const compensatedZ = z + (probeZ - referenceProbeZ);
  return {
    x: pt.x,
    y: pt.y,
    z: units === IMPERIAL_UNITS ? mm2in(compensatedZ) : compensatedZ,
  };
};

/**
 * Probe height (mm) that work Z zero already accounts for.
 * The map stores absolute trigger heights. Z zero is one work-offset, so the
 * matching reading is the probe height at X0 Y0 — when that point lies inside
 * the measured area. An explicit referenceProbeZ overrides that lookup.
 * @param {Point3[]} probedPositions
 * @param {{ zAt: (x: number, y: number) => (number|null) }} surface
 * @param {number|undefined} referenceProbeZ
 * @returns {number}
 */
const resolveReferenceProbeZ = (probedPositions, surface, referenceProbeZ) => {
  if (referenceProbeZ !== undefined && referenceProbeZ !== null) {
    if (!Number.isFinite(referenceProbeZ)) {
      throw new Error('referenceProbeZ must be a finite number');
    }
    return referenceProbeZ;
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of probedPositions) {
    if (point.x < minX) {
      minX = point.x;
    }
    if (point.x > maxX) {
      maxX = point.x;
    }
    if (point.y < minY) {
      minY = point.y;
    }
    if (point.y > maxY) {
      maxY = point.y;
    }
  }

  // Inclusive: a probe on the work-origin corner is inside the map.
  if (minX <= 0 && maxX >= 0 && minY <= 0 && maxY >= 0) {
    const originZ = surface.zAt(0, 0);
    if (!Number.isFinite(originZ)) {
      throw new Error('Cannot determine the probe height at the work origin');
    }
    return originZ;
  }

  throw new Error('Probe map does not cover the work origin (X0 Y0), so the Z-zero reference height is unknown');
};

/**
 * Creates probe XY points based on the given range and step configuration.
 *
 * @param {object} options - Configuration options
 * @param {number} options.startX - X-axis minimum
 * @param {number} options.endX - X-axis maximum
 * @param {number} options.stepX - X-axis step size
 * @param {number} options.startY - Y-axis minimum
 * @param {number} options.endY - Y-axis maximum
 * @param {number} options.stepY - Y-axis step size
 * @returns {array} Array of probe XY points [{x, y}, ...]
 */
export const createProbeXYPoints = (options) => {
  const {
    startX = 0,
    endX = 0,
    stepX = 10,
    startY = 0,
    endY = 0,
    stepY = 10,
  } = ensurePlainObject(options);

  const positions = [];

  for (let y = startY; y <= endY; y += stepY) {
    for (let x = startX; x <= endX; x += stepX) {
      positions.push({ x, y });
    }
  }

  return positions;
};

/**
 * Applies probe-based compensation to G-code to correct positional deviations.
 * Grid step size is automatically detected from probe data spacing.
 *
 * @param {string} gcodeStr - G-code string to compensate
 * @param {array} probeData - Array of probe data [{x, y, z, a, b, c, u, v, w}, ...] or [{x, y, z}, ...]
 * @param {{ referenceProbeZ?: number }} [options] - Optional probe height (mm) at work Z zero.
 *   When omitted, the probe height interpolated at X0 Y0 is used.
 * @returns {string} Compensated G-code string
 */
export const applyProbeCompensation = (gcodeStr, probeData = [], options = {}) => {
  if (typeof gcodeStr === 'string' && gcodeStr.includes(AUTOLEVEL_APPLIED_MARKER)) {
    throw new Error('G-code is already autolevel-compensated; refusing to apply again');
  }
  if (!Array.isArray(probeData) || probeData.length < 3) {
    throw new Error('At least 3 valid probe points are required');
  }
  if (probeData.some(p => !p || !['x', 'y', 'z'].every(axis => Number.isFinite(p[axis])))) {
    throw new Error('Probe coordinates must be finite numbers');
  }
  // Use the same micron rounding as the bilinear grid so near-duplicates cannot
  // silently overwrite a cell height after validation.
  const keys = new Set(probeData.map(p => `${roundProbeXY(p.x)},${roundProbeXY(p.y)}`));
  if (keys.size !== probeData.length) {
    throw new Error('Probe data contains duplicate XY positions');
  }
  if (getThreeClosestPoints(probeData[0], probeData).length < 3) {
    throw new Error('Probe points must span a surface, not a single line');
  }
  // Extract just x, y, z from probe data
  const probedPositions = probeData.map(p => ({
    x: Number(p.x),
    y: Number(p.y),
    z: Number(p.z),
  }));

  const surface = buildSurface(probedPositions);
  const { stepX, stepY } = surface;
  const referenceProbeZ = resolveReferenceProbeZ(
    probedPositions,
    surface,
    ensurePlainObject(options).referenceProbeZ
  );

  log.info(`Applying Z compensation (auto-detected grid: ${stepX.toFixed(2)}mm × ${stepY.toFixed(2)}mm, ${probedPositions.length} points, reference Z ${referenceProbeZ.toFixed(3)}mm)...`);

  const lines = gcodeStr.split('\n');
  const results = [
    `; ${AUTOLEVEL_APPLIED_MARKER}`,
    `; ${AUTOLEVEL_REFERENCE_PREFIX}${referenceProbeZ.toFixed(6)}`,
  ];

  let p0 = { x: 0, y: 0, z: 0 };
  let p0Initialized = false;
  let pt = {};
  // null until G0/G1/G2/G3 is seen — do not invent rapids on bare-XYZ continuations.
  let motion = null;
  let plane = 17;
  let selectedUnits = null;
  let units = METRIC_UNITS;

  lines.forEach((line, lineIndex) => {
    // Progress logging
    if (lineIndex % 1000 === 0) {
      log.debug(`Compensation progress: ${lineIndex}/${lines.length}`);
    }

    // Parse line using gcode-parser
    const { line: strippedLine, words } = gcodeParser.parseLine(line, {
      flatten: true,
      lineMode: 'stripped',
    });

    // If empty line or only comments, copy original line as-is
    if (!strippedLine || words.length === 0) {
      results.push(line);
      return;
    }

    // Absolute G0/G1 plus linearized G2/G3 in G17/G18/G19. Reject other modes.
    const gCodes = words.filter(word => /^G/i.test(word)).map(word => Number(word.slice(1)));
    const supported = [0, 1, 2, 3, 4, 17, 18, 19, 20, 21, 40, 49, 53, 54, 90, 94];
    const unsupported = gCodes.find(code => !supported.includes(code));
    if (unsupported !== undefined) {
      throw new Error(`Unsupported G${unsupported} on line ${lineIndex + 1}: autolevel requires absolute G0/G1/G2/G3 moves in G54`);
    }
    if (words.some(word => /^[ABCUVW]/i.test(word))) {
      throw new Error(`Unsupported auxiliary-axis move on line ${lineIndex + 1}`);
    }
    if (words.some(word => /^R/i.test(word))) {
      throw new Error(`R-word arcs are not supported on line ${lineIndex + 1}; use IJK arcs or linearize in CAM`);
    }
    const unitCode = gCodes.find(code => code === 20 || code === 21);
    if (unitCode !== undefined) {
      if (selectedUnits !== null && selectedUnits !== unitCode) {
        throw new Error('Changing units within a compensated program is not supported');
      }
      selectedUnits = unitCode;
      units = unitCode === 20 ? IMPERIAL_UNITS : METRIC_UNITS;
    }
    if (gCodes.includes(17)) {
      plane = 17;
    }
    if (gCodes.includes(18)) {
      plane = 18;
    }
    if (gCodes.includes(19)) {
      plane = 19;
    }
    if (gCodes.includes(0)) {
      motion = 'G0';
    }
    if (gCodes.includes(1)) {
      motion = 'G1';
    }
    if (gCodes.includes(2)) {
      motion = 'G2';
    }
    if (gCodes.includes(3)) {
      motion = 'G3';
    }
    if (gCodes.includes(53)) {
      // Machine-coordinate parking/retract moves must remain unmodified.
      // Their work-coordinate endpoint is unknown without the machine's WCO.
      results.push(line);
      pt = {};
      p0Initialized = false;
      return;
    }

    // Extract coordinate values from words (single pass)
    const coordinate = (() => {
      const result = { x: undefined, y: undefined, z: undefined };
      for (const word of words) {
        const letter = word[0].toUpperCase();
        if (letter === 'X' || letter === 'Y' || letter === 'Z') {
          result[letter.toLowerCase()] = parseFloat(word.substring(1));
        }
      }
      return result;
    })();
    const offsets = (() => {
      const result = { i: undefined, j: undefined, k: undefined };
      for (const word of words) {
        const letter = word[0].toUpperCase();
        if (letter === 'I' || letter === 'J' || letter === 'K') {
          result[letter.toLowerCase()] = parseFloat(word.substring(1));
        }
      }
      return result;
    })();

    if (gCodes.includes(4)) {
      // Pure dwell is fine; dwell mixed with XYZ would skip pose updates and
      // leave uncompensated motion in the output.
      if (coordinate.x !== undefined || coordinate.y !== undefined || coordinate.z !== undefined) {
        throw new Error(`G4 with XYZ on line ${lineIndex + 1} is not supported; put dwell on its own line`);
      }
      results.push(line);
      return;
    }

    // If no coordinate change, copy line as-is
    if ((coordinate.x === undefined) && (coordinate.y === undefined) && (coordinate.z === undefined)) {
      results.push(line);
      return;
    }

    // Once coordinates are seen, an implicit initial units mode is also fixed.
    selectedUnits = selectedUnits === null ? 21 : selectedUnits;

    // Update coordinates
    if (coordinate.x !== undefined) {
      pt.x = coordinate.x;
    }
    if (coordinate.y !== undefined) {
      pt.y = coordinate.y;
    }
    if (coordinate.z !== undefined) {
      pt.z = coordinate.z;
    }

    const isArc = motion === 'G2' || motion === 'G3';
    if (![pt.x, pt.y, pt.z].every(Number.isFinite)) {
      // Preserve initial positioning/retracts until XYZ is explicitly known.
      // In particular, a Z-only retract must never invent an XY move to zero.
      if (motion === 'G1' || isArc) {
        throw new Error(`Set absolute X, Y and Z with G0 before cutting (line ${lineIndex + 1})`);
      }
      results.push(line);
      return;
    }

    // Keep feed/spindle words; drop geometry words. Arcs are rewritten as G1.
    const lineWithoutGeom = words
      .filter(word => {
        const letter = word[0].toUpperCase();
        if (letter === 'X' || letter === 'Y' || letter === 'Z' || letter === 'I' || letter === 'J' || letter === 'K') {
          return false;
        }
        const code = Number(word.slice(1));
        if (/^G/i.test(word) && (code === 2 || code === 3)) {
          return false;
        }
        return true;
      })
      .join(' ');

    // Linear moves follow the probe grid. Arcs use a chord-error budget so a
    // hole smaller than the grid is not replaced by one chord.
    const step = Math.min(stepX, stepY);
    const maxSegmentLength = (units === IMPERIAL_UNITS ? mm2in(step) : step) / 2;
    const arcChordError = units === IMPERIAL_UNITS ? mm2in(ARC_CHORD_ERROR_MM) : ARC_CHORD_ERROR_MM;

    const pushLine = (line) => {
      if (results.length >= MAX_OUTPUT_LINES) {
        throw new Error(`Compensated G-code would exceed ${MAX_OUTPUT_LINES} lines. The probe spacing is too fine for this program.`);
      }
      results.push(line);
    };

    const emitSegments = (segments, firstPrefix, restPrefix) => {
      if (segments.length === 0 && firstPrefix) {
        pushLine(firstPrefix);
        return;
      }
      for (let i = 1; i < segments.length; i++) {
        const seg = segments[i];
        const cpt = compensatePoint(seg, surface, units, referenceProbeZ);
        const prefix = i === 1 ? firstPrefix : restPrefix;
        const newLine = `${prefix} X${cpt.x.toFixed(3)} Y${cpt.y.toFixed(3)} Z${cpt.z.toFixed(3)}`;
        pushLine(newLine.trim());
      }
    };

    if (!p0Initialized) {
      if (isArc) {
        throw new Error(`Arc on line ${lineIndex + 1} needs a prior absolute XYZ position`);
      }
      const cpt = compensatePoint(pt, surface, units, referenceProbeZ);
      const newLine = `${lineWithoutGeom} X${cpt.x.toFixed(3)} Y${cpt.y.toFixed(3)} Z${cpt.z.toFixed(3)}`;
      results.push(newLine.trim());
      p0Initialized = true;
    } else if (isArc) {
      let segments;
      try {
        segments = linearizeArc(p0, pt, offsets, plane, motion === 'G2', arcChordError);
      } catch (err) {
        throw new Error(`${err.message} (line ${lineIndex + 1})`);
      }
      const firstPrefix = ['G1', lineWithoutGeom].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      emitSegments(segments, firstPrefix, 'G1');
    } else {
      const segments = subdivideSegment(p0, pt, maxSegmentLength);
      emitSegments(segments, lineWithoutGeom, motion || '');
    }

    // Update previous position
    p0 = { x: pt.x, y: pt.y, z: pt.z };
  });

  log.info('Z compensation applied successfully');
  return results.join('\n');
};

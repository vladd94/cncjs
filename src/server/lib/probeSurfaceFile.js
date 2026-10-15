// Probe Surface files are the existing nine-column XYZ rows, plus an optional
// comment header when the Z column is a deviation from the first probe point.
export const PROBE_SURFACE_NORMALIZED_MARKER = 'cncjs-probe-surface-normalized';
export const Z_VALUES_DEVIATION_FROM_FIRST = 'deviation-from-first-probe';
// Older normalized files stored surface Z in the work coordinates that existed
// during probing. Those values are converted once on load.
export const Z_VALUES_WORK_ZERO = 'surface-relative-to-work-zero';
// XY in a machine-referenced file is millimetres in machine coordinates.
// Files without this marker stay work-coordinate maps.
export const XY_REFERENCE_MACHINE = 'machine';
export const XY_REFERENCE_WORK = 'work';
export const PROBE_XY_MACHINE_MARKER = 'cncjs-probe-xy=machine';

const PROBE_HEIGHT_PATTERN = /probe-height=(-?\d+(?:\.\d+)?)/;
const REFERENCE_XY_PATTERN = /reference-xy=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/;
const REFERENCE_SURFACE_Z_PATTERN = /reference-surface-z=(-?\d+(?:\.\d+)?)/;
const MACHINE_HOME_PATTERN = /machine-home=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/;
const HOMING_MASK_PATTERN = /homing-mask=(-?\d+)/;
const TRAVEL_XY_PATTERN = /travel-xy=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/;
const PULLOFF_PATTERN = /pulloff=(-?\d+(?:\.\d+)?)/;

const isComment = (line) => line.startsWith(';') || line.startsWith('(');

// Shared reader. Does not enforce a minimum point count: controller loads
// accept shorter files than the autolevel apply step.
export const readProbeSurfaceText = (text) => {
  const lines = String(text).split(/\r?\n/);
  const normalized = lines.some(line => line.includes(PROBE_SURFACE_NORMALIZED_MARKER));
  let probeHeightMm = null;
  let referenceX = null;
  let referenceY = null;
  let referenceSurfaceZ = null;
  let deviationFromFirst = false;
  let xyReference = XY_REFERENCE_WORK;
  let machineReference = null;
  const points = [];
  let dataRow = 0;

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    if (isComment(trimmed)) {
      const match = PROBE_HEIGHT_PATTERN.exec(trimmed);
      if (match) {
        probeHeightMm = Number(match[1]);
      }
      if (trimmed.includes(`z-values=${Z_VALUES_DEVIATION_FROM_FIRST}`)) {
        deviationFromFirst = true;
      }
      if (trimmed.includes(PROBE_XY_MACHINE_MARKER)) {
        xyReference = XY_REFERENCE_MACHINE;
        machineReference = machineReference || {};
      }
      const home = MACHINE_HOME_PATTERN.exec(trimmed);
      if (home) {
        machineReference = machineReference || {};
        machineReference.homeX = Number(home[1]);
        machineReference.homeY = Number(home[2]);
      }
      const mask = HOMING_MASK_PATTERN.exec(trimmed);
      if (mask) {
        machineReference = machineReference || {};
        machineReference.homingMask = Number(mask[1]);
      }
      const travel = TRAVEL_XY_PATTERN.exec(trimmed);
      if (travel) {
        machineReference = machineReference || {};
        machineReference.travelX = Number(travel[1]);
        machineReference.travelY = Number(travel[2]);
      }
      const pulloff = PULLOFF_PATTERN.exec(trimmed);
      if (pulloff) {
        machineReference = machineReference || {};
        machineReference.pulloff = Number(pulloff[1]);
      }
      const xy = REFERENCE_XY_PATTERN.exec(trimmed);
      if (xy) {
        referenceX = Number(xy[1]);
        referenceY = Number(xy[2]);
      }
      const surfaceZ = REFERENCE_SURFACE_Z_PATTERN.exec(trimmed);
      if (surfaceZ) {
        referenceSurfaceZ = Number(surfaceZ[1]);
      }
      return;
    }

    dataRow += 1;
    const values = trimmed.split(/\s+/).map(Number);
    if (values.length < 3 || !values.slice(0, 3).every(Number.isFinite)) {
      throw new Error(`Invalid probe coordinates on data row ${dataRow}`);
    }
    points.push({ x: values[0], y: values[1], z: values[2] });
  });

  // Work-zero files store the absolute surface from probe time. Subtract the
  // first point once so a later Z0 is not given that whole offset again.
  // Probe thickness was already removed when the file was written.
  if (normalized && !deviationFromFirst && points.length > 0) {
    referenceSurfaceZ = points[0].z;
    referenceX = points[0].x;
    referenceY = points[0].y;
    points.forEach((point) => {
      point.z -= referenceSurfaceZ;
    });
  }

  let minZ = Infinity;
  let maxZ = -Infinity;
  points.forEach(({ z }) => {
    minZ = Math.min(z, minZ);
    maxZ = Math.max(z, maxZ);
  });

  return {
    points,
    normalized,
    probeHeightMm,
    referenceX,
    referenceY,
    referenceSurfaceZ,
    xyReference,
    machineReference,
    minZ,
    maxZ,
  };
};

// Home-relative distances, for drawing a machine map on the probe-area diagram.
export const homeRelativePoint = (point, reference) => {
  if (!reference || !Number.isFinite(Number(reference.homeX)) || !Number.isFinite(Number(reference.homingMask))) {
    return point;
  }
  const mask = Math.abs(Number(reference.homingMask)) || 0;
  const signX = Math.floor(mask / 1) % 2 === 1 ? 1 : -1;
  const signY = Math.floor(mask / 2) % 2 === 1 ? 1 : -1;
  return {
    ...point,
    x: signX * (point.x - Number(reference.homeX)),
    y: signY * (point.y - Number(reference.homeY)),
  };
};

export const parseProbeFile = (text) => {
  const { points } = readProbeSurfaceText(text);
  if (points.length < 3) {
    throw new Error('At least 3 valid probe points are required');
  }
  return points;
};

// Same points as parseProbeFile, plus whether this file is already normalized.
// Loading does not subtract probe height again.
export const readProbeSurfaceFile = (text) => {
  const surface = readProbeSurfaceText(text);
  if (surface.points.length < 3) {
    throw new Error('At least 3 valid probe points are required');
  }
  return surface;
};

const formatMachineReference = (machineReference) => {
  if (!machineReference) {
    return [];
  }
  const lines = [`; ${PROBE_XY_MACHINE_MARKER}`];
  const { homeX, homeY, homingMask, travelX, travelY, pulloff } = machineReference;
  if (Number.isFinite(Number(homeX)) && Number.isFinite(Number(homeY))) {
    lines.push(`; machine-home=${Number(homeX).toFixed(6)},${Number(homeY).toFixed(6)}`);
  }
  if (Number.isFinite(Number(homingMask))) {
    lines.push(`; homing-mask=${Number(homingMask)}`);
  }
  if (Number.isFinite(Number(travelX)) && Number.isFinite(Number(travelY))) {
    lines.push(`; travel-xy=${Number(travelX).toFixed(6)},${Number(travelY).toFixed(6)}`);
  }
  if (Number.isFinite(Number(pulloff))) {
    lines.push(`; pulloff=${Number(pulloff).toFixed(6)}`);
  }
  return lines;
};

export const serializeProbeSurfaceFile = (points, {
  normalized = false,
  probeHeightMm = null,
  referenceX = null,
  referenceY = null,
  referenceSurfaceZ = null,
  xyReference = XY_REFERENCE_WORK,
  machineReference = null,
} = {}) => {
  const rows = points.map(({ x, y, z }) => `${x} ${y} ${z} 0 0 0 0 0 0`);
  const header = xyReference === XY_REFERENCE_MACHINE ? formatMachineReference(machineReference) : [];
  if (!normalized) {
    return header.concat(rows).join('\n');
  }

  header.push(`; ${PROBE_SURFACE_NORMALIZED_MARKER}`);
  if (Number.isFinite(Number(probeHeightMm))) {
    header.push(`; probe-height=${Number(probeHeightMm).toFixed(6)}`);
  }
  header.push(`; z-values=${Z_VALUES_DEVIATION_FROM_FIRST}`);
  const first = points[0] || { x: 0, y: 0 };
  const rx = Number.isFinite(Number(referenceX)) ? Number(referenceX) : first.x;
  const ry = Number.isFinite(Number(referenceY)) ? Number(referenceY) : first.y;
  header.push(`; reference-xy=${rx.toFixed(6)},${ry.toFixed(6)}`);
  if (Number.isFinite(Number(referenceSurfaceZ))) {
    header.push(`; reference-surface-z=${Number(referenceSurfaceZ).toFixed(6)}`);
  }
  return header.concat(rows).join('\n');
};

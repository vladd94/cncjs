// Probe Surface files are the existing nine-column XYZ rows, plus an optional
// comment header when the Z column is a deviation from the first probe point.
export const PROBE_SURFACE_NORMALIZED_MARKER = 'cncjs-probe-surface-normalized';
export const Z_VALUES_DEVIATION_FROM_FIRST = 'deviation-from-first-probe';
// Older normalized files stored surface Z in the work coordinates that existed
// during probing. Those values are converted once on load.
export const Z_VALUES_WORK_ZERO = 'surface-relative-to-work-zero';

const PROBE_HEIGHT_PATTERN = /probe-height=(-?\d+(?:\.\d+)?)/;
const REFERENCE_XY_PATTERN = /reference-xy=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/;
const REFERENCE_SURFACE_Z_PATTERN = /reference-surface-z=(-?\d+(?:\.\d+)?)/;

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
    minZ,
    maxZ,
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

export const serializeProbeSurfaceFile = (points, {
  normalized = false,
  probeHeightMm = null,
  referenceX = null,
  referenceY = null,
  referenceSurfaceZ = null,
} = {}) => {
  const rows = points.map(({ x, y, z }) => `${x} ${y} ${z} 0 0 0 0 0 0`);
  if (!normalized) {
    return rows.join('\n');
  }

  const header = [`; ${PROBE_SURFACE_NORMALIZED_MARKER}`];
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

// Probe Surface files are the existing nine-column XYZ rows, plus an optional
// comment header when the Z column is already surface height relative to work Z0.
export const PROBE_SURFACE_NORMALIZED_MARKER = 'cncjs-probe-surface-normalized';

const PROBE_HEIGHT_PATTERN = /probe-height=(-?\d+(?:\.\d+)?)/;

const isComment = (line) => line.startsWith(';') || line.startsWith('(');

// Shared reader. Does not enforce a minimum point count: controller loads
// accept shorter files than the autolevel apply step.
export const readProbeSurfaceText = (text) => {
  const lines = String(text).split(/\r?\n/);
  const normalized = lines.some(line => line.includes(PROBE_SURFACE_NORMALIZED_MARKER));
  let probeHeightMm = null;
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
      return;
    }

    dataRow += 1;
    const values = trimmed.split(/\s+/).map(Number);
    if (values.length < 3 || !values.slice(0, 3).every(Number.isFinite)) {
      throw new Error(`Invalid probe coordinates on data row ${dataRow}`);
    }
    points.push({ x: values[0], y: values[1], z: values[2] });
  });

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

export const serializeProbeSurfaceFile = (points, { normalized = false, probeHeightMm = null } = {}) => {
  const rows = points.map(({ x, y, z }) => `${x} ${y} ${z} 0 0 0 0 0 0`);
  if (!normalized) {
    return rows.join('\n');
  }

  const header = [`; ${PROBE_SURFACE_NORMALIZED_MARKER}`];
  if (Number.isFinite(Number(probeHeightMm))) {
    header.push(`; probe-height=${Number(probeHeightMm).toFixed(6)}`);
  }
  header.push('; z-values=surface-relative-to-work-zero');
  return header.concat(rows).join('\n');
};

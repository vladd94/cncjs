// CNCjs probe files contain XYZ followed by optional auxiliary-axis columns.
export const parseProbeFile = (text) => {
  const points = text.split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
    const values = line.trim().split(/\s+/).map(Number);
    if (values.length < 3 || !values.every(Number.isFinite)) {
      throw new Error(`Invalid probe coordinates on data row ${index + 1}`);
    }
    const [x, y, z] = values;
    return { x, y, z };
  });
  if (points.length < 3) {
    throw new Error('At least 3 valid probe points are required');
  }
  return points;
};

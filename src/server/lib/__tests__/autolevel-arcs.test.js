/* eslint-env jest */
import {
  applyProbeCompensation,
  ARC_CHORD_ERROR_MM,
  AUTOLEVEL_APPLIED_MARKER,
} from '../autolevel';

const flat = [
  { x: 0, y: 0, z: 0 },
  { x: 40, y: 0, z: 0 },
  { x: 0, y: 40, z: 0 },
  { x: 40, y: 40, z: 0 },
];

// Surface rises 1 mm across X=0..10, independent of Y.
const tilt = [
  { x: 0, y: 0, z: 0 },
  { x: 10, y: 0, z: 1 },
  { x: 0, y: 10, z: 0 },
  { x: 10, y: 10, z: 1 },
];

const body = (gcode, probeData = flat) => {
  const result = applyProbeCompensation(gcode, probeData);
  const prefix = `; ${AUTOLEVEL_APPLIED_MARKER}\n`;
  expect(result.startsWith(prefix)).toBe(true);
  return result.slice(prefix.length);
};

const xyz = (line) => {
  const pick = (axis) => {
    const match = line.match(new RegExp(`${axis}(-?\\d+(?:\\.\\d+)?)`));
    return match ? Number(match[1]) : null;
  };
  return { x: pick('X'), y: pick('Y'), z: pick('Z') };
};

const g1Points = (gcode) => gcode.split('\n').filter(line => /^G1\b/.test(line)).map(xyz);

const sagitta = (radius, a, b) => {
  const chord = Math.hypot(b.x - a.x, b.y - a.y);
  return radius - Math.sqrt(Math.max(0, (radius * radius) - ((chord / 2) ** 2)));
};

describe('autolevel arc tessellation', () => {
  test('a full-circle G3 becomes many G1 segments on the original radius', () => {
    const result = body('G17\nG0 X10 Y0 Z0\nG3 X10 Y0 I-5 J0 F100');
    const lines = result.split('\n');
    const points = g1Points(result);

    expect(lines.some(line => /(^|\s)G0*[23](\s|$)/.test(line))).toBe(false);
    expect(points.length).toBeGreaterThan(8);
    expect(lines.filter(line => line.includes('F100'))).toHaveLength(1);
    expect(lines.find(line => line.includes('F100')).startsWith('G1')).toBe(true);

    points.forEach((point) => {
      expect(Math.abs(Math.hypot(point.x - 5, point.y - 0) - 5)).toBeLessThan(0.02);
    });
    expect(points.some(point => point.y > 4)).toBe(true);
    expect(points.some(point => point.y < -4)).toBe(true);
    expect(points[points.length - 1].x).toBeCloseTo(10, 3);
    expect(points[points.length - 1].y).toBeCloseTo(0, 3);

    const trail = [{ x: 10, y: 0 }, ...points];
    trail.slice(1).forEach((point, index) => {
      expect(sagitta(5, trail[index], point)).toBeLessThanOrEqual(ARC_CHORD_ERROR_MM + 1e-4);
    });
  });

  test('partial G2 and G3 arcs leave the chord and travel in opposite directions', () => {
    const ccw = g1Points(body('G17\nG0 X10 Y0 Z0\nG3 X0 Y0 I-5 J0'));
    const cw = g1Points(body('G17\nG0 X10 Y0 Z0\nG2 X0 Y0 I-5 J0'));

    expect(ccw.length).toBeGreaterThan(2);
    expect(cw.length).toBeGreaterThan(2);
    expect(Math.max(...ccw.map(point => point.y))).toBeGreaterThan(4);
    expect(Math.min(...ccw.map(point => point.y))).toBeGreaterThan(-0.05);
    expect(Math.min(...cw.map(point => point.y))).toBeLessThan(-4);
    expect(Math.max(...cw.map(point => point.y))).toBeLessThan(0.05);
    expect(ccw[ccw.length - 1].x).toBeCloseTo(0, 3);
    expect(cw[cw.length - 1].x).toBeCloseTo(0, 3);
  });

  test('an XY arc over a tilted map gets a different compensated Z at each X', () => {
    const points = g1Points(body('G17\nG0 X10 Y0 Z0\nG3 X0 Y0 I-5 J0', tilt));
    const zs = points.map(point => point.z);

    expect(points.length).toBeGreaterThan(2);
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(0.2);
    const crown = points.reduce((best, point) => (point.y > best.y ? point : best), points[0]);
    expect(crown.x).toBeCloseTo(5, 1);
    expect(crown.y).toBeGreaterThan(4);
    // Commanded Z is 0. Surface height at X=5 is 0.5.
    expect(crown.z).toBeCloseTo(0.5, 1);
  });

  test('a helical arc adds probe height to the commanded Z along the sweep', () => {
    const flatPoints = g1Points(body('G17\nG0 X10 Y0 Z1\nG3 X0 Y0 Z0 I-5 J0'));
    const tiltedPoints = g1Points(body('G17\nG0 X10 Y0 Z1\nG3 X0 Y0 Z0 I-5 J0', tilt));
    const flatCrown = flatPoints.reduce((best, point) => (point.y > best.y ? point : best), flatPoints[0]);
    const tiltedCrown = tiltedPoints.reduce((best, point) => (point.y > best.y ? point : best), tiltedPoints[0]);

    expect(flatCrown.x).toBeGreaterThan(4);
    expect(flatCrown.x).toBeLessThan(6);
    expect(flatCrown.z).toBeGreaterThan(0.4);
    expect(flatCrown.z).toBeLessThan(0.6);
    expect(tiltedCrown.z).toBeGreaterThan(0.85);
    expect(tiltedCrown.z).toBeLessThan(1.15);
  });

  test('a G18 lead-in stays a quarter circle instead of a chord or the long way around', () => {
    const points = g1Points(body([
      'G21',
      'G0 X27.591 Y22.947 Z0',
      'G18 G3 X27.291 Z-0.3 I-0.3 K0',
    ].join('\n')));

    expect(points.length).toBeGreaterThan(2);
    points.forEach((point) => {
      expect(point.z).toBeLessThanOrEqual(0.001);
      expect(point.z).toBeGreaterThanOrEqual(-0.301);
      expect(point.y).toBeCloseTo(22.947, 3);
    });
    expect(points.some(point => point.x > 27.48 && point.z < -0.1 && point.z > -0.25)).toBe(true);
    expect(points[points.length - 1].x).toBeCloseTo(27.291, 3);
    expect(points[points.length - 1].z).toBeCloseTo(-0.3, 3);
  });

  test('G19 arcs and modal arc continuations keep their plane and feed', () => {
    const yz = g1Points(body('G19\nG0 X0 Y0 Z0\nG3 Y10 Z0 J5 K0'));
    const crown = yz.reduce((best, point) => (Math.abs(point.z) > Math.abs(best.z) ? point : best), yz[0]);
    expect(yz.length).toBeGreaterThan(2);
    expect(crown.y).toBeGreaterThan(4);
    expect(crown.y).toBeLessThan(6);
    expect(crown.z).toBeLessThan(-4.5);
    expect(crown.x).toBeCloseTo(0, 3);

    const modal = body('G17\nG0 X10 Y0 Z0\nG3 X0 Y0 I-5 J0 F80\nX10 Y0 I5 J0');
    const modalPoints = g1Points(modal);
    expect(modal.match(/F80/g)).toHaveLength(1);
    expect(modalPoints.length).toBeGreaterThan(8);
    expect(modalPoints[modalPoints.length - 1].x).toBeCloseTo(10, 3);
    expect(modalPoints[modalPoints.length - 1].y).toBeCloseTo(0, 3);
  });
});

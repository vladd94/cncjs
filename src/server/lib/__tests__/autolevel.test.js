/* eslint-env jest */
import {
  createProbeXYPoints,
  applyProbeCompensation as applyProbeCompensationRaw,
  AUTOLEVEL_APPLIED_MARKER,
  AUTOLEVEL_REFERENCE_PREFIX,
} from '../autolevel';

// Strip the anti-double-apply marker and the traced reference height.
const applyProbeCompensation = (gcode, probeData, options) => {
  const result = applyProbeCompensationRaw(gcode, probeData, options);
  const lines = result.split('\n');
  expect(lines[0]).toBe(`; ${AUTOLEVEL_APPLIED_MARKER}`);
  expect(lines[1].startsWith(`; ${AUTOLEVEL_REFERENCE_PREFIX}`)).toBe(true);
  return lines.slice(2).join('\n');
};

describe('autolevel', () => {
  describe('createProbeXYPoints', () => {
    test('should generate 3x3 grid (9 points)', () => {
      const positions = createProbeXYPoints({
        startX: 0,
        endX: 20,
        stepX: 10,
        startY: 0,
        endY: 20,
        stepY: 10,
      });

      expect(positions).toHaveLength(9);
      expect(positions).toEqual([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 20, y: 0 },
        { x: 0, y: 10 },
        { x: 10, y: 10 },
        { x: 20, y: 10 },
        { x: 0, y: 20 },
        { x: 10, y: 20 },
        { x: 20, y: 20 },
      ]);
    });

    test('should generate points within range when end does not align with step', () => {
      const positions = createProbeXYPoints({
        startX: 0,
        endX: 35,
        stepX: 10,
        startY: 0,
        endY: 35,
        stepY: 10,
      });

      expect(positions).toEqual([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 20, y: 0 },
        { x: 30, y: 0 },
        { x: 0, y: 10 },
        { x: 10, y: 10 },
        { x: 20, y: 10 },
        { x: 30, y: 10 },
        { x: 0, y: 20 },
        { x: 10, y: 20 },
        { x: 20, y: 20 },
        { x: 30, y: 20 },
        { x: 0, y: 30 },
        { x: 10, y: 30 },
        { x: 20, y: 30 },
        { x: 30, y: 30 },
      ]);

      // Verify no point exceeds boundaries
      const maxX = Math.max(...positions.map(p => p.x));
      const maxY = Math.max(...positions.map(p => p.y));
      expect(maxX).toBeLessThanOrEqual(35);
      expect(maxY).toBeLessThanOrEqual(35);
    });
  });

  describe('applyProbeCompensation', () => {
    describe('error handling', () => {
      test('should reject fewer than 3 probe points', () => {
        const gcode = 'G0 X10 Y10 Z5';
        const probeData = [
          { x: 0, y: 0, z: 0 },
          { x: 10, y: 0, z: 0.1 },
        ];

        expect(() => applyProbeCompensation(gcode, probeData)).toThrow('At least 3');
      });

      test('should reject empty probe data', () => {
        const gcode = 'G0 X10 Y10 Z5';
        expect(() => applyProbeCompensation(gcode, [])).toThrow('At least 3');
      });
    });

    describe('Z compensation verification', () => {
      test('should apply zero compensation for flat surface at origin', () => {
        const gcode = 'G0 X0 Y0 Z1.000';
        const probeData = [
          { x: 0, y: 0, z: 0 },
          { x: 10, y: 0, z: 0 },
          { x: 0, y: 10, z: 0 },
        ];

        const result = applyProbeCompensation(gcode, probeData);

        // At origin (0,0), surface is at Z=0, commanded Z=1 → compensated Z=1
        const expectedResult = 'G0 X0.000 Y0.000 Z1.000';
        expect(result).toEqual(expectedResult);
      });

      test('should compensate for tilted surface (Z increases with X)', () => {
        const gcode = 'G0 X0 Y0 Z0\nG0 X10 Y0 Z0';
        const probeData = [
          { x: 0, y: 0, z: 0 },
          { x: 10, y: 0, z: 1 },
          { x: 0, y: 10, z: 0 },
          { x: 10, y: 10, z: 1 },
        ];

        const result = applyProbeCompensation(gcode, probeData);
        const expectedResult = [
          'G0 X0.000 Y0.000 Z0.000',
          'G0 X5.000 Y0.000 Z0.500',
          'G0 X10.000 Y0.000 Z1.000',
        ].join('\n');
        expect(result).toEqual(expectedResult);
      });

      test('should correctly interpolate Z for point between probes', () => {
        const gcode = 'G0 X5 Y5 Z0';
        const probeData = [
          { x: 0, y: 0, z: 0 },
          { x: 10, y: 0, z: 0.2 },
          { x: 0, y: 10, z: 0.2 },
          { x: 10, y: 10, z: 0.4 },
        ];

        const result = applyProbeCompensation(gcode, probeData);

        // At (5,5), interpolated surface Z = 0.2mm (average of 4 corners)
        // Commanded Z=0 → compensated Z=0.2
        const expectedResult = 'G0 X5.000 Y5.000 Z0.200';
        expect(result).toEqual(expectedResult);
      });

      test('should apply negative compensation for a local low spot', () => {
        const gcode = 'G0 X10 Y0 Z0';
        const probeData = [
          { x: 0, y: 0, z: 0 },
          { x: 10, y: 0, z: -0.5 },
          { x: 0, y: 10, z: 0 },
          { x: 10, y: 10, z: -0.5 },
        ];

        const result = applyProbeCompensation(gcode, probeData);

        // Origin probe is 0. The X10 node is 0.5 mm lower, so commanded Z=0 → -0.5
        const expectedResult = 'G0 X10.000 Y0.000 Z-0.500';
        expect(result).toEqual(expectedResult);
      });

      test('should leave Z unchanged when every probe reading is the same constant', () => {
        const gcode = 'G0 X0 Y0 Z10';
        // Horizontal plane at the probe-device height, not a 2 mm surface error.
        const probeData = [
          { x: 0, y: 0, z: 2 },
          { x: 10, y: 0, z: 2 },
          { x: 0, y: 10, z: 2 },
          { x: 10, y: 10, z: 2 },
        ];

        const result = applyProbeCompensation(gcode, probeData);

        const expectedResult = 'G0 X0.000 Y0.000 Z10.000';
        expect(result).toEqual(expectedResult);
      });
    });

    describe('segment subdivision', () => {
      test('should subdivide long moves based on detected grid size', () => {
        const gcode = 'G0 X0 Y0 Z0\nG0 X50 Y0 Z0';
        // 10mm grid; two Y rows so the points form a lattice for bilinear interpolation
        const probeData = [
          { x: 0, y: 0, z: 0 },
          { x: 10, y: 0, z: 0.1 },
          { x: 20, y: 0, z: 0.2 },
          { x: 30, y: 0, z: 0.3 },
          { x: 40, y: 0, z: 0.4 },
          { x: 50, y: 0, z: 0.5 },
          { x: 0, y: 10, z: 0 },
          { x: 10, y: 10, z: 0.1 },
          { x: 20, y: 10, z: 0.2 },
          { x: 30, y: 10, z: 0.3 },
          { x: 40, y: 10, z: 0.4 },
          { x: 50, y: 10, z: 0.5 },
        ];

        const result = applyProbeCompensation(gcode, probeData);

        // Expected: First point + 10 subdivided segments
        expect(result).toEqual([
          'G0 X0.000 Y0.000 Z0.000',
          'G0 X5.000 Y0.000 Z0.050',
          'G0 X10.000 Y0.000 Z0.100',
          'G0 X15.000 Y0.000 Z0.150',
          'G0 X20.000 Y0.000 Z0.200',
          'G0 X25.000 Y0.000 Z0.250',
          'G0 X30.000 Y0.000 Z0.300',
          'G0 X35.000 Y0.000 Z0.350',
          'G0 X40.000 Y0.000 Z0.400',
          'G0 X45.000 Y0.000 Z0.450',
          'G0 X50.000 Y0.000 Z0.500',
        ].join('\n'));
      });

      test('should not over-subdivide short moves', () => {
        const gcode = 'G0 X0 Y0 Z0\nG0 X2 Y0 Z0';
        // 10mm grid → segment length = 5mm → 2mm move not subdivided (< 5mm)
        const probeData = [
          { x: 0, y: 0, z: 0 },
          { x: 10, y: 0, z: 0.1 },
          { x: 0, y: 10, z: 0 },
          { x: 10, y: 10, z: 0.1 },
        ];

        const result = applyProbeCompensation(gcode, probeData);

        // Short 2mm move should output only 2 points (no subdivision)
        expect(result).toEqual([
          'G0 X0.000 Y0.000 Z0.000',
          'G0 X2.000 Y0.000 Z0.020',
        ].join('\n'));
      });
    });

    describe('output format', () => {
      test('should format coordinates to 3 decimal places', () => {
        // Stay inside the probe grid so formatting is not coupled to edge clamping.
        const gcode = 'G0 X9.123456 Y19.987654 Z0.555555';
        const probeData = [
          { x: 0, y: 0, z: 0 },
          { x: 10, y: 0, z: 0.1 },
          { x: 0, y: 20, z: 0.2 },
          { x: 10, y: 20, z: 0.15 },
        ];

        const result = applyProbeCompensation(gcode, probeData);

        // All coordinates should be formatted to exactly 3 decimal places
        expect(result).toMatch(/^G0 X9\.123 Y19\.988 Z0\.\d{3}$/);
      });

      test('should preserve non-coordinate parameters (F, S, etc)', () => {
        const gcode = 'G1 X0 Y0 Z10 F1000 S5000';
        const probeData = [
          { x: 0, y: 0, z: 2 },
          { x: 10, y: 0, z: 2 },
          { x: 0, y: 10, z: 2 },
          { x: 10, y: 10, z: 2 },
        ];

        const result = applyProbeCompensation(gcode, probeData);

        // Feedrate and spindle speed should be preserved
        expect(result).toEqual([
          'G1 F1000 S5000 X0.000 Y0.000 Z10.000',
        ].join('\n'));
      });
    });

    describe('probe data format', () => {
      test('should extract x,y,z from 9-column format', () => {
        const gcode = 'G0 X10 Y10 Z0';
        const probeData = [
          { x: 0, y: 0, z: 0, a: 1, b: 2, c: 3, u: 4, v: 5, w: 6 },
          { x: 10, y: 0, z: 0.1, a: 1, b: 2, c: 3, u: 4, v: 5, w: 6 },
          { x: 0, y: 10, z: 0.2, a: 1, b: 2, c: 3, u: 4, v: 5, w: 6 },
          { x: 10, y: 10, z: 0.15, a: 1, b: 2, c: 3, u: 4, v: 5, w: 6 },
        ];

        const result = applyProbeCompensation(gcode, probeData);

        // Should apply compensation using only x,y,z (a,b,c,u,v,w ignored)
        expect(result).toEqual([
          'G0 X10.000 Y10.000 Z0.150',
        ].join('\n'));
      });
    });

    describe('bilinear interpolation', () => {
      // Bilinear reproduces any tilted plane exactly, even off the grid nodes.
      test('is exact on a tilted plane at a non-node point', () => {
        const gcode = 'G0 X7 Y13 Z0';
        const probeData = [ // surface z = 0.1 * x
          { x: 0, y: 0, z: 0 },
          { x: 20, y: 0, z: 2 },
          { x: 0, y: 20, z: 0 },
          { x: 20, y: 20, z: 2 },
        ];

        const result = applyProbeCompensation(gcode, probeData);

        // True surface at x=7 is 0.7
        expect(result).toBe('G0 X7.000 Y13.000 Z0.700');
      });

      // The decisive case: at a saddle's center bilinear returns the average of
      // all four corners (0.5). A 3-point plane fit ignores the 4th corner and
      // would return 1.0 here.
      test('returns the four-corner average at a saddle center', () => {
        const gcode = 'G0 X5 Y5 Z0';
        const probeData = [
          { x: 0, y: 0, z: 0 },
          { x: 10, y: 0, z: 1 },
          { x: 0, y: 10, z: 1 },
          { x: 10, y: 10, z: 0 },
        ];

        const result = applyProbeCompensation(gcode, probeData);

        expect(result).toBe('G0 X5.000 Y5.000 Z0.500');
      });

      // Cell indexing must work beyond the first cell.
      test('interpolates within the correct cell on a 3x3 grid', () => {
        const gcode = 'G0 X15 Y5 Z0'; // second cell in X; surface z = x / 10
        const probeData = [];
        for (const y of [0, 10, 20]) {
          for (const x of [0, 10, 20]) {
            probeData.push({ x, y, z: x / 10 });
          }
        }

        const result = applyProbeCompensation(gcode, probeData);

        // Between x=10 (z=1) and x=20 (z=2), at x=15 -> 1.5
        expect(result).toBe('G0 X15.000 Y5.000 Z1.500');
      });

      // Bilinear is continuous across cell boundaries (unlike the plane fit,
      // whose nearest-3 set switches there and can jump).
      test('is continuous across a grid cell boundary', () => {
        const probeData = [ // tent in X: peak at x=10, zero at x=0 and x=20
          { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 1 }, { x: 20, y: 0, z: 0 },
          { x: 0, y: 10, z: 0 }, { x: 10, y: 10, z: 1 }, { x: 20, y: 10, z: 0 },
        ];
        const zOf = (gcode) => {
          const out = applyProbeCompensation(gcode, probeData);
          return parseFloat(out.match(/Z(-?\d+\.\d+)/)[1]);
        };

        const left = zOf('G0 X9.99 Y5 Z0');
        const right = zOf('G0 X10.01 Y5 Z0');

        expect(Math.abs(left - right)).toBeLessThan(0.005);
      });

      // Scattered (non-lattice) probe data falls back to the plane fit.
      test('falls back to plane fit when probe points are not a grid', () => {
        const gcode = 'G0 X4 Y4 Z0';
        const probeData = [ // three scattered points on the plane z = 0.1 * x
          { x: 0, y: 0, z: 0 },
          { x: 10, y: 2, z: 1 },
          { x: 3, y: 12, z: 0.3 },
        ];

        const result = applyProbeCompensation(gcode, probeData);

        // Plane z = 0.1*x -> at x=4 -> 0.4
        expect(result).toBe('G0 X4.000 Y4.000 Z0.400');
      });
    });

    // A machine reports a probed XY quantised by its motor steps: the same
    // commanded Y comes back as 10.000 at one node and 9.999 at the next.
    // That 0.001 mm gap must not become the subdivision size.
    describe('quantised probe XY', () => {
      const saddleZ = (x, y) => (x / 10) * (y / 10); // bilinear and plane fit disagree here
      const exactGrid = [];
      for (const y of [0, 10, 20]) {
        for (const x of [0, 10, 20]) {
          exactGrid.push({ x, y, z: saddleZ(x, y) });
        }
      }
      // The middle row splits in two: its outer nodes read 0.001mm short of Y10.
      const quantisedGrid = exactGrid.map(p => (
        (p.y === 10 && p.x !== 10) ? { ...p, y: 9.999 } : p
      ));

      test('ignores a 0.001 mm quantisation gap when choosing the segment length', () => {
        const gcode = 'G0 X0 Y5 Z0\nG0 X20 Y5 Z0';
        const exact = applyProbeCompensation(gcode, exactGrid).split('\n');
        const quantised = applyProbeCompensation(gcode, quantisedGrid).split('\n');

        // 10mm grid -> 5mm segments -> the 20mm move splits into 4.
        expect(exact).toHaveLength(5);

        // The split row's 0.001 mm gap is noise next to the 10 mm pitch, so
        // the move stays a handful of lines instead of tens of thousands.
        expect(quantised.length).toBeLessThan(exact.length * 3);
      });

      test('throws instead of allocating millions of lines on a micron grid', () => {
        const probeData = [
          { x: 0, y: 0, z: 0 },
          { x: 0.01, y: 0, z: 0 },
          { x: 0, y: 0.01, z: 0 },
          { x: 0.01, y: 0.01, z: 0 },
        ];
        const gcode = 'G0 X0 Y0 Z0\nG1 X200 Y0 Z0';

        expect(() => applyProbeCompensation(gcode, probeData)).toThrow(/running out of memory/);
      });

      test('punches holes in the lattice, falling back to the plane fit', () => {
        const gcode = 'G0 X5 Y5 Z0';

        // Bilinear over an intact cell: the four-corner average.
        expect(applyProbeCompensation(gcode, exactGrid)).toBe('G0 X5.000 Y5.000 Z0.250');

        // Neither of the two near-duplicate rows is complete, so no cell has
        // all four corners, and the plane fit through Y0 and the Y9.999 nodes
        // reports the surface as flat. What matters is that the compensation
        // is gone, not the exact figure the fallback degrades to.
        const degraded = applyProbeCompensation(gcode, quantisedGrid);
        const degradedZ = Number(/Z(-?[\d.]+)/.exec(degraded)[1]);
        expect(Math.abs(degradedZ)).toBeLessThan(0.05);
      });
    });

    describe('reference probe height', () => {
      // X rises by 0.21436 over 10 mm, so the midpoint is reference + 0.10718.
      const reference = 1.653;
      const surfaceDelta = 0.10718;
      const probeData = [
        { x: 0, y: 0, z: reference },
        { x: 10, y: 0, z: reference + (2 * surfaceDelta) },
        { x: 0, y: 10, z: reference },
        { x: 10, y: 10, z: reference + (2 * surfaceDelta) },
      ];
      const zOf = (gcode, options) => {
        const line = applyProbeCompensation(gcode, probeData, options);
        return Number(/Z(-?\d+\.\d+)/.exec(line)[1]);
      };

      test('subtracts the work-origin probe height instead of adding the raw reading', () => {
        // interpolated probe at X5 is 1.76018; raw addition would produce Z1.460
        expect(zOf('G0 X5 Y0 Z-0.300')).toBeCloseTo(-0.193, 3);
        // raw addition would produce Z-1.440
        expect(zOf('G1 X5 Y0 Z-3.200')).toBeCloseTo(-3.093, 3);
      });

      test('keeps a flat probe map of any constant from shifting programmed Z', () => {
        const flat = [
          { x: 0, y: 0, z: 1.653 },
          { x: 10, y: 0, z: 1.653 },
          { x: 0, y: 10, z: 1.653 },
          { x: 10, y: 10, z: 1.653 },
        ];
        const anotherFlat = flat.map(point => ({ ...point, z: 2 }));

        expect(applyProbeCompensation('G1 X5 Y5 Z-3.200', flat)).toBe('G1 X5.000 Y5.000 Z-3.200');
        expect(applyProbeCompensation('G1 X5 Y5 Z-3.200', anotherFlat)).toBe('G1 X5.000 Y5.000 Z-3.200');
      });

      test('lowers Z by the amount the local probe sits below the reference', () => {
        const low = [
          { x: 0, y: 0, z: 1.653 },
          { x: 10, y: 0, z: 1.500 },
          { x: 0, y: 10, z: 1.653 },
          { x: 10, y: 10, z: 1.500 },
        ];

        expect(applyProbeCompensation('G1 X10 Y0 Z-3.200', low)).toBe('G1 X10.000 Y0.000 Z-3.353');
      });

      test('shifts a tab and the contour by the same local delta', () => {
        const result = applyProbeCompensation([
          'G0 X5 Y0 Z-3.200',
          'G1 X5 Y0 Z-2.450',
        ].join('\n'), probeData);
        const zs = result.split('\n').map(line => Number(/Z(-?\d+\.\d+)/.exec(line)[1]));

        expect(zs[0]).toBeCloseTo(-3.093, 3);
        expect(zs[1] - zs[0]).toBeCloseTo(0.75, 3);
        expect(zs[0]).not.toBeCloseTo(-1.44, 2);
      });

      test('refuses to invent a reference when the map misses the work origin', () => {
        const offset = probeData.map(point => ({ ...point, x: point.x + 20, y: point.y + 20 }));

        expect(() => applyProbeCompensation('G1 X25 Y25 Z-3.200', offset)).toThrow(/work origin/);
        expect(applyProbeCompensation('G1 X25 Y25 Z-0.300', offset, { referenceProbeZ: reference }))
          .toMatch(/Z-0\.193/);
      });
    });
  });
});

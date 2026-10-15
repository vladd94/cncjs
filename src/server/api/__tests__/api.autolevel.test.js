/* eslint-env jest */
import store from '../../store';
import { apply } from '../api.autolevel';

const response = () => {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
    },
  };
  return res;
};

const map = [
  { x: 0, y: 0, z: 0 },
  { x: 10, y: 0, z: -0.2 },
  { x: 0, y: 10, z: 0 },
  { x: 10, y: 10, z: -0.2 },
];

describe('autolevel apply API', () => {
  afterEach(() => {
    store.unset('controllers');
  });

  test('uses the touch-plate XY recorded after probing', () => {
    store.set('controllers', {
      machine: { probeState: { cuttingZeroX: 10, cuttingZeroY: 0 } },
    });
    const res = response();
    apply({
      body: {
        gcode: 'G90\nG1 X0 Y0 Z-1',
        probeData: map,
        normalized: true,
      },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.compensatedGcode).toContain('Z-0.800');
  });

  test('keeps the first probe point when cutting Z0 was not recorded', () => {
    const res = response();
    apply({
      body: {
        gcode: 'G90\nG1 X10 Y0 Z-1',
        probeData: map,
        normalized: true,
      },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.compensatedGcode).toContain('Z-1.200');
  });

  test('rejects an off-map cutting Z0 instead of clamping the surface', () => {
    store.set('controllers', {
      machine: { probeState: { cuttingZeroX: 80, cuttingZeroY: 0 } },
    });
    const res = response();
    apply({
      body: {
        gcode: 'G90\nG1 X0 Y0 Z-1',
        probeData: map,
        normalized: true,
      },
    }, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.msg).toMatch(/outside the probe map/);
  });
});

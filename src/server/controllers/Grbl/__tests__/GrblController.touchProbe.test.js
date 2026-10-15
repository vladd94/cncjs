/* eslint-env jest */
import GrblController from '../GrblController';
import { createController } from '../../__tests__/helpers/createController';

const activeControllers = [];

const setup = () => {
  const { controller, writes } = createController(GrblController);
  clearInterval(controller.queryTimer);
  activeControllers.push(controller);
  return { controller, writes };
};

const linesOf = (writes) => writes.map(write => write.data);

const offsetLines = (writes) => linesOf(writes).filter(line => (
  line.startsWith('G10') || line.startsWith('G43')
));

const setMachine = (controller, {
  wcs = 'G54',
  units = 'G21',
  z = '0.000',
  pinState = '',
  reportInches = false,
} = {}) => {
  const state = controller.runner.state || {};
  controller.runner.state = {
    ...state,
    status: {
      ...(state.status || {}),
      activeState: 'Idle',
      pinState,
      mpos: { x: '0.000', y: '0.000', z },
      wpos: { x: '0.000', y: '0.000', z },
    },
    parserstate: {
      ...(state.parserstate || {}),
      modal: {
        ...((state.parserstate && state.parserstate.modal) || {}),
        units,
        wcs,
        distance: 'G90',
      },
    },
  };
  controller.runner.settings = {
    ...(controller.runner.settings || {}),
    settings: {
      ...((controller.runner.settings && controller.runner.settings.settings) || {}),
      $13: reportInches ? '1' : '0',
    },
  };
};

const params = (overrides = {}) => ({
  probeDepth: 10,
  probeFeedrate: 50,
  fineFeedrate: 10,
  probeRetract: 1,
  touchPlateHeight: 9,
  retractionDistance: 4,
  useTLO: false,
  ...overrides,
});

const emitPrb = (controller, z, result = 1) => {
  const status = controller.runner.state.status || {};
  controller.runner.state.status = {
    ...status,
    mpos: status.mpos || { x: '0.000', y: '0.000', z: '0.000' },
    wpos: status.wpos || { x: '0.000', y: '0.000', z: '0.000' },
  };
  const mpos = controller.runner.state.status.mpos;
  controller.runner.emit('parameters', {
    raw: `[PRB:${mpos.x},${mpos.y},${z}:${result}]`,
    name: 'PRB',
    value: { result, x: String(mpos.x), y: String(mpos.y), z: String(z) },
  });
};

const pump = (controller, writes, seen) => {
  let guard = 0;
  while (!linesOf(writes).includes(seen) && guard < 20) {
    controller.runner.parse('ok');
    guard += 1;
  }
  expect(linesOf(writes)).toContain(seen);
};

const reachRelease = (controller, writes, coarseLine) => {
  pump(controller, writes, coarseLine);
  emitPrb(controller, -2);
  pump(controller, writes, '?');
  controller.ready = true;
  controller.initialized = true;
};

const finishZero = (controller) => {
  controller.runner.parse('ok');
  controller.runner.parse('ok');
  controller.runner.parse('ok');
};

describe('Grbl touch-plate Z probe', () => {
  afterEach(() => {
    while (activeControllers.length > 0) {
      activeControllers.pop().destroy();
    }
  });

  test('only the fine contact sets Z, then the final retract runs', () => {
    const { controller, writes } = setup();
    setMachine(controller);
    const zBefore = controller.runner.getWorkPosition().z;

    controller.command('probe:z', params());
    reachRelease(controller, writes, 'G38.2 Z-10 F50\n');

    expect(controller.probeState.probePhase).toBe('fine');
    expect(controller.probeState.probedPositions).toEqual([]);
    expect(offsetLines(writes)).toEqual([]);
    expect(linesOf(writes)).toContain('G91\n');
    expect(linesOf(writes)).toContain('G0 Z1\n');
    expect(linesOf(writes)).toContain('G90\n');
    expect(linesOf(writes).indexOf('G90\n')).toBeGreaterThan(linesOf(writes).indexOf('G91\n'));
    expect(controller.runner.getWorkPosition().z).toBe(zBefore);

    controller.runner.parse('<Idle|MPos:0.000,0.000,1.000|FS:0,0>');

    expect(linesOf(writes)).toContain('G38.2 Z-0.5 F10\n');
    expect(linesOf(writes)).not.toContain('G38.2 Z-10 F10\n');
    expect(offsetLines(writes)).toEqual([]);

    emitPrb(controller, -1.25);
    expect(offsetLines(writes)).toEqual([]);

    finishZero(controller);

    const sent = linesOf(writes);
    const g10 = sent.indexOf('G10 L20 P1 Z9\n');
    expect(sent.slice(g10)).toEqual([
      'G10 L20 P1 Z9\n',
      'G90\n',
      'G0 Z13\n',
    ]);
    expect(sent[g10]).not.toMatch(/[XY]/);
    expect(sent.slice(g10)).not.toContain('G91\n');
    expect(controller.probeState.probedPositions).toEqual([]);
    expect(controller.probeState.touchZero).toBe(null);
    expect(controller.runner.getModalGroup().distance).toBe('G90');

    emitPrb(controller, -1.25);
    expect(offsetLines(writes)).toEqual(['G10 L20 P1 Z9\n']);
  });

  test('a failed coarse probe does not set Z or start the fine probe', () => {
    const { controller, writes } = setup();
    setMachine(controller, { z: '5.000' });
    const zBefore = controller.runner.getWorkPosition().z;

    controller.command('probe:z', params());
    pump(controller, writes, 'G38.2 Z-10 F50\n');
    emitPrb(controller, -2, 0);
    controller.runner.parse('ok');

    expect(offsetLines(writes)).toEqual([]);
    expect(linesOf(writes)).not.toContain('G38.2 Z-0.5 F10\n');
    expect(linesOf(writes)).not.toContain('G0 Z13\n');
    expect(controller.probeState.probePhase).toBe(null);
    expect(controller.probeState.touchZero).toBe(null);
    expect(controller.probeState.probedPositions).toEqual([]);
    expect(controller.feeder.size()).toBe(0);
    expect(controller.runner.getWorkPosition().z).toBe(zBefore);
  });

  test('a feeder error during the coarse probe does not fall through to G10', () => {
    const { controller, writes } = setup();
    setMachine(controller);
    const zBefore = controller.runner.getWorkPosition().z;

    controller.command('probe:z', params());
    pump(controller, writes, 'G38.2 Z-10 F50\n');
    controller.runner.emit('error', { raw: 'error:5', message: '5' });
    controller.runner.parse('ok');

    expect(offsetLines(writes)).toEqual([]);
    expect(linesOf(writes)).not.toContain('G0 Z1\n');
    expect(controller.feeder.size()).toBe(0);
    expect(controller.probeState.touchZero).toBe(null);
    expect(controller.runner.getWorkPosition().z).toBe(zBefore);
  });

  test('a probe that stays triggered after the retract does not set Z', () => {
    const { controller, writes } = setup();
    setMachine(controller);
    const zBefore = controller.runner.getWorkPosition().z;

    controller.command('probe:z', params());
    reachRelease(controller, writes, 'G38.2 Z-10 F50\n');
    controller.runner.parse('<Idle|MPos:0.000,0.000,1.000|FS:0,0|Pn:P>');
    controller.runner.parse('<Idle|MPos:0.000,0.000,1.001|FS:0,0|Pn:P>');
    controller.runner.parse('ok');

    expect(linesOf(writes).filter(line => line.startsWith('G38.2'))).toEqual([
      'G38.2 Z-10 F50\n',
    ]);
    expect(offsetLines(writes)).toEqual([]);
    expect(linesOf(writes)).not.toContain('G0 Z13\n');
    expect(controller.probeState.probePhase).toBe(null);
    expect(controller.probeState.touchZero).toBe(null);
    expect(controller.runner.getWorkPosition().z).toBe('1.001');
    expect(zBefore).toBe('0.000');
  });

  test('a failed fine probe does not use the coarse contact to set Z', () => {
    const { controller, writes } = setup();
    setMachine(controller);
    const zBefore = controller.runner.getWorkPosition().z;

    controller.command('probe:z', params());
    reachRelease(controller, writes, 'G38.2 Z-10 F50\n');
    controller.runner.parse('<Idle|MPos:0.000,0.000,1.000|FS:0,0>');
    expect(linesOf(writes)).toContain('G38.2 Z-0.5 F10\n');

    const zAtFine = controller.runner.getWorkPosition().z;
    emitPrb(controller, -1.25, 0);
    controller.runner.parse('ok');

    expect(offsetLines(writes)).toEqual([]);
    expect(linesOf(writes)).not.toContain('G0 Z13\n');
    expect(controller.probeState.touchZero).toBe(null);
    expect(controller.probeState.probedPositions).toEqual([]);
    expect(controller.runner.getWorkPosition().z).toBe(zAtFine);
    expect(zBefore).toBe('0.000');
  });

  test('a stuck probe pin refuses to start and does not change Z', () => {
    const { controller, writes } = setup();
    setMachine(controller, { pinState: 'P', z: '4.000' });
    const zBefore = controller.runner.getWorkPosition().z;

    controller.command('probe:z', params());
    controller.runner.parse('ok');

    expect(writes).toEqual([]);
    expect(offsetLines(writes)).toEqual([]);
    expect(controller.probeState.probePhase).toBe(null);
    expect(controller.probeState.touchZero).toBe(null);
    expect(controller.runner.getWorkPosition().z).toBe(zBefore);
  });

  test('the fine search is 1.5 times the probe retract, not the probe depth', () => {
    const { controller, writes } = setup();
    setMachine(controller);

    controller.command('probe:z', params({ probeRetract: 1, probeDepth: 10 }));
    reachRelease(controller, writes, 'G38.2 Z-10 F50\n');
    controller.runner.parse('<Idle|MPos:0.000,0.000,1.000|FS:0,0>');

    expect(linesOf(writes)).toContain('G38.2 Z-0.5 F10\n');
    expect(linesOf(writes)).not.toContain('G38.2 Z-10 F10\n');
  });

  test('an alarm during the relative probe restores G90 and does not set Z', () => {
    const { controller, writes } = setup();
    setMachine(controller);
    const zBefore = controller.runner.getWorkPosition().z;

    controller.command('probe:z', params());
    expect(linesOf(writes)).toEqual(['G91\n']);
    expect(controller.probeState.distanceModeRestorePending).toBe(true);

    controller.runner.parse('ALARM:5');
    expect(linesOf(writes)).toEqual(['G91\n']);
    expect(offsetLines(writes)).toEqual([]);
    expect(controller.runner.getWorkPosition().z).toBe(zBefore);

    controller.runner.parse('<Idle|MPos:0.000,0.000,0.000|FS:0,0>');
    expect(linesOf(writes)).toContain('G90\n');
    expect(offsetLines(writes)).toEqual([]);
    expect(controller.runner.getModalGroup().distance).toBe('G90');
    expect(controller.probeState.distanceModeRestorePending).toBe(false);
    expect(controller.runner.getWorkPosition().z).toBe(zBefore);
  });

  test('G55 selects G10 L20 P2 and does not change X or Y', () => {
    const { controller, writes } = setup();
    setMachine(controller, { wcs: 'G55' });

    controller.command('probe:z', params());
    reachRelease(controller, writes, 'G38.2 Z-10 F50\n');
    controller.runner.parse('<Idle|MPos:0.000,0.000,1.000|FS:0,0>');
    emitPrb(controller, -1.25);
    finishZero(controller);

    const g10 = linesOf(writes).find(line => line.startsWith('G10'));
    expect(g10).toBe('G10 L20 P2 Z9\n');
    expect(g10).not.toMatch(/[XY]/);
  });

  test('tool length offset is calculated from the fine contact only', () => {
    const { controller, writes } = setup();
    setMachine(controller);

    controller.command('probe:z', params({ useTLO: true }));
    expect(linesOf(writes)[0]).toBe('G49\n');

    pump(controller, writes, 'G38.2 Z-10 F50\n');
    emitPrb(controller, -1);
    expect(offsetLines(writes)).toEqual([]);

    pump(controller, writes, '?');
    controller.ready = true;
    controller.initialized = true;
    controller.runner.parse('<Idle|MPos:0.000,0.000,1.000|FS:0,0>');
    emitPrb(controller, -1.5);
    expect(offsetLines(writes)).toEqual([]);

    finishZero(controller);

    expect(linesOf(writes)).toContain('G43.1 Z-10.5\n');
    expect(linesOf(writes)).not.toContain('G43.1 Z-10\n');
    expect(linesOf(writes)).not.toContain('G10 L20 P1 Z9\n');
    expect(linesOf(writes)).toContain('G0 Z13\n');
    expect(controller.probeState.probedPositions).toEqual([]);
  });

  test('inch settings stay in inches, and an inch status report is converted to mm', () => {
    const inch = setup();
    setMachine(inch.controller, { units: 'G20', z: '1.000', reportInches: true });
    inch.controller.command('probe:z', params({
      probeDepth: 0.4,
      probeFeedrate: 2,
      fineFeedrate: 0.4,
      probeRetract: 0.04,
      touchPlateHeight: 0.35,
      retractionDistance: 0.15,
    }));
    reachRelease(inch.controller, inch.writes, 'G38.2 Z-0.4 F2\n');
    expect(linesOf(inch.writes)).toContain('G0 Z0.04\n');
    inch.controller.runner.parse('<Idle|MPos:0.000,0.000,0.900|FS:0,0>');
    expect(linesOf(inch.writes)).toContain('G38.2 Z0.84 F0.4\n');
    expect(linesOf(inch.writes)).not.toContain('G38.2 Z-0.4 F0.4\n');
    emitPrb(inch.controller, 0.5);
    finishZero(inch.controller);
    expect(linesOf(inch.writes)).toContain('G10 L20 P1 Z0.35\n');
    expect(linesOf(inch.writes)).toContain('G0 Z0.5\n');

    const mixed = setup();
    setMachine(mixed.controller, { units: 'G21', z: '1.000', reportInches: true });
    mixed.controller.command('probe:z', params());
    reachRelease(mixed.controller, mixed.writes, 'G38.2 Z-10 F50\n');
    mixed.controller.runner.parse('<Idle|MPos:0.000,0.000,1.000|FS:0,0>');
    expect(linesOf(mixed.writes)).toContain('G38.2 Z23.9 F10\n');
    expect(linesOf(mixed.writes)).not.toContain('G38.2 Z-10 F10\n');
  });

  test('the final retract is not sent when zeroing does not succeed', () => {
    const { controller, writes } = setup();
    setMachine(controller);
    controller.command('probe:z', params({ retractionDistance: 4 }));
    reachRelease(controller, writes, 'G38.2 Z-10 F50\n');
    expect(linesOf(writes)).toContain('G0 Z1\n');
    expect(linesOf(writes)).not.toContain('G0 Z13\n');

    controller.runner.parse('<Idle|MPos:0.000,0.000,1.000|FS:0,0>');
    emitPrb(controller, -1.25, 0);

    expect(linesOf(writes)).not.toContain('G0 Z13\n');
    expect(offsetLines(writes)).toEqual([]);
  });

  test('work Z is unchanged after coarse failure, a stuck pin, and fine failure', () => {
    const coarse = setup();
    setMachine(coarse.controller, { z: '8.000' });
    const coarseZ = coarse.controller.runner.getWorkPosition().z;
    coarse.controller.command('probe:z', params());
    pump(coarse.controller, coarse.writes, 'G38.2 Z-10 F50\n');
    emitPrb(coarse.controller, -3, 0);
    coarse.controller.runner.parse('ok');
    expect(offsetLines(coarse.writes)).toEqual([]);
    expect(coarse.controller.runner.getWorkPosition().z).toBe(coarseZ);

    const stuck = setup();
    setMachine(stuck.controller, { pinState: 'XYZP', z: '8.000' });
    const stuckZ = stuck.controller.runner.getWorkPosition().z;
    stuck.controller.command('probe:z', params());
    stuck.controller.runner.parse('ok');
    expect(stuck.writes).toEqual([]);
    expect(offsetLines(stuck.writes)).toEqual([]);
    expect(stuck.controller.runner.getWorkPosition().z).toBe(stuckZ);

    const fine = setup();
    setMachine(fine.controller, { z: '8.000' });
    const fineZ = fine.controller.runner.getWorkPosition().z;
    fine.controller.command('probe:z', params());
    reachRelease(fine.controller, fine.writes, 'G38.2 Z-10 F50\n');
    fine.controller.runner.parse('<Idle|MPos:0.000,0.000,1.000|FS:0,0|WPos:0.000,0.000,8.000>');
    emitPrb(fine.controller, -1, 0);
    fine.controller.runner.parse('ok');
    expect(offsetLines(fine.writes)).toEqual([]);
    expect(fine.controller.runner.getWorkPosition().z).toBe(fineZ);
  });
});

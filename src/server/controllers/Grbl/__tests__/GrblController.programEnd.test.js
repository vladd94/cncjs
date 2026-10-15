/* eslint-env jest */
import GrblController from '../GrblController';
import { createController } from '../../__tests__/helpers/createController';
import {
  WORKFLOW_STATE_IDLE,
  WORKFLOW_STATE_PAUSED,
  WORKFLOW_STATE_RUNNING,
} from '../../../lib/Workflow';

const activeControllers = [];

const status = (activeState, x = '10.000', y = '10.000', z = '0.000') => (
  `<${activeState}|MPos:${x},${y},${z}|FS:0,0|WCO:0.000,0.000,0.000>`
);

const createRunningController = () => {
  const { controller, writes } = createController(GrblController);
  controller.ready = true;
  controller.initialized = true;
  const stops = [];
  controller.workflow.on('stop', () => {
    stops.push(controller.workflow.state);
  });
  activeControllers.push(controller);
  return { controller, writes, stops };
};

const ackAll = (controller) => {
  let guard = 0;
  while (controller.sender.state.received < controller.sender.state.sent && guard < 50) {
    controller.runner.parse('ok');
    guard += 1;
  }
};

const loadAndFinishSending = (controller, gcode) => {
  controller.command('gcode:load', 'job.nc', gcode);
  controller.command('gcode:start');
  ackAll(controller);
  expect(controller.sender.state.received).toBe(controller.sender.state.total);
  expect(controller.sender.state.finishTime).toBeGreaterThan(0);
  expect(controller.workflow.state).toBe(WORKFLOW_STATE_RUNNING);
};

const advance = (ms) => {
  jest.advanceTimersByTime(ms);
};

const pollWhile = (controller, activeState, ms, position) => {
  const ticks = Math.ceil(ms / 250);
  for (let i = 0; i < ticks; i += 1) {
    const z = position ? position(i) : '0.000';
    controller.runner.parse(status(activeState, '10.000', '10.000', z));
    advance(250);
  }
};

describe('Grbl program completion', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    while (activeControllers.length > 0) {
      activeControllers.pop().destroy();
    }
    jest.useRealTimers();
  });

  test.each([
    ['M30', 'G0 X10 Y10\nM5\nM30'],
    ['M2', 'G0 X10 Y10\nM5\nM2'],
    ['EOF', 'G0 X10 Y10\nM5'],
  ])('%s finishes the workflow once Grbl is Idle', (name, gcode) => {
    const { controller, writes, stops } = createRunningController();
    loadAndFinishSending(controller, gcode);
    const writtenBeforeIdle = writes.map(write => write.data);

    controller.runner.parse('[MSG:Pgm End]');
    expect(controller.workflow.state).toBe(WORKFLOW_STATE_RUNNING);

    pollWhile(controller, 'Idle', 1000);

    expect(controller.workflow.state).toBe(WORKFLOW_STATE_IDLE);
    expect(stops).toEqual([WORKFLOW_STATE_IDLE]);
    expect(controller.actionTime.senderFinishTime).toBe(0);

    const extra = writes.map(write => write.data).slice(writtenBeforeIdle.length);
    expect(extra.every(data => data === '?' || data === '$G\n')).toBe(true);
    expect(extra.some(data => data.includes('G0') || data.includes('G28') || data.includes('G53') || data.includes('!') || data.includes('~'))).toBe(false);
    expect(extra.some(data => data.indexOf('\u0018') !== -1)).toBe(false);
  });

  test('does not stop while Grbl is still running', () => {
    const { controller, stops } = createRunningController();
    loadAndFinishSending(controller, 'G0 X10 Y10\nM30');

    pollWhile(controller, 'Run', 2000);

    expect(controller.workflow.state).toBe(WORKFLOW_STATE_RUNNING);
    expect(stops).toEqual([]);
    expect(controller.runner.isIdle()).toBe(false);
  });

  test('does not stop while Grbl is holding', () => {
    const { controller, stops } = createRunningController();
    loadAndFinishSending(controller, 'G0 X10 Y10\nM30');

    pollWhile(controller, 'Hold:0', 2000);

    expect(controller.workflow.state).toBe(WORKFLOW_STATE_RUNNING);
    expect(stops).toEqual([]);
    expect(controller.runner.state.status.activeState).toBe('Hold');
  });

  test('waits through Run status and stops on a later Idle', () => {
    const { controller, stops } = createRunningController();
    loadAndFinishSending(controller, 'G0 X10 Y10\nM30');

    pollWhile(controller, 'Run', 1000);
    expect(controller.workflow.state).toBe(WORKFLOW_STATE_RUNNING);

    controller.runner.parse(status('Idle'));
    advance(250);
    expect(controller.workflow.state).toBe(WORKFLOW_STATE_RUNNING);

    advance(750);
    expect(controller.workflow.state).toBe(WORKFLOW_STATE_IDLE);
    expect(stops).toEqual([WORKFLOW_STATE_IDLE]);
  });

  test('a changing work position keeps the workflow running until the position is stable', () => {
    const { controller, stops } = createRunningController();
    loadAndFinishSending(controller, 'G0 X10 Y10\nM5\nM30');

    controller.runner.parse(status('Idle', '27.591', '0.000', '-2.900'));
    controller.state = {
      ...controller.runner.state,
      status: {
        ...controller.runner.state.status,
        wpos: { x: '0.000', y: '0.000', z: '0.000' },
      },
    };
    expect(controller.runner.getWorkPosition(controller.state)).not.toEqual(
      controller.runner.getWorkPosition(controller.runner.state)
    );

    pollWhile(controller, 'Idle', 2000, (i) => ((i % 2) ? '-2.901' : '-2.900'));

    expect(controller.workflow.state).toBe(WORKFLOW_STATE_RUNNING);
    expect(stops).toEqual([]);

    pollWhile(controller, 'Idle', 1500);
    expect(controller.workflow.state).toBe(WORKFLOW_STATE_IDLE);
    expect(stops).toEqual([WORKFLOW_STATE_IDLE]);
  });

  test('[MSG:Pgm End] does not finish the job by itself', () => {
    const { controller } = createRunningController();
    loadAndFinishSending(controller, 'G0 X10 Y10\nM30');

    controller.runner.parse('[MSG:Pgm End]');
    advance(2000);

    expect(controller.workflow.state).toBe(WORKFLOW_STATE_RUNNING);
    expect(controller.runner.state.status.activeState).toBe('');
  });

  test('an Idle already current when the sender ends finishes after the position stays put', () => {
    const { controller, stops } = createRunningController();

    controller.runner.parse(status('Idle'));
    expect(controller.runner.isIdle()).toBe(true);

    loadAndFinishSending(controller, 'G0 X10 Y10\nM30');
    advance(250);
    expect(controller.workflow.state).toBe(WORKFLOW_STATE_RUNNING);
    expect(stops).toEqual([]);

    advance(750);
    expect(controller.workflow.state).toBe(WORKFLOW_STATE_IDLE);
    expect(stops).toEqual([WORKFLOW_STATE_IDLE]);
  });

  test('a second program starts after the first workflow is idle', () => {
    const { controller, stops } = createRunningController();
    loadAndFinishSending(controller, 'G0 X10 Y10\nM30');
    pollWhile(controller, 'Idle', 1000);
    expect(controller.workflow.state).toBe(WORKFLOW_STATE_IDLE);

    controller.command('gcode:start');
    expect(controller.workflow.state).toBe(WORKFLOW_STATE_RUNNING);
    ackAll(controller);
    pollWhile(controller, 'Run', 500);
    expect(controller.workflow.state).toBe(WORKFLOW_STATE_RUNNING);

    pollWhile(controller, 'Idle', 1000);
    expect(controller.workflow.state).toBe(WORKFLOW_STATE_IDLE);
    expect(stops).toEqual([WORKFLOW_STATE_IDLE, WORKFLOW_STATE_IDLE]);
  });

  test('does not finish while an acknowledgement is still missing', () => {
    const { controller, stops } = createRunningController();
    const gcode = Array.from({ length: 10 }, (_, index) => `G0 X${index}`).join('\n');

    controller.command('gcode:load', 'job.nc', gcode);
    controller.command('gcode:start');
    for (let i = 0; i < 9; i += 1) {
      controller.runner.parse('ok');
    }

    expect(controller.sender.state.sent).toBe(11);
    expect(controller.sender.state.total).toBe(11);
    expect(controller.sender.state.received).toBe(9);
    expect(controller.sender.state.finishTime).toBe(0);
    expect(controller.actionTime.senderFinishTime).toBe(0);
    expect(controller.workflow.state).toBe(WORKFLOW_STATE_RUNNING);

    controller.runner.parse(status('Idle'));
    advance(2000);

    expect(controller.workflow.state).toBe(WORKFLOW_STATE_RUNNING);
    expect(stops).toEqual([]);
  });

  test('does not finish before the last line has been sent', () => {
    const { controller, stops } = createRunningController();
    const gcode = Array.from({ length: 10 }, () => 'G0 X12345678').join('\n');

    controller.command('gcode:load', 'job.nc', gcode);
    controller.command('gcode:start');

    expect(controller.sender.state.total).toBe(11);
    expect(controller.sender.state.sent).toBe(9);

    controller.runner.parse(status('Idle'));
    advance(2000);

    expect(controller.workflow.state).toBe(WORKFLOW_STATE_RUNNING);
    expect(stops).toEqual([]);
    expect(controller.actionTime.senderFinishTime).toBe(0);
  });

  test('a stale Idle before Sender end does not finish the job', () => {
    const { controller, stops } = createRunningController();
    const gcode = Array.from({ length: 10 }, (_, index) => `G0 X${index}`).join('\n');

    controller.runner.parse(status('Idle'));
    controller.command('gcode:load', 'job.nc', gcode);
    controller.command('gcode:start');
    expect(controller.sender.state.sent).toBe(controller.sender.state.total);
    expect(controller.sender.state.finishTime).toBe(0);

    advance(2000);

    expect(controller.workflow.state).toBe(WORKFLOW_STATE_RUNNING);
    expect(stops).toEqual([]);
  });

  test('a fresh Hold after the last line is sent does not finish the job', () => {
    const { controller, stops } = createRunningController();
    const gcode = Array.from({ length: 10 }, (_, index) => `G0 X${index}`).join('\n');

    controller.command('gcode:load', 'job.nc', gcode);
    controller.command('gcode:start');
    expect(controller.sender.state.sent).toBe(controller.sender.state.total);
    expect(controller.sender.state.finishTime).toBe(0);

    controller.runner.parse(status('Hold:0'));
    advance(2000);

    expect(controller.workflow.state).toBe(WORKFLOW_STATE_RUNNING);
    expect(stops).toEqual([]);
    expect(controller.runner.state.status.activeState).toBe('Hold');
  });

  test('a fresh Alarm after the last line is sent does not finish the job', () => {
    const { controller, stops } = createRunningController();
    const gcode = Array.from({ length: 10 }, (_, index) => `G0 X${index}`).join('\n');

    controller.command('gcode:load', 'job.nc', gcode);
    controller.command('gcode:start');
    expect(controller.sender.state.sent).toBe(controller.sender.state.total);
    expect(controller.sender.state.finishTime).toBe(0);

    controller.runner.parse(status('Alarm'));
    advance(2000);

    expect(controller.workflow.state).toBe(WORKFLOW_STATE_RUNNING);
    expect(stops).toEqual([]);
    expect(controller.runner.isIdle()).toBe(false);
  });

  test('a paused workflow does not finish after the last line is sent', () => {
    const { controller, stops } = createRunningController();
    const gcode = Array.from({ length: 10 }, (_, index) => `G0 X${index}`).join('\n');

    controller.command('gcode:load', 'job.nc', gcode);
    controller.command('gcode:start');
    expect(controller.sender.state.sent).toBe(controller.sender.state.total);
    expect(controller.sender.state.finishTime).toBe(0);

    controller.command('gcode:pause');
    expect(controller.workflow.state).toBe(WORKFLOW_STATE_PAUSED);

    controller.runner.parse(status('Idle'));
    advance(2000);

    expect(controller.workflow.state).toBe(WORKFLOW_STATE_PAUSED);
    expect(stops).toEqual([]);
  });
});

/* eslint-env jest */
import GrblController from '../GrblController';
import {
  WORKFLOW_STATE_IDLE,
  WORKFLOW_STATE_RUNNING,
} from '../../../lib/Workflow';
import { createController } from '../../__tests__/helpers/createController';
import { GRBL } from '../constants';

jest.mock('../../../lib/logger', () => {
  const createLogger = () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    verbose: jest.fn(),
    debug: jest.fn(),
    silly: jest.fn(),
  });
  return {
    __esModule: true,
    default: () => createLogger(),
    getLevel: jest.fn(() => 'info'),
    setLevel: jest.fn(),
  };
});

const createSocket = (id) => ({
  id,
  emit: jest.fn(),
  join: jest.fn(),
});

describe('GrblController socket reattach after disconnect', () => {
  test('addConnection on an open controller resyncs state without opening serial', () => {
    const { controller, writes } = createController(GrblController);
    const openSpy = jest.spyOn(controller, 'open');
    const startSpy = jest.spyOn(controller.workflow, 'start');
    const nextSpy = jest.spyOn(controller.sender, 'next');

    controller.state = {
      status: {
        activeState: 'Run',
        wpos: { x: 10, y: 20, z: 1 },
        mpos: { x: 10, y: 20, z: 1 },
      },
    };
    controller.settings = { settings: { $13: '0' } };
    controller.workflow.state = WORKFLOW_STATE_RUNNING;
    controller.sender.state = {
      ...controller.sender.state,
      name: 'job.nc',
      gcode: 'G0 X0\nM30',
      context: {},
      total: 2,
      sent: 1,
      received: 0,
    };

    const socketA = createSocket('socket-a');
    controller.addConnection(socketA);
    expect(controller.sockets['socket-a']).toBe(socketA);

    // Server disconnect path removes the old socket only.
    controller.removeConnection(socketA);
    expect(controller.sockets['socket-a']).toBeUndefined();
    expect(controller.isOpen()).toBe(true);

    const socketB = createSocket('socket-b');
    controller.addConnection(socketB);

    expect(openSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
    expect(nextSpy).not.toHaveBeenCalled();
    expect(writes).toEqual([]);

    expect(controller.sockets['socket-b']).toBe(socketB);
    expect(socketB.emit).toHaveBeenCalledWith('serialport:open', expect.objectContaining({
      port: '/dev/null',
      baudrate: 115200,
      controllerType: GRBL,
      inuse: true,
    }));
    expect(socketB.emit).toHaveBeenCalledWith('controller:state', GRBL, controller.state);
    expect(socketB.emit).toHaveBeenCalledWith('workflow:state', WORKFLOW_STATE_RUNNING);
    expect(socketB.emit).toHaveBeenCalledWith('sender:status', expect.any(Object));
    expect(socketB.emit).toHaveBeenCalledWith(
      'gcode:load',
      'job.nc',
      'G0 X0\nM30',
      expect.any(Object)
    );

    // Mid-job broadcast after reattach reaches only the new socket.
    const socketACallsAfterRemove = socketA.emit.mock.calls.length;
    controller.emit('controller:state', GRBL, {
      status: {
        activeState: 'Run',
        wpos: { x: 11, y: 20, z: 1 },
      },
    });
    expect(socketB.emit).toHaveBeenCalledWith('controller:state', GRBL, expect.objectContaining({
      status: expect.objectContaining({ wpos: { x: 11, y: 20, z: 1 } }),
    }));
    expect(socketA.emit).toHaveBeenCalledTimes(socketACallsAfterRemove);
  });

  test('reattach after job finished during disconnect pushes idle/Idle', () => {
    const { controller } = createController(GrblController);
    const openSpy = jest.spyOn(controller, 'open');
    const commandSpy = jest.spyOn(controller, 'command');

    const socketA = createSocket('socket-a');
    controller.addConnection(socketA);
    controller.workflow.state = WORKFLOW_STATE_RUNNING;
    controller.state = {
      status: { activeState: 'Run', wpos: { x: 0, y: 0, z: 0 } },
    };

    controller.removeConnection(socketA);

    // Job finishes while the browser is disconnected.
    controller.workflow.stop();
    controller.state = {
      status: { activeState: 'Idle', wpos: { x: 5, y: 5, z: 0 } },
    };
    expect(controller.workflow.state).toBe(WORKFLOW_STATE_IDLE);

    const socketB = createSocket('socket-b');
    controller.addConnection(socketB);

    expect(openSpy).not.toHaveBeenCalled();
    expect(commandSpy).not.toHaveBeenCalledWith('gcode:start');
    expect(commandSpy).not.toHaveBeenCalledWith('gcode:resume');
    expect(commandSpy).not.toHaveBeenCalledWith('cyclestart');

    expect(socketB.emit).toHaveBeenCalledWith('workflow:state', WORKFLOW_STATE_IDLE);
    expect(socketB.emit).toHaveBeenCalledWith('controller:state', GRBL, expect.objectContaining({
      status: expect.objectContaining({ activeState: 'Idle' }),
    }));
  });

  test('server open path for an already-open controller only addConnections', () => {
    // Mirrors CNCEngine socket.on('open') when store already has an open controller.
    const { controller } = createController(GrblController);
    const openSpy = jest.spyOn(controller, 'open');
    const socket = createSocket('socket-new');
    const join = jest.fn();
    socket.join = join;

    controller.addConnection(socket);
    if (controller.isOpen()) {
      socket.join('/dev/null');
    } else {
      controller.open(() => {});
    }

    expect(openSpy).not.toHaveBeenCalled();
    expect(controller.sockets['socket-new']).toBe(socket);
    expect(join).toHaveBeenCalledWith('/dev/null');
  });
});

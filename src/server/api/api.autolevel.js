import { applyProbeCompensation, machineReferencesMatch, XY_REFERENCE_MACHINE } from '../lib/autolevel';
import store from '../store';
import {
  ERR_BAD_REQUEST,
} from '../constants';

// The Z touch plate records where cutting Z0 was set. Surface probing clears
// that record, so a value present at apply time is the zero made afterwards.
const cuttingZeroFromControllers = () => {
  const controllers = store.get('controllers', {});
  const zeros = [];
  Object.keys(controllers).forEach((port) => {
    const probeState = controllers[port] && controllers[port].probeState;
    if (!probeState) {
      return;
    }
    const { cuttingZeroX, cuttingZeroY } = probeState;
    if (Number.isFinite(cuttingZeroX) && Number.isFinite(cuttingZeroY)) {
      zeros.push({ cuttingZeroX, cuttingZeroY });
    }
  });
  if (zeros.length === 0) {
    return null;
  }
  const [first] = zeros;
  const mismatch = zeros.some(zero => (
    Math.abs(zero.cuttingZeroX - first.cuttingZeroX) > 0.001 ||
    Math.abs(zero.cuttingZeroY - first.cuttingZeroY) > 0.001
  ));
  if (mismatch) {
    throw new Error('Cutting Z0 location is ambiguous across connected controllers');
  }
  return first;
};

const connectedControllers = () => {
  const controllers = store.get('controllers', {});
  return Object.keys(controllers).map(port => controllers[port]).filter(Boolean);
};

const liveMachineContext = () => {
  const matches = connectedControllers().filter(controller => (
    controller.currentMachineReference && controller.workOffsetMm
  ));
  if (matches.length === 0) {
    return null;
  }
  if (matches.length > 1) {
    throw new Error('Machine reference is ambiguous across connected controllers');
  }
  const controller = matches[0];
  return {
    machineReference: controller.currentMachineReference(),
    wco: controller.workOffsetMm(),
    wcs: controller.runner && controller.runner.getWorkCoordinateSystem
      ? controller.runner.getWorkCoordinateSystem()
      : 'G54',
    cuttingZeroMachineX: controller.probeState && controller.probeState.cuttingZeroMachineX,
    cuttingZeroMachineY: controller.probeState && controller.probeState.cuttingZeroMachineY,
  };
};

// Apply probe compensation without requiring an open serial port.
export const apply = (req, res) => {
  const {
    gcode = '', probeData = [], referenceProbeZ, normalized, zeroX, zeroY,
    xyReference, machineReference,
  } = { ...req.body };

  if (!gcode) {
    res.status(ERR_BAD_REQUEST).send({
      msg: 'Empty G-code'
    });
    return;
  }

  try {
    const options = {};
    if (referenceProbeZ !== undefined) {
      options.referenceProbeZ = referenceProbeZ;
    }
    if (normalized === true) {
      options.normalized = true;
      if (zeroX != null && zeroY != null) {
        options.zeroX = zeroX;
        options.zeroY = zeroY;
      } else if (xyReference !== XY_REFERENCE_MACHINE) {
        const cuttingZero = cuttingZeroFromControllers();
        if (cuttingZero) {
          options.zeroX = cuttingZero.cuttingZeroX;
          options.zeroY = cuttingZero.cuttingZeroY;
        }
      }
    }
    if (xyReference === XY_REFERENCE_MACHINE) {
      const live = liveMachineContext();
      if (!live || !live.machineReference || !Number.isFinite(live.wco.x) || !Number.isFinite(live.wco.y)) {
        throw new Error('Home the machine and connect it before applying a machine-referenced probe map');
      }
      if (machineReference && !machineReferencesMatch(machineReference, live.machineReference)) {
        throw new Error('Machine home or travel settings changed since this surface was probed. Probe the surface again.');
      }
      options.xyReference = XY_REFERENCE_MACHINE;
      options.wcoX = live.wco.x;
      options.wcoY = live.wco.y;
      options.activeWcs = live.wcs;
      options.machineReference = machineReference || live.machineReference;
      options.liveMachineReference = live.machineReference;
      if (options.zeroX == null && Number.isFinite(live.cuttingZeroMachineX) && Number.isFinite(live.cuttingZeroMachineY)) {
        options.zeroX = live.cuttingZeroMachineX;
        options.zeroY = live.cuttingZeroMachineY;
      }
    }
    const compensatedGcode = applyProbeCompensation(gcode, probeData, options);
    res.send({ compensatedGcode });
  } catch (err) {
    res.status(ERR_BAD_REQUEST).send({
      msg: err.message || 'Failed to apply probe compensation'
    });
  }
};

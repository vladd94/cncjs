import { applyProbeCompensation } from '../lib/autolevel';
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

// Apply probe compensation without requiring an open serial port.
export const apply = (req, res) => {
  const {
    gcode = '', probeData = [], referenceProbeZ, normalized, zeroX, zeroY,
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
      } else {
        const cuttingZero = cuttingZeroFromControllers();
        if (cuttingZero) {
          options.zeroX = cuttingZero.cuttingZeroX;
          options.zeroY = cuttingZero.cuttingZeroY;
        }
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

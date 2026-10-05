import { applyProbeCompensation } from '../lib/autolevel';
import {
  ERR_BAD_REQUEST,
} from '../constants';

// Apply probe compensation without requiring an open serial port.
export const apply = (req, res) => {
  const { gcode = '', probeData = [], referenceProbeZ } = { ...req.body };

  if (!gcode) {
    res.status(ERR_BAD_REQUEST).send({
      msg: 'Empty G-code'
    });
    return;
  }

  try {
    const options = referenceProbeZ === undefined ? {} : { referenceProbeZ };
    const compensatedGcode = applyProbeCompensation(gcode, probeData, options);
    res.send({ compensatedGcode });
  } catch (err) {
    res.status(ERR_BAD_REQUEST).send({
      msg: err.message || 'Failed to apply probe compensation'
    });
  }
};

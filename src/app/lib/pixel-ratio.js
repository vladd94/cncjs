// Cap the device pixel ratio. Beyond 2x the extra texture/render
// resolution costs GPU memory without a perceptible gain in crispness.
const MAX_PIXEL_RATIO = 2;

// On the mobile/tablet shell (often Raspberry Pi panels), force 1x to
// cut fragment fill-rate roughly in half vs retina-ish DPR.
const isLowPowerShell = () => (
  typeof document !== 'undefined' &&
  document.documentElement &&
  document.documentElement.classList.contains('cncjs-mobile')
);

// Returns the device pixel ratio to render at, capped for the active shell.
export const getRenderPixelRatio = () => {
  if (isLowPowerShell()) {
    return 1;
  }
  return Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
};

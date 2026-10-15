// True only for loopback peers. Does not consult headers or Host.
const isLoopbackAddress = (address) => {
  if (!address || typeof address !== 'string') {
    return false;
  }

  const bare = address.split('%')[0].toLowerCase();
  if (bare === '::1') {
    return true;
  }

  const mapped = bare.indexOf('::ffff:') === 0 ? bare.slice('::ffff:'.length) : bare;
  const parts = mapped.split('.');
  if (parts.length !== 4 || parts[0] !== '127') {
    return false;
  }

  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return false;
    }
    const value = Number(part);
    return value >= 0 && value <= 255;
  });
};

export default isLoopbackAddress;

// Valida MAC no formato XX:XX:XX:XX:XX:XX
function validateMac(mac) {
  if (!mac) return false;

  const regex = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i;

  return regex.test(mac.trim());
}

module.exports = validateMac;
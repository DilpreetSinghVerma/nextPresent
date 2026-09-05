const os = require('os');

function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      // Only keep IPv4 and non-internal (not 127.0.0.1)
      if (net.family === 'IPv4' && !net.internal) {
        // Filter out typical virtual adapters (WSL, Docker, VirtualBox, VMware) if possible, but keep list
        const isVirtual = /virtual|vbox|wsl|docker|hyper-v|vethernet/i.test(name);
        addresses.push({
          interface: name,
          address: net.address,
          isVirtual
        });
      }
    }
  }

  // Sort real physical adapters (Wi-Fi, Ethernet) first
  addresses.sort((a, b) => {
    if (a.isVirtual && !b.isVirtual) return 1;
    if (!a.isVirtual && b.isVirtual) return -1;
    if (/wi-fi|wifi|wireless/i.test(a.interface)) return -1;
    if (/wi-fi|wifi|wireless/i.test(b.interface)) return 1;
    return 0;
  });

  return addresses;
}

function getPrimaryLocalIp() {
  const addrs = getLocalIpAddresses();
  if (addrs.length > 0) {
    return addrs[0].address;
  }
  return '127.0.0.1';
}

module.exports = {
  getLocalIpAddresses,
  getPrimaryLocalIp
};

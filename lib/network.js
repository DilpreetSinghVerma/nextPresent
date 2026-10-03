const os = require('os');

function isPrivateIp(ip) {
  if (!ip) return false;
  // Exclude link-local / APIPA (169.254.x.x) and loopback
  if (ip.startsWith('169.254.') || ip.startsWith('127.')) return false;
  // Check standard RFC1918 private subnets
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('10.')) return true;
  const parts = ip.split('.').map(Number);
  if (parts.length === 4 && parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  return false;
}

function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      // Only keep IPv4, non-internal, and not link-local 169.254.x.x
      if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254.')) {
        const isVirtual = /virtual|vbox|wsl|docker|hyper-v|vethernet|vmware|npcap/i.test(name);
        const isEthernet = /ethernet|eth|en[0-9]|local area connection/i.test(name);
        const isWifi = /wi-fi|wifi|wireless|wlan/i.test(name);

        let score = 0;
        if (isPrivateIp(net.address)) score += 100;
        if (!isVirtual) score += 50;
        if (isEthernet || isWifi) score += 20;

        addresses.push({
          interface: name,
          address: net.address,
          isVirtual,
          isEthernet,
          isWifi,
          score
        });
      }
    }
  }

  // Sort highest quality adapter first (real private LAN adapters at top)
  addresses.sort((a, b) => b.score - a.score);

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
  getPrimaryLocalIp,
  isPrivateIp
};

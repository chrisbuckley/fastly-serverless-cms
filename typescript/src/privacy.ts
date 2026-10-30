const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/;
const HEXTET_RE = /^[0-9a-f]{1,4}$/;

function expandIpv6(addr: string): string[] | null {
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : halves[0].split(":");
  const tail =
    halves.length === 2 && halves[1] !== "" ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  return groups.every((g) => HEXTET_RE.test(g)) ? groups : null;
}

export function truncateIp(ip: string): string {
  const mapped = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  const addr = mapped ? mapped[1] : ip;

  const v4 = addr.match(IPV4_RE);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0`;

  const groups = expandIpv6(addr.toLowerCase());
  if (!groups) return "";

  const prefix = groups.slice(0, 3).map((g) => g.replace(/^0+(?=.)/, ""));
  while (prefix.length > 0 && prefix[prefix.length - 1] === "0") prefix.pop();
  return `${prefix.join(":")}::`;
}

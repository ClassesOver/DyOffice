import { isIP } from 'node:net'

// IANA IPv4 special-purpose registry (RFC 6890 and successors): every block
// that is not globally routable, plus multicast and reserved space. Blocking
// whole first octets (all of 100/8, 169/8, 192/8, 198/8, 203/8) would also
// reject ordinary public addresses.
const NON_GLOBAL_IPV4: readonly (readonly [number, number])[] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.31.196.0', 24], ['192.52.193.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['192.175.48.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => [ipv4Number(base as string), bits as number] as const)

function ipv4Number(address: string): number {
  return address.split('.').reduce((value, part) => value * 256 + Number(part), 0)
}

/** True only for a dotted IPv4 address that is globally routable. */
export function publicIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false
  const value = ipv4Number(address)
  return !NON_GLOBAL_IPV4.some(([base, bits]) => Math.floor(value / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)))
}

/** Expand a valid IPv6 literal (zone id ignored) to eight 16-bit groups. */
function ipv6Groups(address: string): number[] {
  let text = address.split('%')[0].toLowerCase()
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (tail) {
    const [a, b, c, d] = tail[1].split('.').map(Number)
    text = text.slice(0, -tail[1].length) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16)
  }
  const [head, rest] = text.split('::')
  const left = head ? head.split(':') : []
  const right = rest === undefined ? [] : rest ? rest.split(':') : []
  const fill = rest === undefined ? [] : new Array(8 - left.length - right.length).fill('0')
  return [...left, ...fill, ...right].map(group => parseInt(group, 16))
}

/**
 * True only for IPv6 global unicast (2000::/3) outside the IETF protocol
 * assignments block 2001::/23 (Teredo, benchmarking, ORCHID, AMT and others),
 * documentation (2001:db8::/32 and 3fff::/20, RFC 9637) and 6to4 (2002::/16),
 * whose embedded or relayed IPv4 targets cannot be checked here. Loopback,
 * unique-local, link-local, multicast, IPv4-mapped and NAT64 addresses all fall
 * outside 2000::/3.
 */
export function publicIpv6(address: string): boolean {
  if (isIP(address.split('%')[0]) !== 6) return false
  const [first, second] = ipv6Groups(address)
  if ((first & 0xe000) !== 0x2000) return false
  if (first === 0x2001 && (second < 0x0200 || second === 0x0db8)) return false
  if (first === 0x3fff && second < 0x1000) return false
  return first !== 0x2002
}

/** A globally routable unicast address of either family. */
export function publicAddress(address: string): boolean {
  return publicIpv4(address) || publicIpv6(address)
}

export type MotionSocketFact = {
  id: number;
  role: string;
  open: boolean;
  admitted: boolean;
  remoteAddress: string;
  remotePort: number;
  localAddress: string;
  localPort: number;
  maxBufferBytes: number;
  closeReason: string | null;
};

export type MotionPeer = {
  local_address: string;
  local_port: number;
  server_address: string;
  server_port: number;
};

const address = (value: string) => value.replace(/^::ffff:/, '');

/** Bind to one live admitted transport, never to its role or arrival ordering. */
export function bindMotionPeer(
  sockets: MotionSocketFact[],
  peer: MotionPeer,
): MotionSocketFact | undefined {
  const matches = sockets.filter(
    (row) =>
      row.open &&
      row.admitted &&
      row.role === 'viewer' &&
      address(row.remoteAddress) === address(peer.local_address) &&
      row.remotePort === peer.local_port &&
      address(row.localAddress) === address(peer.server_address) &&
      row.localPort === peer.server_port,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

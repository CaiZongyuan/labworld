# Watch securely, resubscribe and deploy WSS

Goal: watch one authenticated Simulation Session through HTTPS/WSS and recover the current experiment after a Viewer disconnects. Complete [independent Recording](recording.md) first. Keep its Lab, Installation and GLB. Synthetic produces deterministic motion; it does not calculate Newton physics.

Run commands from the repository root. Use the specified Node and pnpm versions. Prepare an independent Python environment:

```bash
python3 -m venv .scratch/secure-motion-python
.scratch/secure-motion-python/bin/python -m pip install -r tools/synthetic-motion/requirements.txt
```

## Run the trusted local TLS journey first

Install Chromium, then run the complete isolated journey:

```bash
pnpm exec playwright install --with-deps chromium
MOTION_E2E_PYTHON="$PWD/.scratch/secure-motion-python/bin/python" node scripts/e2e-wss.mjs
```

The supervisor builds the real service and Web app, creates a temporary CA and certificate, then runs actual HTTPS/WSS. It uses isolated PGlite data, reliable Recording, Python sources and Chromium. It does not ignore certificate errors.

Linux requires OpenSSL and NSS tools. If `certutil` is absent, the supervisor extracts `libnss3-tools` into this run's temporary directory. It registers one uniquely named CA in the user's NSS store. Cleanup stops owned consumers, checks its fingerprint and removes only that CA. Other certificates and the shared database remain.

Expected results include two real 3D Viewers, fresh-ticket recovery, paused late join, Reset, no mapping/frame leaks, released quotas and revoked subscriptions. The terminal prints the resource ledger path. Inspect that ledger after a failure. After abnormal supervisor termination, run:

```bash
node scripts/e2e-wss.mjs --recover <owned-resources.json>
```

Use that run's WSS supervisor ledger. Recovery refuses an active owner and preserves resources with unproved identity. This journey verifies local TLS, security and recovery. It does not prove public routing, WAN latency or three separate hosts.

## Enable HTTPS/WSS on one listener

Prepare a PEM certificate chain and private key for the entry hostname. Browsers and Python must trust its CA and verify the hostname. Build and start with the previous chapter's data directory:

```bash
pnpm build
APP_ORIGIN=https://lab.example.com:3443 \
FILE_PUBLIC_ORIGIN=https://lab.example.com:3443 \
LAB_WORD_HOST=0.0.0.0 SERVER_PORT=3443 \
LAB_WORD_TLS_CERT=/absolute/path/fullchain.pem \
LAB_WORD_TLS_KEY=/absolute/path/private-key.pem \
LAB_WORD_SYNTHETIC_SESSION=true LAB_WORD_SYNTHETIC_MANAGED=false \
LAB_WORD_MOTION_GRACE_MS=60000 \
LAB_WORD_DATA_DIR=.scratch/session-tutorial-data \
LAB_WORD_WEB_DIR="$PWD/apps/web/dist" pnpm start
```

Replace the hostname, certificate paths and port. The certificate SAN must match the hostname. Limit private-key access to the service owner. This manual lesson uses the existing 60-second source startup grace; automated deployments can use the default five seconds. Tickets remain valid for 30 seconds. WS authentication remains three seconds. Recording ACK deadlines do not change.

One Node listener handles HTTP, SSE, Motion and Recording upgrades. Certificate and key configuration must be paired, with an HTTPS `APP_ORIGIN`. The default remains loopback HTTP. Plaintext Motion requires an actual loopback peer. Caller-supplied forwarded/proto headers cannot establish TLS trust. Motion fixtures remain limited to loopback tests.

## Start an external source with independent machine identity

1. Open the HTTPS entry and sign in as a Member.
2. Get the previous chapter's Lab and Installation UUIDs.
3. Paste the complete source into the browser Console.

<<< ../examples/secure-motion.js

4. Create an independent machine and fixed Session:

```js
const external = await startExternalSynthetic(
  '<lab-uuid>',
  '<installation-uuid>',
);
console.log(external.session.id, external.machine.machine.id);
```

This writes a machine, Session, fixed snapshot and initial Recording. Save both UUIDs. Get `external.machine.credential` from the protected response and keep it private. Do not put it in URLs, command arguments or logs.

5. Run this command on the Python host. Paste the machine credential at the hidden input:

```bash
read -r -s -p 'Machine credential: ' motion_machine_credential
printf '\n'
printf '%s\n' "$motion_machine_credential" | .scratch/secure-motion-python/bin/python tools/synthetic-motion/remote.py \
  --server https://lab.example.com:3443 --lab <lab-uuid> \
  --session <session-uuid> --machine <machine-uuid>
unset motion_machine_credential
```

For a private CA, set `SSL_CERT_FILE=/absolute/path/ca.pem` before the Python command. Keep certificate and hostname verification enabled. Python initiates outbound connections and exposes no public listener.

The machine credential obtains HTTPS admission. The service returns two temporary tickets for one Session, lease and epoch. Python connects Motion and reliable Recording separately. It confirms the durable initial frame before running. WS credentials are neither browser Cookies nor full-Lab Agent keys.

6. Open the same Lab in two authorized browsers. Wait for **Running** and **Motion connected**.
7. Disconnect one browser, then restore its network. It requests a fresh ticket, mapping and full Snapshot.
8. Click **Pause**, then open another Viewer. Pose and simulation time remain frozen.
9. Click **Reset**. The old Session and Recording end; a new Session needs fresh source admission.

External sources do not automatically reconnect or replay controls. After Reset, explicitly start a new source with the successor Session UUID. Old leases, epochs and tickets cannot publish. `Stop` ends a healthy experiment. Source loss, invalid machine identity or Recording failure interrupts it and preserves the valid Recording prefix.

## Check access and recovery limits

Viewers request tickets through existing Cookie/CSRF access or an Agent with `lab:full`. Tickets are random, Session-bound, once-only and valid for 30 seconds. The first WS HELLO includes the ticket and expected scene hash. Private mapping and motion follow successful verification.

Established Viewer identity and machine/lease validity are checked every second. Verification remains valid for at most four seconds; overdue connections close. Revoked access cannot recover with a fresh ticket. Browsers retry transient network failures up to six consecutive times. Definite refusal, scene errors and ended Sessions stop recovery. Changing user, Lab or Session cancels previous requests and connections.

| Limit                                             | Current maximum      |
| ------------------------------------------------- | -------------------- |
| Active Motion Viewers per account                 | 8                    |
| Outstanding Motion tickets per account / Session  | 16 / 32              |
| Viewers per Session / combined WS connections     | 64 / 128             |
| Combined outstanding Motion and Recording tickets | 256                  |
| Incoming WS message / HELLO                       | 64 KiB / 16 KiB      |
| Pending Viewer Snapshot                           | One replaceable slot |
| Viewer WS soft / hard pressure threshold          | 64 KiB / 256 KiB     |
| Sustained-pressure disconnect deadline            | Two seconds          |

These limits are separate from HTTP peer limits. A Viewer's 15/30 Hz setting changes only its delivery cadence. Slow readers do not change source sampling, other Viewers or reliable Recording.

Try a wrong Origin, reused ticket or wrong scene hash. Expect no mapping or frames. Revoke a real Agent key; its established subscription ends while another valid Member continues. Then [inspect Recording](recording.md) for the valid prefix and integrity. Do not infer history from the live cache.

## LAN, private and public entrypoints

A LAN can use the Node HTTPS/WSS listener with trusted certificates. Tailscale supplies private routing. Continue to use valid HTTPS/WSS certificates and an exact `APP_ORIGIN`. Routing does not replace member access or machine identity.

A public reverse proxy can connect to a protected Node TLS upstream. For example, a deployment-owned Nginx location:

```nginx
location / {
  proxy_pass https://127.0.0.1:3443;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host lab.example.com;
  proxy_ssl_server_name on;
  proxy_ssl_name lab.example.com;
  proxy_ssl_verify on;
  proxy_ssl_trusted_certificate /absolute/path/ca-bundle.pem;
  proxy_read_timeout 75s;
}
```

The public listener also needs a valid HTTPS certificate. Set `APP_ORIGIN` and `FILE_PUBLIC_ORIGIN` to the actual browser entry. Node does not infer TLS or client identity from proxy headers. HTTP limiting observes the proxy's actual TCP peer.

Cloudflare Tunnel can use `service: https://localhost:3443`, with `originRequest.originServerName: lab.example.com` and a trusted `caPool`. Keep origin certificate verification. The Tunnel supplies entry, not solver or Gateway computation. Verify actual separate-host, private and public routes in the deployment environment.

Configuration comes from the [running parser](../../apps/server/src/config.ts). Admission belongs to [shared transport checks](../../apps/server/src/transport.ts), [Motion](../../apps/server/src/motion-ws.ts) and [Recording](../../apps/server/src/recording-ws.ts). [Session](../../packages/server/src/lab/sessions/service.ts) owns authority and access. The [Viewer](../../packages/views/src/lab/use-simulation-session.ts) owns recovery. Continue to the [spatial workbench](spatial-workbench.md).

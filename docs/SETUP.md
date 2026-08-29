# Setup reference

The step-by-step walkthrough — installing Docker, getting a certificate,
starting the container, adding Tailscale, and enrolling each camera — lives in
the [README](../README.md#deploying-the-hub). This file holds the things that
did not belong in it: troubleshooting, and how to work on the hub with no
hardware attached.

---

## Troubleshooting

### The camera never appears after provisioning

Watch it boot with `pio device monitor` and read the `[pair]` lines.

| Log line | Cause | Fix |
|---|---|---|
| `[pair] hub rejected pairing: HTTP 403` | Code expired or already used | Mint a fresh code, tap RESET ×3, redo the portal |
| `[pair] bad hub URL` | Address mistyped or unreachable | Must be the hub's LAN address and port, reachable from the camera's side of the network |
| No `[wifi] connected` line | Wrong Wi-Fi password, or 5GHz-only SSID | The ESP32 is **2.4GHz only**. Split the band or use a 2.4GHz guest SSID |
| Nothing at all on serial | Board not in the shield properly | Reseat it; check `pio device list` |

The camera clears a pairing code once the hub rejects it with a 4xx, rather
than retrying forever, so after a failed claim you always need a fresh code.

### It appears, then goes offline every few minutes

Nearly always power. See [HARDWARE.md](HARDWARE.md#power) — use a 1A+ supply
and a short, thick cable. Then check the **Signal** figure on the camera detail
page; below about −75 dBm the link is too weak to hold a stream.

Note that the hub marks a camera offline after 100 seconds of silence
(`OFFLINE_AFTER_SECONDS`), and cameras heartbeat every 30 seconds — so
"offline" means three missed heartbeats, not one blip.

### Live view is black, or stalls

Open one camera at a time while diagnosing. The camera accepts exactly one
stream client and returns 503 to a second, and the hub is designed to be that
client. If the camera's log shows `stream already in use`, something other than
the hub is talking to it directly.

### Browser warns about the certificate

The CA is not installed on that device, or — on iOS — it was installed but not
enabled under Settings → General → About → Certificate Trust Settings. Both
steps are required.

The other possibility is that you are reaching the hub by a name that is not in
the certificate. Re-issue it with every name and address you use:

```bash
mkcert -cert-file certs/hub.pem -key-file certs/hub-key.pem \
       192.168.1.50 cam.home.lan localhost 127.0.0.1
docker compose restart hub
```

### The container will not start

```bash
docker compose logs hub
```

| Message | Cause |
|---|---|
| `EACCES` writing `/data/...` | Docker created `./data` as root. `sudo chown -R 1000:1000 data` and restart — the container is not root |
| `EACCES` on a cert path | The key is not readable by UID 1000 — `sudo chown 1000:1000 certs/hub-key.pem` |
| `EADDRINUSE` | Something else holds `HUB_PORT` |
| `EACCES` binding the port | `HUB_PORT` is below 1024 and the container is not root |
| `TLS_CERT_FILE and TLS_KEY_FILE must be set together` | Only one of the pair is set in `.env` |

### I lost the admin password

The hub only creates the admin user when the database has no users, so setting
`ADMIN_PASSWORD` afterwards does nothing. Delete the user and let it bootstrap
again:

```bash
docker compose down
sqlite3 data/hub.db "delete from users; delete from sessions;"
# set ADMIN_PASSWORD in .env, or leave it blank for a generated one
docker compose up -d
```

Cameras are untouched by this — their tokens live in a different table.

---

## Developing without hardware

`hub/tools/mock-camera.mjs` implements the firmware's exact API, including the
quirks that the hub is built around: control and stream on separate ports, SD
downloads sent chunked with no `Content-Length`, and only one MJPEG client
accepted at a time.

```bash
cd hub
npm install
npm run build

# terminal 1
DATA_DIR=./data ADMIN_PASSWORD=devpassword npm start

# terminal 2 — mint a code in the UI first, then:
npm run mock-camera -- --hub http://127.0.0.1:8080 --code ABCD-EFGH
```

Run a second mock on other ports to test the grid with several cameras:

```bash
npm run mock-camera -- --hub http://127.0.0.1:8080 --code WXYZ-1234 \
  --id cam-mock00000002 --name Windowsill --port 8083 --stream-port 8084
```

### The end-to-end suite

Spins up its own hub and mock camera, asserts 36 behaviours, and cleans up:

```bash
npm test
```

It covers the things that are awkward to check by hand — that two viewers
result in exactly **one** upstream connection to the camera, that a pairing
code cannot be replayed, that a range request returns exactly the bytes asked
for with a correct `Content-Range`, and that the session really dies on logout.

### Watch mode

```bash
npm run dev        # esbuild rebuilds the browser bundle on change
node --watch src/server/main.ts
```

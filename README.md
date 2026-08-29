# esp32CamChecker

A mobile-friendly page for checking on your plants, backed by as many
ESP32-CAM boards as you care to stick in pots.

One hub runs on a Linux box in the house. Each camera is enrolled once from
your phone, over a captive portal, with a single-use pairing code — no
credentials in the repo, no reflashing to change Wi-Fi. From the hub you get a
grid of live thumbnails, an on-demand live view, and the contents of each
camera's SD card.

```
 phone / laptop
   │  HTTPS — local CA on the LAN, Tailscale's cert from outside
   ▼
 hub (Docker)  ── SQLite: users, sessions, device tokens
   │  HTTP + per-camera bearer token, LAN only
   ├──► ESP32-CAM "greenhouse"    :80 control   :81 stream
   ├──► ESP32-CAM "windowsill"
   └──► ...
```

## What it does

- **One page, every camera.** Grid of tiles with live status and refreshing
  thumbnails. Tiles that scroll off screen, and the whole page when the tab is
  backgrounded, stop polling.
- **Live view on demand.** Tap a camera for MJPEG. The hub holds a *single*
  connection to each ESP32 and fans frames out to every viewer — an
  ESP32-CAM manages one stream client before its frame rate collapses, so the
  hub is that client.
- **SD card browsing.** Navigate folders, preview photos, download files.
  Downloads carry a real `Content-Length` and support range requests, so video
  seeks and interrupted downloads resume.
- **Camera control.** Resolution, flash LED, mirror/flip, capture-to-SD,
  reboot, rename.
- **Secure by default.** Login on the hub, a unique revocable token per camera,
  single-use pairing codes, HTTPS, and remote access over Tailscale with no
  router ports opened. `docs/SECURITY.md` describes the model and is candid
  about its one real limitation.

## Layout

| Path | What |
|---|---|
| `firmware/` | PlatformIO project for the AI-Thinker ESP32-CAM |
| `hub/src/server/` | Fastify + TypeScript API, stream fan-out, SQLite |
| `hub/src/web/` | Mobile-first UI — vanilla TypeScript, no framework |
| `hub/tools/` | Mock camera and the end-to-end suite |
| `docs/` | Troubleshooting, hardware notes, security model |

---

# Deploying the hub

Do this once, on the Linux box that will run the hub.

## 1. Install Docker

```bash
curl -fsSL https://get.docker.com -o get-docker.sh
less get-docker.sh          # it runs as root, so read it first
sudo sh get-docker.sh

sudo usermod -aG docker "$USER"
newgrp docker               # or log out and back in
docker compose version      # expect v2.x
```

## 2. Give the hub a fixed address

Cameras store the hub's address in flash during pairing, so it must not move.
Set a **DHCP reservation** for this machine in your router, or configure a
static IP. Then note the address:

```bash
hostname -I | awk '{print $1}'      # e.g. 192.168.1.50
```

Everything below assumes `192.168.1.50` — substitute yours.

## 3. Get the code

```bash
git clone <this repo> ~/esp32CamChecker
cd ~/esp32CamChecker
cp .env.example .env
```

## 4. Get a certificate

Your phone needs to trust the hub, and no public CA will issue a certificate
for a private address. [mkcert](https://github.com/FiloSottile/mkcert) creates a
small CA of your own and issues from it.

**Skip this section entirely** if you only ever reach the hub through Tailscale
— Tailscale supplies a publicly trusted certificate on its own. Comment out
both `TLS_*` lines in `.env`, set `HUB_PORT=8080`, and jump to step 5.

### Install mkcert and create your CA

```bash
sudo apt-get update && sudo apt-get install -y libnss3-tools

curl -JLO "https://dl.filippo.io/mkcert/latest?for=linux/amd64"
chmod +x mkcert-v*-linux-*
sudo mv mkcert-v*-linux-* /usr/local/bin/mkcert

mkcert -install              # creates the CA under ~/.local/share/mkcert
```

On an ARM box (Raspberry Pi and friends) swap the download for
`?for=linux/arm64`; `uname -m` tells you which you have.

### Issue the hub's certificate

List **every** name and address you might type in a browser. A certificate is
only valid for the names baked into it:

```bash
mkdir -p certs
mkcert -cert-file certs/hub.pem -key-file certs/hub-key.pem \
       192.168.1.50 cam.home.lan localhost 127.0.0.1
```

The container runs as UID 1000 and mounts `certs/` read-only, so make the key
readable by it:

```bash
sudo chown 1000:1000 certs/hub-key.pem
sudo chmod 600 certs/hub-key.pem
```

### Trust the CA on every phone and laptop

This is the step people skip, and it is the reason for "your connection is not
private" warnings. Copy `rootCA.pem` off the server:

```bash
# on the server — prints the path holding rootCA.pem
mkcert -CAROOT

# from your laptop
scp user@192.168.1.50:~/.local/share/mkcert/rootCA.pem .
```

Then get that one file onto each device (AirDrop, email it to yourself, a USB
stick) and install it:

- **iOS / iPadOS — two separate steps, both required.**
  1. Open the file. Settings → **Profile Downloaded** → Install.
  2. Settings → General → About → **Certificate Trust Settings** → turn on
     full trust for `mkcert`. Without step 2 the certificate is installed but
     still not trusted.
- **macOS:** double-click `rootCA.pem` → Keychain Access → find `mkcert` →
  Get Info → Trust → **Always Trust**.
- **Android:** Settings → Security → Encryption & credentials → **Install a
  certificate** → **CA certificate** → pick the file.
- **Windows:** double-click → Install Certificate → Local Machine → Place in
  **Trusted Root Certification Authorities**.

## 5. Configure and start

Edit `.env`. The defaults are sane; the ones worth a look:

| Variable | Notes |
|---|---|
| `HUB_PORT` | `8443` with TLS, `8080` without. Keep it above 1024 — the container is not root. |
| `ADMIN_PASSWORD` | Leave blank and one is generated and printed once. |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | `/certs/hub.pem` and `/certs/hub-key.pem`. Comment both out for plain HTTP. |

Create the data directory **before** the first start. If Docker has to create
the bind-mount source itself it makes it `root`-owned, and the container — which
runs as UID 1000, not root — then cannot write its database:

```bash
mkdir -p data
sudo chown 1000:1000 data
```

```bash
docker compose up -d --build
docker compose logs -f hub
```

If you left `ADMIN_PASSWORD` blank, the log prints the password **once**:

```
Created admin user "admin" with generated password: xK9m2Qp7vLz4
```

Save it, then open `https://192.168.1.50:8443` and sign in.

The container is set to `restart: unless-stopped`, so it comes back after a
reboot on its own. Useful commands:

```bash
docker compose ps                    # health status
docker compose logs -f hub
docker compose down && docker compose up -d --build    # after a git pull
```

> **Back up `data/`.** It holds your password hash and every camera's token.
> Losing it means re-pairing every camera by hand.

---

# Remote access (optional)

Tailscale puts the hub on a private network you can reach from anywhere,
without forwarding a single router port. It runs on the **host**, not in the
container.

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up          # follow the printed link to authenticate
```

In the [admin console](https://login.tailscale.com/admin/dns), under **DNS**,
enable **MagicDNS** and **HTTPS Certificates**. Then put the hub behind
Tailscale's own certificate:

```bash
sudo tailscale serve --bg https+insecure://localhost:8443
sudo tailscale serve status
```

Use `http://localhost:8080` instead if you skipped TLS. The `https+insecure`
form tells Tailscale not to verify the mkcert certificate it is proxying to,
which it has no reason to trust.

Install Tailscale on your phone and the hub is now at
`https://<hostname>.<your-tailnet>.ts.net` from anywhere — publicly trusted
certificate, no CA to install, nothing exposed to the internet.

> This is **not** `tailscale funnel`. Funnel would publish the hub to the whole
> internet; `serve` keeps it inside your tailnet.

---

# Deploying a camera

Repeat for each camera. Roughly five minutes each.

## Once per flashing machine

The board plugs into whatever computer has a USB port — it does not have to be
the server.

```bash
cd ~/esp32CamChecker
python3 -m venv .venv
./.venv/bin/pip install platformio
```

On macOS, confirm the board enumerates once the MB shield is plugged in:

```bash
./.venv/bin/pio device list      # look for /dev/cu.usbserial-*
```

If nothing appears, install the CH340 driver and re-plug.

## 1. Mint a pairing code

In the hub, tap **+ Add**. You get something like `R7KQ-M3XP`. It is good for
**ten minutes and one camera** — mint a fresh one for each board.

## 2. Flash the firmware

Seat the ESP32-CAM in the ESP32-CAM-MB shield and plug in USB. The shield
drives EN and IO0 itself, so there is **no jumper to fit and no button to
hold**.

```bash
cd firmware
../.venv/bin/pio run -e cam -t upload
../.venv/bin/pio device monitor          # worth watching the first time
```

The firmware contains no credentials, so every camera gets this identical
binary. Nothing here is per-camera.

## 3. Provision it from your phone

Unplug from USB and power the camera from a **1A or better** supply — a weak
supply is the single most common cause of an ESP32-CAM that keeps rebooting.

It raises its own Wi-Fi network:

```
SSID:     esp32cam-setup-a1b2c3        (last 6 of its MAC)
Password: plantcam-setup
```

Join it from your phone. The captive portal opens by itself; if it does not,
browse to `http://192.168.4.1`. Tap **Configure WiFi** and fill in:

| Field | Value |
|---|---|
| Wi-Fi network | your home SSID, and its password |
| Hub URL | `192.168.1.50:8443` — the hub's **LAN** address |
| Pairing code | the code from step 1 |
| Camera name | e.g. `Greenhouse` |

> Use the LAN address, not the `*.ts.net` name. The camera has no Tailscale
> client and cannot resolve it.

Save. The camera reboots, joins your Wi-Fi, claims the code, and appears on the
Cameras page within about a minute.

## 4. Check it

Open the camera in the hub. You should get a live view, and a **Signal**
reading on the detail page — below about −75 dBm the stream will stutter and
the camera wants moving or a better antenna.

## Re-provisioning a camera

There is no reset button to hold: GPIO0 is the camera clock, and holding it low
at boot drops the chip into the ROM bootloader instead. Instead, **tap RESET
three times** within about six seconds. The camera wipes its Wi-Fi credentials
and hub token and reopens the setup portal.

Removing a camera in the hub does the same thing remotely — its heartbeats
start failing and after about 90 seconds it resets itself back to the portal.

---

## Developing

The hub can be built and tested with no hardware at all; `hub/tools/mock-camera.mjs`
speaks the firmware's exact API, including its quirks (separate stream port,
chunked SD downloads, one stream client at a time).

```bash
cd hub
npm install
npm run build       # bundles the browser app
npm test            # 36-check end-to-end suite against the mock camera
npm run typecheck
```

```bash
cd firmware
../.venv/bin/pio run -e cam            # compile
../.venv/bin/pio run -e cam -t upload  # flash via the ESP32-CAM-MB shield
```

## Requirements

- AI-Thinker ESP32-CAM + ESP32-CAM-MB shield + a FAT32 microSD card
- A Linux box with Docker for the hub
- Node 24+ and PlatformIO for development

## Docs

- **[docs/SETUP.md](docs/SETUP.md)** — troubleshooting, and developing with no hardware
- **[docs/HARDWARE.md](docs/HARDWARE.md)** — power, the SD card's 1-bit constraint, pin conflicts
- **[docs/SECURITY.md](docs/SECURITY.md)** — what is protected, and what is not

## Licence

MIT — see [LICENSE](LICENSE).

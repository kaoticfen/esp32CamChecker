# Security model

## What this protects against

Everything on your LAN that is not you: guest devices, a smart TV, an IoT
gadget with a bad firmware update, someone who joined your Wi-Fi. Without the
measures below, an ESP32-CAM running the stock example sketch will hand a live
view of your house to anything that can reach its IP address.

It does **not** try to defend against an attacker who already has root on the
Docker host, or one who can passively capture your LAN traffic and cares enough
to reassemble JPEG frames. See the honest limitation below.

## Layers

### 1. Cameras only answer the hub

Every firmware endpoint — snapshot, stream, SD listing, SD download, settings,
reboot, OTA — requires `Authorization: Bearer <device token>`. There is no
unauthenticated path, not even a status page. A camera that has not been paired
holds no token and therefore refuses *everything*.

Tokens are 32 random bytes, unique per camera, compared in constant time on
both ends (`firmware/src/auth.cpp`, `hub/src/server/devices.ts`) so they cannot
be discovered one byte at a time.

### 2. Pairing is single-use and time-limited

Firmware ships with no credentials, so the binary is not a secret and every
camera gets the same one. A camera is enrolled by:

1. You mint a code in the hub (8 characters, 10-minute TTL, one use).
2. You type it into the camera's captive portal along with your Wi-Fi details.
3. The camera calls `POST /api/pair` and receives its token.
4. The code is burned. Replay is rejected — the hub does the claim as a
   conditional `UPDATE ... WHERE used_at IS NULL`, so even two simultaneous
   claims cannot both win.

A code overheard or left on screen is worthless afterwards.

### 3. The hub requires a login

- Passwords hashed with **scrypt** (N=16384, r=8, p=1) and a per-user salt.
- Login is rate-limited to 10 attempts per minute, and a nonexistent username
  is hashed against a dummy record so it takes the same time to reject as a
  wrong password.
- Session ID is 32 random bytes in a signed, `httpOnly`, `SameSite=Lax` cookie
  (`__Host-` prefixed when TLS is on). Only the **hash** of the session ID is
  stored, so a stolen copy of the database yields no usable sessions.
- Every state-changing request additionally needs `X-Requested-With:
  esp32camchecker`. A cross-site form post cannot set that header without a
  preflight, which closes the gap `SameSite=Lax` leaves open.

### 4. Path traversal is refused at both ends

`sdcard::safePath()` rejects relative paths, `..` segments, and embedded
NUL/CR/LF before any SD operation. The hub URL-encodes the path it forwards.

### 5. Transport

- **Browser → hub:** HTTPS. On the LAN, an mkcert certificate signed by a local
  CA you install once per device. Remotely, Tailscale's own Let's Encrypt
  certificate for `hub.<tailnet>.ts.net` — nothing to install and no router
  ports opened.
- **Hub → camera:** plain HTTP. This is the deliberate limitation described
  below.

## The one real limitation

**Camera-to-hub traffic is unencrypted HTTP on your LAN.**

This is a considered trade-off, not an oversight. TLS on an ESP32 needs mbedTLS
buffers in the same limited DRAM that the camera driver needs for frame
buffers, and a TLS handshake per connection plus per-record encryption on a
240MHz core makes MJPEG streaming unusable. Boards that do this are streaming
at a frame every few seconds.

What that means concretely: someone who can capture packets on your LAN — not
merely be connected to it, but actually see traffic between the hub and a
camera — could reconstruct the video, and could read a device token out of a
request header and then talk to that camera directly.

Mitigations, in order of how much they buy you:

1. **Put the cameras on an IoT VLAN or a separate SSID** with client isolation,
   and allow only the hub's address through. This is the real fix, and most
   prosumer routers can do it.
2. Use WPA3, or at least WPA2 with a strong passphrase — this already stops the
   casual case, since WPA encrypts each client's traffic separately.
3. Keep the hub the only thing you browse. Never expose a camera directly.

## Revoking a camera

Delete it from the hub (camera detail → **Remove camera**). Its token stops
working immediately. The camera notices — after three consecutive rejected
heartbeats, roughly 90 seconds, it wipes its own credentials and reopens the
setup portal, so a stolen or relocated camera does not sit on your Wi-Fi with a
stale token. The three-strike threshold exists so a hub restart mid-write
cannot wipe a healthy camera.

To rotate a token without physical access, delete the camera and re-pair it —
the portal opens on its own once the old token is rejected.

## Backups

`data/hub.db` holds the device tokens and your password hash. Back it up (it is
small), keep the backup somewhere you would be comfortable keeping a password
manager export, and note that losing it means re-pairing every camera by hand.

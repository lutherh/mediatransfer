# 07 — LAN endpoint in the Immich mobile app

**Status:** ✅ Applied 2026‑04‑23 (host + firewall). Mobile app config still per-device.
**Files to change:**
- [../docker-compose.immich.yml](../docker-compose.immich.yml) (port binding) — done, bound to `${IMMICH_LAN_IP}:2283` (set in `.env.immich`, auto‑detected by `scripts/start-all.sh`).
- Windows Firewall — done, inbound rule `Immich LAN 2283` (TCP 2283, Remote `192.168.0.0/24`, Private profile).
- Immich iOS / Android app (manual per device) — **still required on each phone**.

## Problem
On home Wi‑Fi, every photo / video upload from the phones currently
travels: **phone → home router → Cloudflare edge → cloudflared → Docker
→ immich‑server**. That's a round‑trip to Cloudflare for data that never
needed to leave the LAN. It:
- doubles effective upload latency;
- exposes large uploads to tunnel reconnection events (the exact failure
  mode behind this whole plan);
- wastes Cloudflare bandwidth.

## Fix
Configure the Immich app to prefer a LAN URL when reachable, falling back
to the public hostname otherwise. Unless this re-triggers login again

### Step 1 — expose 2283 on the LAN
In [../docker-compose.immich.yml](../docker-compose.immich.yml), change
the `immich-server` port binding from loopback to LAN‑facing. Pick the
host's LAN IP explicitly so it doesn't also publish on public
interfaces:

```yaml
immich-server:
  ports:
    - "192.168.X.Y:2283:2283"   # replace with the host's LAN IP
```

(If the LAN IP is DHCP‑assigned and occasionally changes, `0.0.0.0:2283:2283`
is acceptable **only** when combined with Step 2.)

### Step 2 — firewall scope to LAN subnet
Windows Defender Firewall → Inbound Rules → New Rule:
- Program: any / port 2283/TCP.
- Scope → Remote IP: `192.168.X.0/24` (your LAN subnet only).
- Profiles: Private only (not Public, not Domain unless you want it).

### Step 3 — configure the Immich app
Immich app → Settings → **Server Endpoint** (or Login screen):
- **External URL:** `https://immich.4to.uk`
- **Local Network**  
  Wi‑Fi SSID: `<your home SSID>`  
  Local URL: `http://192.168.X.Y:2283`

Repeat on each family device.

## Verification
1. With the phone on home Wi‑Fi, open Immich → Settings → check the
   "Connected to" banner says the local URL.
2. `docker logs --since 5m immich_tunnel` shows **no** `/api/assets`
   POSTs while uploading from a LAN‑connected phone.
3. Toggle Wi‑Fi off on the phone → uploads resume via the tunnel → the
   log shows `POST /api/assets` again.

## Risks / notes
- The app has historically been inconsistent about SSID‑based switching;
  the URL‑reachability fallback is the actual safety net.
- If the LAN IP of the Docker host changes, the mobile config needs
  updating. A DHCP reservation on the router avoids this.
- 2283 on the LAN is **plain HTTP**. Acceptable on a trusted home
  network; if the LAN is shared (e.g. rental, dorm), use §6 (tunnel)
  only.

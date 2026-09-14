# Bloom

Bloom is a browser-based, top-down multiplayer survival game. Players enter a procedural garden unarmed, collect a rifle and one growing flower, and fight inside a contracting safe zone.

This repository contains the first playable vertical slice from the Game Design Document:

- Private five-character room codes, lobby roster, and host-controlled start
- Server-authoritative movement, projectiles, collision, pickups, health, elimination, and storm state
- Procedural gardens that scale with population and preserve protected spawns plus connected central routes
- One rifle with automatic fire, spread, ammunition, and reloads
- One carried seed that grows from 1 to 50 stored HP and is consumed with `E`
- Storm contractions of at least 60 seconds, scaled for map size, and 10-second holds
- Killer-chain spectators and late-join spectating
- Canvas client with modular sprite characters, tiled floors and cover, and sprite projectiles

## Run locally

Requirements: Node.js 22 or later.

```powershell
npm install
npm test
npm run dev
```

Open `http://localhost:8080` in two browser windows. Create a room in one, join its code in the other, and start from the host window.

Controls: `WASD` to move, mouse to aim, hold left-click to fire, `R` to reload, and `E` to consume a carried flower.

## Network protocol

The client opens `/play` over WebSocket. Clients send room actions and current input intent; the server simulates at 30 Hz and broadcasts authoritative snapshots at 15 Hz. The browser predicts local movement using the shared simulation and reconciles it against the server; other players are interpolated. Hits, health, pickups, elimination, spectator targets, and storm geometry remain authoritative.

Bullets travel until their first collision with a player, solid cover, or the map boundary. Continuous sweeps test the full path between ticks, including relative player motion and muzzle obstruction. Timestamped shot and impact events let the client render even a shot that hits between snapshots, with a sprite, muzzle flash, and impact sparks. Glowing trails follow the last 90 milliseconds of actual flight and fade for 120 milliseconds after impact. Trails stay in world coordinates as the camera moves; visual extrapolation also stops at cover when a packet arrives late.

All tuning constants live in `server/config.js`. The first capacity safety rail is 64 players per room; that is an implementation guard, not a claimed tested capacity.

The world is 20 times its original width and height: 31,000 × 31,000 units for up to four players, growing to 169,000 × 169,000 at 64 players. Player, tile, and movement scales stay constant. The original populated garden remains around the spawns, with extra cover and loot throughout the expanded outskirts. Cover and pickup counts remain bounded by population. Larger storm contractions take enough time to keep the fastest boundary movement below 65% of player running speed; later small circles return to the 60-second minimum.

## Sprite artwork

The character renderer uses separate body, backpack, head, and arm sprites. The backpack sits behind the shoulders; arms attach at shoulder pivots with separate resting positions and rifle grips, keeping the hands from crossing. All parts share the character's aim transform. The reference projectile is the weapon atlas entry named `magazine`. Rifle muzzle offsets in `server/config.js` match the rig in `public/character-renderer.js`.

The supplied 256-pixel tilesheet is bundled as `public/assets/tiles.png`, with explicit crops in `tiles.json`. Floors use 64 world units per tile; wall edges and crate stacks fit the map's existing collision rectangles. Only visible tiles and cover are drawn, including on large maps.

Lighting adds a cool ambient tone, soft light around players, aimed rifle beams, pickup glows, and warm muzzle/impact illumination. Cover and map boundaries occlude each light, including obstructed muzzles. The light buffer is half the viewport resolution and the number of nearby lights is capped, so lighting memory does not grow with world dimensions. HUD and crosshair rendering stays above the lighting pass.

To regenerate the world atlas after replacing the source sheet, run `node scripts/extract-world-atlas.mjs`; set `BLOOM_ART_DIR` to the directory containing the source artwork. Runtime assets are included in the repository, so running the game requires no external art folder or extraction tools.

## Production topology

The client and the server are deployed separately:

| Piece | Host | Address |
| --- | --- | --- |
| Browser client (`public/`) | Vercel | `https://<project>.vercel.app` |
| Game server (`server/`) | AWS EC2, one instance | `wss://<dashed-ip>.nip.io/play` |

Exactly one server instance runs. That is deliberate: room state is process-local, so a second node could not see the first node's matches.

Because the Vercel page is served over HTTPS, the browser refuses a plain `ws://` connection. The EC2 instance therefore runs [Caddy](https://caddyserver.com/) as a reverse proxy, which obtains a Let's Encrypt certificate automatically and forwards to the Node server on port 8080. The hostname comes from [nip.io](https://nip.io/), which resolves `54-1-2-3.nip.io` to `54.1.2.3` — a real DNS name for the certificate, with no domain to buy.

## AWS deployment

Requirements: AWS CLI v2, credentials with EC2, IAM, and SSM permissions (`aws configure`). No Docker.

```powershell
.\infra\deploy-ec2.ps1
```

The script is idempotent — it tags everything `Project=bloom` and reuses what already exists. It allocates an Elastic IP first (so the hostname can be baked into the instance's boot script), then launches a `t3.micro` running Amazon Linux 2023, which bootstraps itself from `infra/user-data.sh`: Node 22, the repository cloned to `/opt/bloom`, a `bloom` systemd service, and Caddy.

Bootstrap continues for two to four minutes after the script returns. Confirm it finished:

```powershell
curl.exe https://<dashed-ip>.nip.io/health   # {"ok":true,"rooms":0}
```

Useful flags:

```powershell
.\infra\deploy-ec2.ps1 -HostnameSuffix sslip.io   # if nip.io hits a Let's Encrypt rate limit
.\infra\deploy-ec2.ps1 -Recreate                  # rebuild the instance from scratch
.\infra\deploy-ec2.ps1 -InstanceType t3.small     # more headroom
```

Administration goes through SSM Session Manager, so port 22 is closed and there is no key file to manage:

```powershell
aws ssm start-session --target <instance-id>
```

## Shipping code changes

Push to `master` first, then:

```powershell
.\infra\redeploy.ps1
```

This pulls the new commit on the instance, reinstalls production dependencies, and restarts the service. **Restarting ends every match in progress**, since all state is in memory — the script checks `/health` and refuses to run while rooms are active unless you pass `-Force`.

If the bootstrap itself failed, the log is at `/var/log/cloud-init-output.log`. It only runs once per instance, so a badly broken boot is usually faster to fix with `-Recreate` than by hand.

## Vercel deployment

The browser client is a static site (`public/`) deployed on Vercel. `vercel.json` sets `npm run build` as the build command, which runs `scripts/write-client-config.mjs` to bake the `BLOOM_SERVER_URL` environment variable into `public/config.js`.

```powershell
npm install -g vercel
vercel link
vercel env add BLOOM_SERVER_URL production   # value: wss://<dashed-ip>.nip.io/play
vercel --prod
```

`BLOOM_SERVER_URL` must be set. Without it the client falls back to its own origin and tries to reach a WebSocket on Vercel, which will never answer.

Once the project is linked, pushing to the connected GitHub branch triggers an automatic Vercel deployment; `vercel --prod` is only needed for manual deploys.

## Production follow-ups

- Playtest and record practical room capacity, latency, bandwidth, and match length
- Replace the guaranteed cross-corridor validator with a full navigation-grid connectivity test as map shapes become more complex
- Add reconnect tokens and a short disconnect grace period
- Partition rooms before adding more server nodes
- Add sound and gamepad/accessibility options

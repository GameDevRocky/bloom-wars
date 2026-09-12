# Bloom

Bloom is a browser-based, top-down multiplayer survival game. Players enter an overgrown procedural garden unarmed, collect a rifle and one growing flower, and fight inside a safe zone that contracts in 60-second breaths.

This repository contains the first playable vertical slice from the Game Design Document:

- Private five-character room codes, lobby roster, and host-controlled start
- Server-authoritative movement, projectiles, collision, pickups, health, elimination, and storm state
- Procedural gardens that scale with population and preserve protected spawns plus connected central routes
- One rifle with automatic fire, spread, ammunition, and reloads
- One carried seed that grows from 1 to 50 stored HP and is consumed with `E`
- Repeating 60-second storm contractions and 10-second holds
- Killer-chain spectators and late-join spectating
- Canvas client using the GDD palette and strict top-down flat-shape direction

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

The client opens `/play` over WebSocket. Clients send room actions and current input intent; the server simulates at 30 Hz and broadcasts authoritative snapshots at 15 Hz. The browser interpolates the camera and renders snapshots but never decides hits, health, pickups, elimination, spectator targets, or storm geometry.

All tuning constants live in `server/config.js`. The first capacity safety rail is 64 players per room; that is an implementation guard, not a claimed tested capacity.

## AWS deployment

The initial production topology is one AWS Lightsail container node. A single node is deliberate because private-room state is currently process-local. The service provides a managed HTTPS endpoint, so a GitHub Pages client can connect over `wss://` without mixed-content failures.

After AWS CLI v2 is installed, Docker is running, and credentials are configured, deploy with:

```powershell
.\infra\deploy-lightsail.ps1 -Region us-east-1 -Power nano -Scale 1
```

The script prints the WebSocket URL. Add it as the GitHub repository variable `BLOOM_SERVER_URL`, enable GitHub Pages with GitHub Actions as the source, and run the `Publish browser client` workflow.

Do not increase `Scale` above 1 until room affinity or external room state is implemented. Independent nodes cannot yet share a match.

## Production follow-ups

- Playtest and record practical room capacity, latency, bandwidth, and match length
- Add client-side movement prediction with reconciliation after baseline networking is measured
- Replace the guaranteed cross-corridor validator with a full navigation-grid connectivity test as map shapes become more complex
- Add reconnect tokens and a short disconnect grace period
- Partition rooms before adding more server nodes
- Add sound, gamepad/accessibility options, and final sprite assets

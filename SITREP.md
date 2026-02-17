# SITUATION REPORT — Voice Communications Integration
## Champion Council Extension — 2026-02-17T02:59Z

---

## CURRENT STATE: WORKING BUT INCOMPLETE

The voice chat **works** — you can create rooms, join them, and the mic captures audio via ffmpeg. But the implementation is fragmented with redundant code paths and the settings/controls are bare minimum.

---

## WHAT WORKS RIGHT NOW

1. **NIP-53 Voice Rooms** — Create, join, leave rooms via Nostr relays (kind 30312, 1311, 10312)
2. **PeerJS P2P Voice** — WebRTC peer connections via PeerJS with Nostr relay signaling (kind 25050)
3. **Mic Capture** — ffmpeg-based native audio capture from default mic (bypasses VS Code webview sandbox)
4. **Level Meter** — Real-time green/yellow/red level bar showing mic input
5. **Peer Discovery** — kind 25050 events parsed in `handleNostrEvent()` to auto-connect peers
6. **Voice Settings Panel** — Gear icon (⚙) in voice room opens collapsible panel with sensitivity/noise gate sliders

---

## CRITICAL ISSUES TO FIX

### 1. REDUNDANT CODE — DEAD IFRAME APPROACH
The previous iframe-based mic approach is **dead code** that needs removal:
- `media/main.js` lines ~35-125: `_micServerPort`, `_micIframeReady`, `_micPendingStart`, `_initMicIframe()`, `_startMicViaIframe()`, `_stopMicViaIframe()`, `_sendMicSensitivity()`, `_sendMicNoiseGate()`, and the entire iframe `window.addEventListener('message')` handler for mic events
- `src/extension.ts`: The entire `startMicServer()` function (HTTP server approach), `micServer`, `micServerPort`, `getMicServerPort()`, `ensureMicServer()` — all dead code
- `src/webview/panel.ts` line ~5434: `<iframe id="mic-iframe" ...>` — dead HTML element
- The Privacy tab still has old "COMMUNICATIONS SETTINGS" section with its own sensitivity/noise gate sliders that are disconnected from the voice room settings

### 2. SETTINGS ARE DUPLICATED AND DISCONNECTED
- Voice room has a ⚙ settings panel with sensitivity + noise gate sliders
- Privacy tab has a separate "COMMUNICATIONS SETTINGS" section with its own sensitivity + noise gate sliders + mic test button
- These two sets of controls are NOT synchronized — changing one doesn't affect the other
- **FIX**: Remove the Privacy tab comms settings, keep only the in-room settings panel, or unify them

### 3. MISSING VOICE FEATURES (user explicitly requested)
- **Push-to-talk** — No PTT mode. Currently only live mic (always on when enabled). Need a PTT key binding + toggle between PTT and open mic modes
- **Input device selection** — `listAudioDevices()` exists in extension.ts but no UI to select a device. User is stuck with default mic
- **Output device selection** — No way to choose audio output
- **Volume controls** — No master volume, no per-participant volume
- **Mute/deafen** — No deafen button (mute incoming audio)
- **Echo cancellation / noise suppression toggles** — ffmpeg has these but they're not exposed
- **Audio quality settings** — Sample rate, bitrate options
- **Keybind configuration** — No way to set PTT key or toggle mic key

### 4. DOCUMENTS OUT OF SYNC
- `README.md` — Updated with voice features but references the iframe approach in some places
- `CHANGELOG.md` — Updated but doesn't mention ffmpeg approach
- `COMMS_ARCHITECTURE.md` — Still references "PeerJS/WebRTC" for audio transport but actual audio capture is now ffmpeg → extension host → webview (level data only, no actual audio streaming to peers yet)
- **The PeerJS P2P voice transport and the ffmpeg mic capture are NOT connected** — ffmpeg captures audio and sends level numbers to the webview, but the actual audio stream is NOT being sent to PeerJS peers. The `VoiceP2P.setLocalStream(stream)` call was removed when the iframe approach was removed. This means **other users cannot hear you**.

---

## FILE MAP

| File | What it does | Size |
|------|-------------|------|
| `src/extension.ts` | Extension entry point. Contains ffmpeg mic capture (`startMicCapture`, `stopMicCapture`, `listAudioDevices`, `setMicSensitivity`, `setMicNoiseGate`). Also contains dead HTTP mic server code. | 27KB |
| `src/webview/panel.ts` | Webview panel. Message handlers for mic capture, voice rooms, all NIP methods. Contains dead iframe HTML. | 228KB |
| `media/main.js` | Webview client JS. VoiceP2P class (PeerJS), voice room UI handlers, mic toggle, settings panel handlers. Contains dead iframe bridge code. | 291KB |
| `src/nostrService.ts` | Nostr protocol. 13 NIP-53 voice methods, 12 new NIP methods (39, 42, 58, 88, 90, 98, A0, WebRTC signaling). | 80KB |
| `media/peerjs.min.js` | PeerJS library for WebRTC P2P connections. | 93KB |

---

## ARCHITECTURE FLOW (current)

```
User clicks MIC ON
  → main.js sends 'startMicCapture' to extension
  → extension.ts spawns ffmpeg (dshow audio capture)
  → ffmpeg outputs raw PCM to stdout
  → extension computes RMS level, sends 'micLevel' to webview
  → main.js updates level bar UI

User joins room
  → main.js calls VoiceP2P.join(roomId)
  → PeerJS creates peer, connects to PeerJS cloud broker
  → Extension broadcasts peer ID via Nostr kind 25050
  → Other users' handleNostrEvent picks up kind 25050
  → VoiceP2P.connectToPeer() initiates WebRTC call

PROBLEM: ffmpeg audio is NOT streamed to PeerJS peers
  → VoiceP2P.setLocalStream() needs a MediaStream
  → ffmpeg produces raw PCM in Node.js, not a browser MediaStream
  → Need to either:
    a) Stream ffmpeg audio to a local WebSocket → webview creates MediaStream from it
    b) Use a different approach entirely for audio transport
```

---

## WHAT THE NEXT AGENT SHOULD DO

### Priority 1: Clean up dead code
- Remove all iframe mic code from main.js, extension.ts, panel.ts
- Remove duplicate settings from Privacy tab
- Consolidate to single settings location (in-room panel)

### Priority 2: Fix audio streaming to peers
- The ffmpeg capture works for level metering but doesn't stream audio to PeerJS peers
- Options:
  a) Stream ffmpeg PCM over a local WebSocket, reconstruct as MediaStream in webview via AudioWorklet
  b) Use Electron's `desktopCapturer` API if available in the webview context
  c) Accept that VS Code webviews can't do real-time voice and pivot to a companion app/browser tab approach

### Priority 3: Comprehensive voice settings
- Push-to-talk mode with configurable key
- Input/output device selection (UI for `listAudioDevices()`)
- Volume controls (master + per-participant)
- Mute/deafen buttons
- Echo cancellation toggle
- Audio quality presets

### Priority 4: Keep docs aligned
- Every code change should update README.md, CHANGELOG.md, COMMS_ARCHITECTURE.md
- The docs currently describe a mix of approaches

---

## BUILD STATUS
- **TypeScript: 0 errors**
- **VSIX: `champion-council-0.7.0.vsix` (20 files, 24.7MB) — builds clean**
- **npm: BROKEN** — npm install hangs/crashes. May need `npm cache clean --force` or delete node_modules and reinstall

---

## PACKAGE.JSON NOTES
- `naudiodon` was partially added to package.json by the failed npm install — check if it corrupted the lockfile
- `trystero` may also be in package.json from a failed install attempt — remove if present
- Core deps that work: `nostr-tools`, `peerjs` (loaded as media/peerjs.min.js, not npm)

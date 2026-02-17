# Communications & Identity Architecture
## Champion Council — NIP-53+ Full Stack

### Vision
A complete decentralized communications + identity + AI marketplace platform inside VS Code, 
built on Nostr protocol with P2P WebRTC voice, NIP-90 Data Vending Machines, and self-sovereign identity.

---

## 1. IDENTITY & AUTH LAYER

### 1.1 Nostr Native Identity (Already Have)
- Keypair generation + SecretStorage (NIP-01)
- NIP-05: DNS-based verification (`user@domain.com`)
- Profile metadata (kind 0)

### 1.2 Theme Import (Implemented)
- Simple hex color input for accent color customization
- No external OAuth or API dependencies
- Apply/Reset with live preview swatch

### 1.3 External Identity Claims — NIP-39 (Implemented)
- kind 10011 events with `i` tags
- Support: `github`, `discord`, `twitter`, `mastodon`, `telegram`
- Verification: Discord via OAuth2 token, GitHub via Gist, others via proof text
- Display verified badges next to usernames in chat/DMs/voice rooms

### 1.4 Relay Authentication — NIP-42 (NEW)
- `AUTH` message handling in WebSocket
- Sign challenge events (kind 22242)
- Enables access to private/paid relays

### 1.5 Remote Signing — NIP-46 (FUTURE)
- Nostr Connect protocol for delegated signing
- Enables "Login with Nostr" from external signers (Amber, nsecBunker)

---

## 2. COMMUNICATIONS LAYER

### 2.1 Public Chat (Already Have)
- kind 1 text notes with #t ouroboros-chat
- Reactions (kind 7)
- Auto-redaction engine (17 patterns)

### 2.2 Private DMs — NIP-17 Upgrade (NEW)
- Replace NIP-04 with NIP-17 (Gift Wrap + NIP-44 encryption)
- kind 14 (sealed), kind 13 (seal), kind 1059 (gift wrap)
- Forward secrecy, metadata protection

### 2.3 Voice Rooms — NIP-53 Complete (Implemented)
- **Signaling**: Nostr relay (kind 30312 room, kind 1311 live chat, kind 10312 presence)
- **Media transport**: PeerJS/WebRTC peer connections with Nostr relay signaling (kind 25050)
- **Architecture**:
  - Fully P2P via PeerJS — no server hosting required
  - Public STUN servers for NAT traversal (Google, Mozilla)
  - Peer discovery via Nostr ephemeral events (kind 25050, type `peerjs-offer`)
- **Audio capture**: ffmpeg captures 16kHz mono 16-bit PCM from OS mic via DirectShow (Node.js extension host)
- **Audio bridge**: Local WebSocket server (`ws://127.0.0.1:<random>`) streams raw PCM binary frames to webview
- **Audio processing**: AudioWorklet processor converts PCM to float32, resamples to AudioContext rate (linear interpolation)
- **MediaStream**: AudioWorklet → `MediaStreamAudioDestinationNode` → `VoiceP2P.setLocalStream()` → PeerJS WebRTC
- **Level metering**: RMS level computed from PCM in Node.js, sent as messages to webview for level bar UI
- **Audio controls**: Mute/unmute with real-time level bar (green/yellow/red), sensitivity slider, noise gate (in-room settings panel)
- **Speaking detection**: Per-participant `AnalyserNode` monitoring with visual indicators
- **kind 25050**: WebRTC signaling events (PeerJS offer/answer) via ephemeral events

### 2.4 Voice Messages — NIP-A0 (NEW)
- kind 1222 (voice note) + kind 1244 (voice message)
- Audio recording in webview via MediaRecorder API
- Upload to Blossom (NIP-B7) or inline base64 for small clips
- Playback widget in chat/DMs

### 2.5 Moderated Communities — NIP-72 (NEW)
- kind 34550 community definitions
- Approval-based posting
- Moderator roles from existing reputation system

### 2.6 Polls — NIP-88 (NEW)
- kind 1018 (poll) + kind 1068 (poll response)
- Community governance (feature votes, direction decisions)
- Integrated into chat and voice rooms

---

## 3. REPUTATION & BADGES LAYER

### 3.1 Reputation System (Already Have)
- Local point tracking: publish, zap, import, clean scans
- Levels: New → Active → Trusted → Verified

### 3.2 Badges — NIP-58 (NEW)
- kind 30009 (badge definition)
- kind 8 (badge award)
- kind 30008 (profile badges list)
- Badges for: First Publish, 10 Clean Scans, Trusted Publisher, Voice Room Host, etc.
- Visual badge display on profiles and in chat

### 3.3 Trusted Assertions — NIP-85 (NEW)
- Relay-endorsed trust signals
- Bridges reputation across the Nostr ecosystem

---

## 4. AI MARKETPLACE LAYER — NIP-90 Data Vending Machines (NEW)

### 4.1 Architecture
- Our MCP tools become NIP-90 service providers
- Users can request AI jobs via Nostr events
- Service providers (our capsule, or anyone) fulfill jobs
- Payment via Lightning zaps (NIP-57)

### 4.2 Job Types (kind 5xxx → 6xxx)
- 5100/6100: Text generation (LLM inference)
- 5200/6200: Text-to-image
- 5250/6250: Image-to-text (OCR, captioning)
- 5300/6300: Translation
- 5050/6050: Text extraction / summarization
- 5400/6400: Code generation
- Custom: Workflow execution (our unique offering)

### 4.3 Integration with Existing Systems
- MCP capsule tools exposed as NIP-90 service providers
- FelixBag artifacts as job inputs/outputs
- Workflow execution as a job type
- Reputation affects job priority and pricing

---

## 5. THEME & PERSONALIZATION

### 5.1 Theme Import (Implemented)
- Simple hex color input for accent color customization
- No external OAuth or API dependencies required
- Apply/Reset with live preview swatch in Privacy tab
- Accent color applied as `--accent` CSS variable across the UI

### 5.2 Self-Sovereign Identity
- All identity managed via Nostr keypairs (NIP-01)
- External identity claims via NIP-39 (GitHub, Discord, Twitter, etc.)
- No third-party OAuth gatekeeping — users own their identity

---

## 6. IMPLEMENTATION PRIORITY

### Phase 1 — ✅ Complete
1. ✅ PeerJS/WebRTC P2P voice transport (no server hosting)
2. ✅ NIP-53 voice rooms (create, join, leave, live chat, presence)
3. ✅ Real-time mic feedback (level bar, sensitivity, noise gate)
4. ✅ NIP-39 external identity claims
5. ✅ NIP-42 relay authentication
6. ✅ NIP-58 badges tied to reputation
7. ✅ NIP-88 polls
8. ✅ NIP-90 Data Vending Machines (submit + publish)
9. ✅ NIP-98 HTTP Auth
10. ✅ NIP-A0 voice messages
11. ✅ Theme import (simple hex color, no OAuth)
12. ✅ Communications Settings (mic sensitivity, noise gate, mic test)

### Phase 2 (Next)
1. NIP-17 encrypted DM upgrade (replace NIP-04)
2. NIP-72 moderated communities
3. NIP-90 DVM consumer mode (request AI jobs from network)
4. Badge rendering in chat/profiles
5. Poll UI in voice rooms

### Phase 3 (Future)
6. NIP-46 remote signing (Login with Nostr)
7. NIP-B7 Blossom file storage
8. NIP-29 relay-based groups
9. E2EE group messaging (Marmot protocol)
10. TURN relay fallback for restrictive NATs

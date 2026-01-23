# Copilot Instructions for ASsIstant Voice Gateway

## Project Overview
ASsIstant is a **voice gateway server** that bridges Twilio inbound calls with OpenAI's real-time voice API. It's a Node.js/Express service enabling AI-powered phone receptionists with per-company customization.

### Architecture
- **Twilio WebSocket** (`/twilio`) → Receives call audio (μ-law/PCMU format) from Twilio Media Streams
- **OpenAI Realtime WebSocket** → Bi-directional connection with OpenAI's GPT real-time model
- **Supabase** → Stores per-company AI profiles (system prompts, greeting scripts) and knowledge base items
- **Audio Format**: PCMU (G.711 μ-law) for telephony compatibility; base64-encoded in JSON messages

### Data Flow
1. Twilio sends audio stream via WebSocket with `company_id` query param
2. Server loads company context (persona, KB) from Supabase in `loadCompanyContext()`
3. Server connects to OpenAI, sends instructions (system prompt + grounded KB)
4. Audio flows: `Twilio → OpenAI` (input_audio_buffer.append) and `OpenAI → Twilio` (media events)
5. When call ends, both WebSocket connections close gracefully

## Critical Developer Workflows

### Starting the Service
```bash
npm install
npm start
```
Server runs on PORT (default 3000) and logs: `Voice gateway listening on :3000`

### Environment Setup (.env)
- `OPENAI_API_KEY` (required): OpenAI API key for realtime model
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (required): Database access
- `VOICE_GATEWAY_TOKEN` (optional): Shared secret to validate WebSocket connections
- `PORT` (default 3000): Server port

### WebSocket Connection URL
```
ws://localhost:3000/twilio?company_id=<uuid>&token=<optional>
```
Twilio Media Streams connector sends HTTP POST with TwiML that directs audio to this WebSocket.

### Health Check
```
GET http://localhost:3000/health → "ok"
```

## Key Patterns & Conventions

### Company Context Loading (`loadCompanyContext`)
- Queries `ai_profiles` table for system_prompt, greeting_script, disclosure_script
- Queries `knowledge_base_items` (limited to 25 active items for token efficiency)
- Formats KB into readable text blocks: `[type] title\nQ: question\nA: answer`
- Returns object with normalized defaults (ensures graceful fallback if missing)

### OpenAI Session Configuration
- Uses `session.update` event type to configure audio format and VAD (Voice Activity Detection)
- Key settings:
  - `input.format.type: "audio/pcmu"` → Matches Twilio's μ-law format
  - `turn_detection.type: "server_vad"` → Auto-responds when speech detected
  - `silence_duration_ms: 600` → Pause threshold before triggering response
  - `output.format.type: "audio/pcmu"` → Ensures Twilio compatibility

### Instruction Prompt Structure
Instructions combine:
1. System prompt (company persona)
2. Knowledge base context (formatted with Q&A pairs)
3. Phone-specific directives (be warm, short answers, one question at a time, handle uncertainty gracefully)

### JSON Message Parsing
- Use `safeJsonParse()` helper (returns `null` on error) for all WebSocket messages
- Handle missing fields gracefully; don't assume event structure is consistent across OpenAI API versions

### Audio Forwarding Logic
- **Twilio → OpenAI**: Extract base64 from `msg.media.payload`, send as `input_audio_buffer.append` event
- **OpenAI → Twilio**: Extract base64 from multiple possible event properties (handles API version drift):
  - `msg.audio.data`, `msg.delta.audio`, `msg.response.audio.data`, `msg.output_audio.data`
  - Send as `media` event with `streamSid` and `payload`

### Connection Lifecycle Events
- **Twilio `start`**: Captures `streamSid` (required for media events back to Twilio)
- **Twilio `stop`**: Closes both connections cleanly
- **OpenAI `close`**: Closes Twilio connection (Twilio handles call fallback via TwiML)

## File Locations

- **Main server**: [server.js](../server.js) – All WebSocket handling, OpenAI integration, Supabase queries
- **Dependencies**: [package.json](../package.json) – Express, ws, @supabase/supabase-js, dotenv
- **Config template**: [.env](.env) – Required and optional environment variables

## Common Tasks

**Add a new company AI profile**
- Insert row in Supabase `ai_profiles` table with `company_id` and `system_prompt`
- Add KB items in `knowledge_base_items` table with same `company_id` and `is_active: true`

**Modify call greeting/disclosure**
- Update `greeting_script` or `disclosure_script` in `ai_profiles` (server reloads per-call)

**Debug audio issues**
- Verify `PCMU` format: Twilio must send μ-law encoded audio
- Uncomment debug logging in `openaiWs.on("message")` to inspect event structure
- Check OpenAI session config matches current API version

**Handle API version drift**
- Audio event structure may vary; `safeJsonParse()` + multiple field checks insulate against this
- When upgrading OpenAI API, verify `session.update` event schema matches current docs

## Testing Notes
- Health endpoint: `curl http://localhost:3000/health`
- Twilio Media Streams requires real phone calls; use Twilio console to test call routing
- No automated tests in repo; manual integration testing through Twilio required

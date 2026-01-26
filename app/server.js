import "dotenv/config";
import http from "http";
import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import { createClient } from "@supabase/supabase-js";

const BUILD_STAMP = "2026-01-26T20:10Z-mainserver-v3";
console.log("BUILD_STAMP=", BUILD_STAMP);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const VOICE_GATEWAY_TOKEN = process.env.VOICE_GATEWAY_TOKEN;
const PORT = Number(process.env.PORT || 3000);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

function logAI(...args) { console.log("🧠 OPENAI |", ...args); }
function logTW(...args) { console.log("📞 TWILIO |", ...args); }

function safeJsonParse(s) { try { return JSON.parse(s); } catch { return null; } }

function xmlEscapeAttr(s) {
  if (s === undefined || s === null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function loadCompanyContext(companyId) {
  const { data: profile } = await supabase
    .from("ai_profiles")
    .select("system_prompt, greeting_script, disclosure_script")
    .eq("company_id", companyId)
    .maybeSingle();
  const { data: kb } = await supabase
    .from("knowledge_base_items")
    .select("type,title,question,answer")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .limit(25);
  const kbText = (kb || [])
    .map(i => `[${i.type}] ${i.title}\n${i.question ? `Q: ${i.question}\n` : ""}A: ${i.answer}`)
    .join("\n\n");
  return {
    systemPrompt: profile?.system_prompt || "You are a friendly receptionist.",
    kbText,
    greeting: profile?.greeting_script || "Hi! How can I help?",
    disclosure: profile?.disclosure_script || "Quick note: I'm an AI assistant.",
  };
}

function sendToOpenAI(ws, obj) {
  const raw = JSON.stringify(obj);
  console.log("🧠 OPENAI | SENDING TO WS:", raw);
  ws.send(raw);
}

function openaiConnect({ instructions, onReady, onAudioDelta, onError }) {
  const url = "wss://api.openai.com/v1/realtime?model=gpt-realtime";
  const headers = { Authorization: `Bearer ${OPENAI_API_KEY}` };
  console.log("🧠 OPENAI | CONNECTING TO:", url);
  if (headers.Authorization) {
    const masked = `${headers.Authorization.slice(0, 10)}…${headers.Authorization.slice(-6)}`;
    console.log("🧠 OPENAI | HEADERS:", { Authorization: masked });
  }
  const ws = new WebSocket(url, "realtime", { headers });
  ws._ready = false;
  ws._activeResponse = false;
  let greetingSent = false;
  let sessionTypeMode = "with"; // "with" or "without"
  let sessionUpdateAttempts = 0;

  function buildSessionUpdate() {
    const audio = {
      audio: {
        input: { format: { type: "audio/pcmu" } },
        output: { format: { type: "audio/pcmu" } }
      }
    };
    const session = sessionTypeMode === "with"
      ? { type: "realtime", instructions: instructions, ...audio }
      : { instructions: instructions, ...audio };
    return { type: "session.update", session };
  }

  function sendSessionUpdate(reason) {
    const sessionUpdate = buildSessionUpdate();
    sessionUpdateAttempts += 1;
    logAI(`SENDING SESSION.UPDATE PAYLOAD (${reason}) #${sessionUpdateAttempts}:`, JSON.stringify(sessionUpdate));
    sendToOpenAI(ws, sessionUpdate);
  }
  ws.on("open", () => logAI("WS OPEN"));
  ws.on("message", data => {
    let evt; try { evt = JSON.parse(data); } catch { return; }
    logAI("EVENT:", evt.type, JSON.stringify(evt));
    if (evt.type === "session.created") {
      // Only send session.update after session.created is received
      sendSessionUpdate("after session.created");
    }
    if (evt.type === "session.updated") {
      logAI("SUCCESS: session.updated received. Ready for audio.");
      ws._ready = true;
      if (!greetingSent) {
        greetingSent = true;
        sendToOpenAI(ws, { type: "response.create" });
      }
      onReady?.();
    }
    if (evt.type === "error") {
      logAI("ERROR PAYLOAD:", JSON.stringify(evt));
      const err = evt.error || {};
      const param = err.param;
      const code = err.code;
      // Adaptive fallback for session.type requirement mismatch
      if (param === "session.type" && code === "unknown_parameter" && sessionTypeMode === "with") {
        sessionTypeMode = "without";
        sendSessionUpdate("fallback: remove session.type");
      } else if (param === "session.type" && code === "missing_required_parameter" && sessionTypeMode === "without") {
        sessionTypeMode = "with";
        sendSessionUpdate("fallback: add session.type");
      }
      onError?.(evt);
    }
    if (evt.type === "input_audio_buffer.committed") {
      if (!ws._activeResponse) {
        ws._activeResponse = true;
        sendToOpenAI(ws, { type: "response.create" });
      }
    }
    if (evt.type === "response.audio.delta" || evt.type === "response.output_audio.delta") {
      if (evt.delta) onAudioDelta?.(evt.delta);
    }
    if (evt.type === "response.done") {
      ws._activeResponse = false;
    }
  });
  ws.on("error", e => logAI("WS ERROR", e?.message || e));
  ws.on("close", (c, r) => logAI("WS CLOSE", c, r?.toString?.() || r));
  return ws;
}

app.get("/health", (_, res) => res.status(200).send("ok"));

app.post("/twiml", express.urlencoded({ extended: false }), (req, res) => {
  const companyId = req.query.company_id || process.env.DEFAULT_COMPANY_ID;
  const token = req.query.token || process.env.VOICE_GATEWAY_TOKEN;

  if (!companyId) {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Say>This number is not configured yet.</Say>\n</Response>`;
    res.set("Content-Type", "text/xml; charset=utf-8");
    res.status(200).send(twiml);
    return;
  }

  const wsUrl = `wss://${req.headers.host}/twilio`;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Say>Please hold while we connect you.</Say>\n  <Pause length="1"/>\n  <Connect>\n    <Stream url="${xmlEscapeAttr(wsUrl)}" track="inbound_track" content-type="audio/x-mulaw;rate=8000">\n      <Parameter name="company_id" value="${xmlEscapeAttr(companyId)}"/>\n      <Parameter name="token" value="${xmlEscapeAttr(token)}"/>\n    </Stream>\n  </Connect>\n  <Pause length="60"/>\n</Response>`;

  res.set("Content-Type", "text/xml; charset=utf-8");
  res.status(200).send(twiml);
});

app.get("/twilio", (_, res) => res.status(426).send("This endpoint is WebSocket-only. Use wss://.../twilio"));

server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname !== "/twilio") return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
  } catch { socket.destroy(); }
});

wss.on("connection", async (twilioWs, req) => {
  let streamSid = null;
  let openaiWs = null;
  let ready = false;
  const audioBuffer = [];
  function flushBuffer() {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN || !ready) return;
    while (audioBuffer.length) {
      const payload = audioBuffer.shift();
      sendToOpenAI(openaiWs, { type: "input_audio_buffer.append", audio: payload });
    }
  }
  twilioWs.on("message", async buf => {
    const msg = safeJsonParse(buf.toString());
    if (!msg) return;
    if (msg.event === "start") {
      streamSid = msg?.start?.streamSid || streamSid;
      const params = msg?.start?.customParameters || {};
      const companyId = params.company_id || params.companyId;
      const token = params.token;
      if (VOICE_GATEWAY_TOKEN && token !== VOICE_GATEWAY_TOKEN) {
        if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(1008, "Bad token");
        return;
      }
      if (!companyId) return;
      const ctx = await loadCompanyContext(companyId);
      const instructions = `\n${ctx.systemPrompt}\n\nKnowledge Base:\n${ctx.kbText}\n\nPhone style:\n- Natural, warm receptionist\n- Short answers; ask one question at a time\n\nStart of call:\n- Greet naturally and ask what they need.`.trim();
      openaiWs = openaiConnect({
        instructions,
        onReady: () => { ready = true; flushBuffer(); },
        onAudioDelta: delta => {
          if (!streamSid) return;
          if (twilioWs.readyState !== WebSocket.OPEN) return;
          twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: delta } }));
        },
      });
      return;
    }
    if (msg.event === "media") {
      const payload = msg.media?.payload;
      if (!payload) return;
      if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN || !ready) {
        audioBuffer.push(payload);
        if (audioBuffer.length > 300) audioBuffer.shift();
        return;
      }
      sendToOpenAI(openaiWs, { type: "input_audio_buffer.append", audio: payload });
      return;
    }
    if (msg.event === "stop") {
      try { openaiWs?.close(); } catch {}
      try { twilioWs?.close(); } catch {}
      return;
    }
  });
  twilioWs.on("close", () => { try { openaiWs?.close(); } catch {} });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Voice gateway listening on :${PORT}`);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Voice gateway listening on :${PORT}`);
});


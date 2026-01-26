// Minimal placeholder after full reset.

// Ready for new implementation.
import "dotenv/config";
import http from "http";
import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import { createClient } from "@supabase/supabase-js";

/**
 * =========================
 * ENV
 * =========================
 */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const VOICE_GATEWAY_TOKEN = process.env.VOICE_GATEWAY_TOKEN; // optional but recommended
const DEFAULT_COMPANY_ID = process.env.DEFAULT_COMPANY_ID || null;

// Railway/Twilio usually wants 8080; keep 8080 as default.
const PORT = Number(process.env.PORT || 8080);

if (!OPENAI_API_KEY) console.warn("Warning: Missing OPENAI_API_KEY");
if (!SUPABASE_URL) console.warn("Warning: Missing SUPABASE_URL");
if (!SUPABASE_SERVICE_ROLE_KEY) console.warn("Warning: Missing SUPABASE_SERVICE_ROLE_KEY");

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    : null;

/**
 * =========================
 * LOGGING
 * =========================
 */
const logAI = (...args) => console.log("🧠 OPENAI |", ...args);
const logTW = (...args) => console.log("📞 TWILIO |", ...args);

/**
 * =========================
 * EXPRESS
 * =========================
 */
const app = express();

app.use((req, res, next) => {
  console.log("HTTP IN:", req.method, req.url, "host=", req.headers.host, "ip=", req.socket?.remoteAddress);
  next();
});

app.get("/", (_, res) => res.status(200).send("ok"));
app.get("/health", (_, res) => res.status(200).send("ok"));

function xmlEscapeAttr(s) {
  if (s === undefined || s === null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

app.post("/twiml", express.urlencoded({ extended: false }), (req, res) => {
  const companyId = req.query.company_id || DEFAULT_COMPANY_ID;
  const token = req.query.token || process.env.VOICE_GATEWAY_TOKEN;

  console.log("TWIML_DEBUG query=", req.query);
  console.log("TWIML_DEBUG DEFAULT_COMPANY_ID=", DEFAULT_COMPANY_ID);
  console.log("TWIML_DEBUG companyId=", companyId, "tokenPresent=", !!token);

  if (!companyId) {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>This number is not configured yet.</Say>
</Response>`;
    res.set("Content-Type", "text/xml; charset=utf-8");
    return res.status(200).send(twiml);
  }

  // IMPORTANT: Twilio connects to wss://<your-host>/twilio (NOT /twiml)
  const wsUrl = `wss://${req.headers.host}/twilio`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Please hold while we connect you.</Say>
  <Pause length="1"/>
  <Connect>
    <Stream url="${xmlEscapeAttr(wsUrl)}" track="inbound_track" content-type="audio/x-mulaw;rate=8000">
      <Parameter name="company_id" value="${xmlEscapeAttr(companyId)}"/>
      <Parameter name="token" value="${xmlEscapeAttr(token)}"/>
    </Stream>
  </Connect>
  <Pause length="60"/>
</Response>`;

  res.set("Content-Type", "text/xml; charset=utf-8");
  return res.status(200).send(twiml);
});

// handy for browser debugging
app.get("/twiml", (req, res) => {
  req.method = "POST";
  return app._router.handle(req, res, () => {});
});

app.get("/version", (_, res) => {
  res.status(200).json({
    name: "voice-gateway",
    commit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    time: new Date().toISOString(),
  });
});

app.get("/twilio", (_, res) => {
  res.status(426).send("This endpoint is WebSocket-only. Use wss://.../twilio");
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
  // Keep running to avoid killing active calls
});

/**
 * =========================
 * SERVER + WS UPGRADE
 * =========================
 */
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// REGISTER UPGRADE ONCE (critical)
server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname !== "/twilio") return socket.destroy();

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } catch (e) {
    socket.destroy();
  }
});

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * =========================
 * SUPABASE COMPANY CONTEXT
 * =========================
 */
async function loadCompanyContext(companyId) {
  if (!supabase) {
    return {
      systemPrompt: "You are a friendly receptionist.",
      kbText: "",
      greeting: "Hi! How can I help?",
      disclosure: "Quick note: I'm an AI assistant.",
    };
  }

  const { data: profile, error: profileErr } = await supabase
    .from("ai_profiles")
    .select("system_prompt, greeting_script, disclosure_script")
    .eq("company_id", companyId)
    .maybeSingle();

  if (profileErr) throw profileErr;

  const { data: kb, error: kbErr } = await supabase
    .from("knowledge_base_items")
    .select("type,title,question,answer")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .limit(25);

  if (kbErr) throw kbErr;

  const kbText = (kb || [])
    .map((i) => {
      const q = i.question ? `Q: ${i.question}\n` : "";
      return `[${i.type}] ${i.title}\n${q}A: ${i.answer}`;
    })
    .join("\n\n");

  return {
    systemPrompt: profile?.system_prompt || "You are a friendly receptionist.",
    kbText,
    greeting: profile?.greeting_script || "Hi! How can I help?",
    disclosure: profile?.disclosure_script || "Quick note: I'm an AI assistant.",
  };
}

/**
 * =========================
 * OPENAI REALTIME CONNECTOR
 * - GA first
 * - Auto fallback to Beta once if server complains about session.type
 * =========================
 */
function openaiConnect({ instructions, onReady, onAudioDelta, onError } = {}) {
  const url = "wss://api.openai.com/v1/realtime?model=gpt-realtime";

  // GA FIRST: DO NOT send "OpenAI-Beta: realtime=v1"
  const ws = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
  });

  let configured = false;
  let retriedAsBeta = false;

  function send(obj) {
    const raw = JSON.stringify(obj);
    logAI("OPENAI OUTBOUND:", raw);
    ws.send(raw);
  }

  function sendGAUpdate() {
    send({
      type: "session.update",
      session: {
        type: "realtime",
        instructions,

        // Twilio μ-law 8k => audio/pcmu
        audio: {
          input: { format: { type: "audio/pcmu" } },
          output: { format: { type: "audio/pcmu" } },
        },

        voice: "marin",

        turn_detection: {
          type: "server_vad",
          create_response: true,
          interrupt_response: true,
          silence_duration_ms: 600,
        },
      },
    });
  }

  function sendBetaUpdate() {
    // Beta shape (no session.type)
    send({
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        instructions,
        voice: "marin",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: {
          type: "server_vad",
          create_response: true,
          interrupt_response: true,
          silence_duration_ms: 600,
        },
      },
    });
  }

  ws.on("open", () => logAI("WS OPEN"));

  ws.on("message", (data) => {
    let evt;
    try {
      evt = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
    } catch {
      return;
    }

    if (evt?.type) logAI("OPENAI EVENT:", evt.type);

    if (evt?.type === "session.created") {
      if (!configured) {
        configured = true;
        sendGAUpdate();
      }
      return;
    }

    if (evt?.type === "session.updated") {
      onReady?.();
      return;
    }

    // audio deltas (GA + some variants)
    if ((evt?.type === "response.output_audio.delta" || evt?.type === "response.audio.delta") && evt?.delta) {
      onAudioDelta?.(evt.delta);
      return;
    }

    if (evt?.type === "error") {
      const msg = evt?.error?.message || "";
      const param = evt?.error?.param || "";
      logAI("ERROR PAYLOAD:", JSON.stringify(evt, null, 2));
      onError?.(evt);

      // If GA field is "unknown", you're effectively on Beta => retry once
      if (!retriedAsBeta && (param === "session.type" || msg.includes("Unknown parameter: 'session.type'"))) {
        retriedAsBeta = true;
        logAI("Detected Beta interface; retrying session.update with Beta schema once.");
        sendBetaUpdate();
      }
    }
  });

  ws.on("error", (e) => logAI("WS ERROR", e?.message || e));
  ws.on("close", (c, r) => logAI("WS CLOSE", c, r?.toString?.() || r));

  return ws;
}

/**
 * =========================
 * TWILIO WS BRIDGE
 * =========================
 */
wss.on("connection", async (twilioWs, req) => {
  console.log("WS CONNECTED:", req.url);

  let companyId = null;
  let token = null;

  let streamSid = null;
  let callSid = null;

  let openaiWs = null;
  let ready = false;

  // base64 audio frames buffered until OpenAI session.updated
  const audioBuffer = [];

  twilioWs.on("close", (code, reason) => {
    console.log("WS CLOSED:", code, reason?.toString?.() || reason);
    try {
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
    } catch {}
  });

  twilioWs.on("error", (err) => console.log("WS ERROR:", err));

  twilioWs.on("message", async (buf) => {
    const msg = safeJsonParse(buf.toString());
    if (!msg) return;

    logTW("MSG:", msg.event || msg.type || null);

    // START
    if (msg.event === "start") {
      streamSid = msg?.start?.streamSid || msg?.streamSid || streamSid;
      callSid = msg?.start?.callSid || msg?.callSid || callSid;

      logTW("start streamSid=", streamSid, "callSid=", callSid);
      logTW("start customParameters=", msg?.start?.customParameters);

      const params = msg?.start?.customParameters || {};
      const startCompanyId = params.company_id || params.companyId || DEFAULT_COMPANY_ID;
      const startToken = params.token;

      console.log("START companyId=", startCompanyId, "tokenPresent=", !!startToken);

      if (VOICE_GATEWAY_TOKEN && startToken !== VOICE_GATEWAY_TOKEN) {
        console.log("TOKEN MISMATCH at START");
        if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(1008, "Bad token");
        return;
      }

      if (!startCompanyId) {
        console.log("START missing company_id");
        return;
      }

      companyId = startCompanyId;
      token = startToken;

      let ctx;
      try {
        ctx = await loadCompanyContext(companyId);
      } catch (err) {
        console.error("Failed to load company context:", err);
        if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(1011, "Server setup failed");
        return;
      }

      const instructions = `
${ctx.systemPrompt}

Knowledge Base (use only if relevant; keep answers short and human):
${ctx.kbText}

Phone style:
- Sound natural and warm, like a real receptionist.
- Short answers, ask one question at a time.
- If unsure, ask a clarifying question.

Start of call:
- Greet the caller naturally and ask what they need.
`.trim();

      openaiWs = openaiConnect({
        instructions,
        onReady: () => {
          ready = true;
          logAI("READY=TRUE");
          logAI("FLUSHING BUFFER", audioBuffer.length);

          while (audioBuffer.length && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            const payload = audioBuffer.shift();
            openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: payload }));
          }
        },
        onAudioDelta: (delta) => {
          // Send AI audio back to Twilio
          if (!streamSid) return;
          if (twilioWs.readyState !== WebSocket.OPEN) return;

          twilioWs.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: delta },
            })
          );
        },
        onError: () => {
          // keep going; errors will be logged already
        },
      });

      return;
    }

    // MEDIA (Twilio -> OpenAI)
    if (msg.event === "media") {
      const payload = msg.media?.payload;
      if (!payload) return;

      if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN || !ready) {
        audioBuffer.push(payload);
        if (audioBuffer.length > 200) audioBuffer.shift();
        return;
      }

      openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: payload }));
      return;
    }

    // STOP
    if (msg.event === "stop") {
      logTW("stop received");
      try {
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
      } catch {}
      return;
    }
  });
});

/**
 * =========================
 * START SERVER
 * =========================
 */
server.on("error", (err) => {
  console.error("Server error:", err);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Voice gateway listening on :${PORT}`);
  console.log(`WebSocket path: ws(s)://<host>/twilio`);
  console.log("LISTEN_ADDR:", server.address());

  (async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      console.log("SELF_CHECK /health", res.status);
    } catch (err) {
      console.error("SELF_CHECK /health failed:", err);
    }
  })();
});

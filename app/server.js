import "dotenv/config";
import http from "http";
import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import { createClient } from "@supabase/supabase-js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const VOICE_GATEWAY_TOKEN = process.env.VOICE_GATEWAY_TOKEN; // optional but recommended
const PORT = Number(process.env.PORT || 3000);

if (!OPENAI_API_KEY) console.warn("Warning: Missing OPENAI_API_KEY");
if (!SUPABASE_URL) console.warn("Warning: Missing SUPABASE_URL");
if (!SUPABASE_SERVICE_ROLE_KEY) console.warn("Warning: Missing SUPABASE_SERVICE_ROLE_KEY");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const app = express();

app.use((req, res, next) => {
  console.log(
    "HTTP IN:",
    req.method,
    req.url,
    "host=",
    req.headers.host,
    "ip=",
    req.socket?.remoteAddress
  );
  next();
});

app.get("/", (_, res) => res.status(200).send("ok"));
app.get("/health", (_, res) => res.status(200).send("ok"));
app.post(
  "/twiml",
  express.urlencoded({ extended: false }),
  (req, res) => {
    const companyId = req.query.company_id || process.env.DEFAULT_COMPANY_ID;
    const token = req.query.token || process.env.VOICE_GATEWAY_TOKEN;

    console.log("TWIML_DEBUG query=", req.query);
    console.log("TWIML_DEBUG DEFAULT_COMPANY_ID=", process.env.DEFAULT_COMPANY_ID);
    console.log("TWIML_DEBUG companyId=", companyId, "tokenPresent=", !!token);

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
  }
);

app.get("/twiml", (req, res) => {
  const companyId = req.query.company_id || process.env.DEFAULT_COMPANY_ID;
  const token = req.query.token || process.env.VOICE_GATEWAY_TOKEN;

  console.log("TWIML_DEBUG query=", req.query);
  console.log("TWIML_DEBUG DEFAULT_COMPANY_ID=", process.env.DEFAULT_COMPANY_ID);
  console.log("TWIML_DEBUG companyId=", companyId, "tokenPresent=", !!token);

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

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
  // Optional: exit so process manager can restart the app
  process.exit(1);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function xmlEscapeAttr(s) {
  if (s === undefined || s === null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function loadCompanyContext(companyId) {
  // Pull per-company persona + a small KB summary for grounding
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

function openaiConnect({ instructions }) {
  // Official docs: wss://api.openai.com/v1/realtime?model=gpt-realtime :contentReference[oaicite:6]{index=6}
  const url = "wss://api.openai.com/v1/realtime?model=gpt-realtime";
  const ws = new WebSocket(url, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
  });

  ws.on("open", () => {
    // Configure session for telephony μ-law audio and server-side VAD auto-response.
    // OpenAI supports PCMU (G.711 μ-law) format and turn_detection with create_response. :contentReference[oaicite:7]{index=7}
    const sessionUpdate = {
      type: "session.update",
      session: {
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        type: "realtime",
        model: "gpt-realtime",
        output_modalities: ["audio"],
        instructions,
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            turn_detection: {
              type: "server_vad",
              create_response: true,
              silence_duration_ms: 600
            }
          },
          output: {
            format: { type: "audio/pcmu" },
            // voice can be changed later; keep default unless you’ve chosen one
            voice: "marin"
          }
        }
      }
    };

    ws.send(JSON.stringify(sessionUpdate));

    // Immediately request the assistant to create an initial audio response
    const createResp = {
      type: "response.create",
      response: {
        instructions: "Greet the caller naturally and ask what they need.",
        modalities: ["audio"]
      }
    };
    try {
      ws.send(JSON.stringify(createResp));
    } catch (err) {
      console.error("Failed to send response.create:", err);
    }
  });

  return ws;
}

wss.on("connection", async (twilioWs, req) => {
  console.log("WS CONNECTED:", req.url);
  twilioWs.on("close", (code, reason) => {
    console.log("WS CLOSED:", code, reason?.toString?.() || reason);
  });
  twilioWs.on("error", (err) => console.log("WS ERROR:", err));
  const url = new URL(req.url, `http://${req.headers.host}`);
  // company_id will be provided via Twilio start.customParameters
  let companyId = null;
  let token = null;
  let streamSid = null;
  let callSid = null;
  let openaiWs = null;
  let ready = false;
  const pendingAudio = [];

  // Log Twilio websocket events for debugging
  twilioWs.on("message", (buf) => {
    try {
      const msg = safeJsonParse(buf.toString());
      if (!msg) return;
      console.log("TWILIO MSG:", msg.event || msg.type || null);

      // call async handler and catch errors to avoid crashing
      (async () => {
        try {
          await handleTwilioMessage(msg);
        } catch (e) {
          console.error("TWILIO_HANDLER_ERR", e);
        }
      })();
    } catch (e) {
      console.error("TWILIO_HANDLER_ERR", e);
    }
  });

  // Move original twilio message handling into a named function so we can call it from logger above
  async function handleTwilioMessage(msg) {
    if (!msg) return;

    if (msg.event === "start") {
      // set stream and call ids from the Twilio start event
      streamSid = msg?.start?.streamSid || msg?.streamSid || streamSid;
      callSid = msg?.start?.callSid || msg?.callSid || callSid;
      console.log("TWILIO start streamSid=", streamSid, "callSid=", callSid);
      console.log("TWILIO start customParameters=", msg?.start?.customParameters);

      // Extract customParameters
      const cp = msg?.start?.customParameters || {};
      const cid = cp.company_id || cp.companyId;
      const tkn = cp.token;
      companyId = companyId || cid;
      token = token || tkn;

      console.log("START companyId=", companyId, "callSid=", callSid, "streamSid=", streamSid);

      // Validate token
      if (VOICE_GATEWAY_TOKEN && token !== VOICE_GATEWAY_TOKEN) {
        twilioWs.close(1008, "Bad token");
        return;
      }

      if (!companyId) {
        twilioWs.close(1008, "Missing company_id");
        return;
      }

      // Load company context and start OpenAI connection
      let ctx;
      try {
        ctx = await loadCompanyContext(companyId);
      } catch (err) {
        console.error("Failed to load company context:", err);
        twilioWs.close(1011, "Server setup failed");
        return;
      }

      const instructions = `\n${ctx.systemPrompt}\n\nKnowledge Base (use only if relevant; keep answers short and human):\n${ctx.kbText}\n\nPhone style:\n- Sound natural and warm, like a real receptionist.\n- Short answers, ask one question at a time.\n- If the caller asks "how are you", respond like a human.\n- If unsure, ask a clarifying question or offer to transfer to a person.\n\nStart of call:\n- Greet the caller naturally and ask what they need.`.trim();

      openaiWs = openaiConnect({ instructions });

      openaiWs.on("message", (buf) => {
        const msg = safeJsonParse(buf.toString());
        if (!msg) return;
        console.log("OPENAI MSG:", msg.type || msg);

        const audioB64 = msg?.audio?.data || msg?.delta?.audio || msg?.response?.audio?.data || msg?.output_audio?.data;
        if (audioB64 && streamSid && twilioWs.readyState === WebSocket.OPEN) {
          const twilioOut = { event: "media", streamSid, media: { payload: audioB64 } };
          try {
            twilioWs.send(JSON.stringify(twilioOut));
            console.log("OPENAI->TWILIO audio bytes=", audioB64.length, "streamSid=", streamSid);
          } catch (err) {
            console.error("Failed to send media to Twilio:", err);
          }
        }
      });

      openaiWs.on("close", () => {
        if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
      });

      ready = true;
      console.log("BUFFERED_FRAMES=", pendingAudio.length);
      // Flush buffered audio
      while (pendingAudio.length && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        const payload = pendingAudio.shift();
        try { openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: payload })); } catch (e) { console.error("Failed to flush buffered audio:", e); }
      }

      // Ask OpenAI to greet immediately
      try {
        const greet = { type: "response.create", response: { instructions: "Greet the caller naturally and ask what they need.", modalities: ["audio"] } };
        openaiWs.send(JSON.stringify(greet));
        console.log("Sent response.create to OpenAI on start");
      } catch (err) {
        console.error("Error sending response.create on start:", err);
      }

      return;
    }

    if (msg.event === "media") {
      const payload = msg?.media?.payload;
      console.log("TWILIO EVENT: media chunk", { streamSid, len: payload?.length || 0 });
      if (!payload) return;
      if (!ready) {
        if (pendingAudio.length < 50) pendingAudio.push(payload);
        console.log("BUFFERED_FRAMES=", pendingAudio.length);
        return;
      }

      if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
      const append = { type: "input_audio_buffer.append", audio: payload };
      try { openaiWs.send(JSON.stringify(append)); } catch (err) { console.error("Failed to forward media to OpenAI:", err); }
      return;
    }

    if (msg.event === "stop") {
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
      if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
    }
  }

  // Allow connection even if query params are absent; we'll validate after 'start' event

  // Note: actual message processing is now handled in the logged handler above

  twilioWs.on("close", () => {
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });
});

server.on("upgrade", (req, socket, head) => {
  console.log("UPGRADE REQ:", req.url, "headers.upgrade=", req.headers.upgrade);
  try {
    const { pathname } = new URL(req.url, `http://${req.headers.host}`);
    if (pathname !== "/twilio") {
      const body = "Not Found";
      socket.write(
        `HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(
          body
        )}\r\nConnection: close\r\n\r\n${body}`
      );
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } catch (e) {
    const body = "Bad Request";
    try {
      socket.write(
        `HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(
          body
        )}\r\nConnection: close\r\n\r\n${body}`
      );
    } catch (err) {
      // ignore
    }
    socket.destroy();
  }
});

server.on("error", (err) => {
  console.error("Server error:", err);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Voice gateway listening on :${PORT}`);
  console.log(`WebSocket path: ws(s)://<host>/twilio?company_id=<uuid>&token=<optional>`);
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

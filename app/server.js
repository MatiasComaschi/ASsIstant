import "dotenv/config";
import http from "http";
import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import { createClient } from "@supabase/supabase-js";

const BUILD_STAMP = "2026-01-26T20:10Z-mainserver-v3";
console.log("BUILD_STAMP=", BUILD_STAMP);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const VOICE_GATEWAY_TOKEN = process.env.VOICE_GATEWAY_TOKEN;
const PORT = Number(process.env.PORT || 3000);

const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    })
  : null;

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
  if (!supabase) {
    return {
      systemPrompt: "You are a friendly receptionist.",
      kbText: "",
      greeting: "Hi! How can I help?",
      disclosure: "Quick note: I'm an AI assistant.",
    };
  }
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

function formatKnowledgeBaseItems(kbItems) {
  return (kbItems || [])
    .map(i => {
      const type = i?.type ?? "kb";
      const title = i?.title ?? "";
      const question = i?.question;
      const answer = i?.answer ?? "";
      return `[${type}] ${title}`.trim() + `\n` + (question ? `Q: ${question}\n` : "") + `A: ${answer}`;
    })
    .join("\n\n");
}

async function fetchAiContextFromSupabaseFunction(companyId) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  const endpoint = `${SUPABASE_URL.replace(/\/$/, "")}/functions/v1/get-ai-context?company_id=${encodeURIComponent(companyId)}`;
  const res = await fetch(endpoint, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      apikey: SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Supabase get-ai-context failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return await res.json();
}

async function getAiContext(companyId) {
  // Prefer Edge Function context (Railway-friendly), fallback to direct DB queries.
  try {
    const fnCtx = await fetchAiContextFromSupabaseFunction(companyId);
    if (fnCtx) {
      const kbText =
        fnCtx.kb_text ||
        fnCtx.knowledge_base_text ||
        formatKnowledgeBaseItems(fnCtx.knowledge_base_items || fnCtx.kb_items);

      return {
        systemPrompt: fnCtx.system_prompt || fnCtx.instructions || "You are a friendly receptionist.",
        kbText: kbText || "",
        greeting: fnCtx.greeting_script || fnCtx.greeting || "Hi! How can I help?",
        disclosure: fnCtx.disclosure_script || fnCtx.disclosure || "Quick note: I'm an AI assistant.",
        voice: fnCtx.voice,
        allowedActions: fnCtx.allowed_actions,
        raw: fnCtx,
      };
    }
  } catch (e) {
    logAI("Context fetch via Supabase Function failed:", e?.message || e);
  }
  const dbCtx = await loadCompanyContext(companyId);
  return { ...dbCtx, voice: undefined, allowedActions: undefined, raw: null };
}

function buildToolsFromContext(context) {
  const tools = [];
  const allowed = context?.allowedActions || context?.allowed_actions || context?.raw?.allowed_actions;
  if (allowed?.booking) {
    tools.push({
      type: "function",
      name: "schedule_appointment",
      description: "Schedule an appointment for the caller",
      parameters: {
        type: "object",
        properties: {
          service: { type: "string" },
          preferred_date: { type: "string" },
          preferred_time: { type: "string" },
          caller_name: { type: "string" },
          caller_phone: { type: "string" },
        },
        required: ["service", "caller_name"],
      },
    });
  }
  if (allowed?.escalate) {
    tools.push({
      type: "function",
      name: "transfer_to_human",
      description: "Transfer the call to a human operator",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string" },
        },
        required: ["reason"],
      },
    });
  }
  return tools;
}

function sendToOpenAI(ws, obj) {
  const raw = JSON.stringify(obj);
  console.log("🧠 OPENAI | SENDING TO WS:", raw);
  ws.send(raw);
}

function openaiConnect({ sessionConfig, initialResponseInstructions, onReady, onAudioDelta, onError }) {
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
  let audioSchemaMode = "nested"; // "nested" or "flat"
  let includeModalities = true;
  let includeVoice = true;
  let includeTools = true;
  let includeTurnDetection = true;
  let includeTranscription = true;
  let sessionUpdateAttempts = 0;

  function buildSessionUpdate() {
    const base = {
      instructions: sessionConfig?.instructions || "You are a helpful assistant.",
    };
    if (includeModalities) base.modalities = ["text", "audio"];
    if (includeVoice && sessionConfig?.voice) base.voice = sessionConfig.voice;
    if (includeTranscription && sessionConfig?.input_audio_transcription) base.input_audio_transcription = sessionConfig.input_audio_transcription;
    if (includeTurnDetection && sessionConfig?.turn_detection) base.turn_detection = sessionConfig.turn_detection;
    if (includeTools && Array.isArray(sessionConfig?.tools)) base.tools = sessionConfig.tools;

    const audioNested = {
      audio: {
        input: { format: { type: "audio/pcmu" } },
        output: { format: { type: "audio/pcmu" } },
      },
    };
    const audioFlat = {
      input_audio_format: "g711_ulaw",
      output_audio_format: "g711_ulaw",
    };

    const audio = audioSchemaMode === "nested" ? audioNested : audioFlat;

    const session = sessionTypeMode === "with"
      ? { type: "realtime", ...base, ...audio }
      : { ...base, ...audio };
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
      if (!greetingSent && !ws._activeResponse) {
        greetingSent = true;
        ws._activeResponse = true;
        sendToOpenAI(ws, {
          type: "response.create",
          response: {
            instructions: initialResponseInstructions || "Greet the caller politely and ask how you can help."
          }
        });
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
      } else if ((param || "").startsWith("session.audio") && code === "unknown_parameter" && audioSchemaMode === "nested") {
        audioSchemaMode = "flat";
        sendSessionUpdate("fallback: switch to flat audio format params");
      } else if ((param === "session.input_audio_format" || param === "session.output_audio_format") && code === "unknown_parameter" && audioSchemaMode === "flat") {
        audioSchemaMode = "nested";
        sendSessionUpdate("fallback: switch to nested audio format schema");
      } else if (param === "session.modalities" && code === "unknown_parameter" && includeModalities) {
        includeModalities = false;
        sendSessionUpdate("fallback: remove modalities");
      } else if (param === "session.voice" && code === "unknown_parameter" && includeVoice) {
        includeVoice = false;
        sendSessionUpdate("fallback: remove voice");
      } else if (param === "session.tools" && code === "unknown_parameter" && includeTools) {
        includeTools = false;
        sendSessionUpdate("fallback: remove tools");
      } else if (param === "session.turn_detection" && code === "unknown_parameter" && includeTurnDetection) {
        includeTurnDetection = false;
        sendSessionUpdate("fallback: remove turn_detection");
      } else if (param === "session.input_audio_transcription" && code === "unknown_parameter" && includeTranscription) {
        includeTranscription = false;
        sendSessionUpdate("fallback: remove input_audio_transcription");
      }
      onError?.(evt);
    }
    if (evt.type === "input_audio_buffer.committed") {
      if (!ws._activeResponse) {
        ws._activeResponse = true;
        sendToOpenAI(ws, { type: "response.create" });
      }
    }
    if (evt.type === "response.created") {
      ws._activeResponse = true;
    }
    if (evt.type === "response.created" || evt.type === "response.done") {
      logAI("RESPONSE EVENT:", evt.type);
    }

    const audioDelta =
      evt?.delta?.audio ||
      evt?.audio?.data ||
      evt?.output_audio?.data ||
      evt?.response?.audio?.data ||
      evt?.delta ||
      null;

    if (evt.type === "response.audio.delta" || evt.type === "response.output_audio.delta") {
      if (audioDelta) {
        logAI("AUDIO DELTA", `len=${audioDelta.length}`);
        onAudioDelta?.(audioDelta);
      }
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
      const ctx = await getAiContext(companyId);
      const tools = buildToolsFromContext(ctx);
      const instructions = `\n${ctx.systemPrompt}\n\nKnowledge Base:\n${ctx.kbText}\n\nPhone style:\n- Natural, warm receptionist\n- Short answers; ask one question at a time\n- If unsure, say so and ask a clarifying question\n\nStart of call:\n- Use the greeting script and ask what they need.`.trim();
      openaiWs = openaiConnect({
        sessionConfig: {
          instructions,
          voice: ctx.voice || "alloy",
          input_audio_transcription: { model: "whisper-1" },
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 800,
          },
          tools,
        },
        initialResponseInstructions: ctx.greeting || "Greet the caller politely and ask how you can help.",
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


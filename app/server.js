import "dotenv/config";
import http from "http";
import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import { createClient } from "@supabase/supabase-js";

const {
  PORT = "3000",
  OPENAI_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  VOICE_GATEWAY_TOKEN, // optional but recommended
} = process.env;

if (!OPENAI_API_KEY) console.warn("Warning: Missing OPENAI_API_KEY");
if (!SUPABASE_URL) console.warn("Warning: Missing SUPABASE_URL");
if (!SUPABASE_SERVICE_ROLE_KEY) console.warn("Warning: Missing SUPABASE_SERVICE_ROLE_KEY");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const app = express();
app.get("/health", (_, res) => res.status(200).send("ok"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/twilio" });

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
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
  });

  return ws;
}

wss.on("connection", async (twilioWs, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const companyId = url.searchParams.get("company_id");
  const token = url.searchParams.get("token");

  if (!companyId) {
    twilioWs.close(1008, "Missing company_id");
    return;
  }

  // Optional shared token to prevent random connections
  if (VOICE_GATEWAY_TOKEN && token !== VOICE_GATEWAY_TOKEN) {
    twilioWs.close(1008, "Bad token");
    return;
  }

  let streamSid = null;
  let callSid = null;
  let openaiWs = null;

  try {
    const ctx = await loadCompanyContext(companyId);

    const instructions = `
${ctx.systemPrompt}

Knowledge Base (use only if relevant; keep answers short and human):
${ctx.kbText}

Phone style:
- Sound natural and warm, like a real receptionist.
- Short answers, ask one question at a time.
- If the caller asks "how are you", respond like a human.
- If unsure, ask a clarifying question or offer to transfer to a person.

Start of call:
- Greet the caller naturally and ask what they need.
`.trim();

    openaiWs = openaiConnect({ instructions });

    openaiWs.on("message", (buf) => {
      const msg = safeJsonParse(buf.toString());
      if (!msg) return;

      // The exact event names can vary by model version; we handle common patterns:
      // If an event contains base64 audio for output, forward it to Twilio as a media event.
      const audioB64 =
        msg?.audio?.data ||
        msg?.delta?.audio ||
        msg?.response?.audio?.data ||
        msg?.output_audio?.data;

      if (audioB64 && streamSid && twilioWs.readyState === WebSocket.OPEN) {
        const twilioOut = {
          event: "media",
          streamSid,
          media: { payload: audioB64 }
        };
        twilioWs.send(JSON.stringify(twilioOut));
      }

      // Optional: log events for debugging
      // console.log("OpenAI event:", msg.type || msg);
    });

    openaiWs.on("close", () => {
      // When OpenAI closes, end Twilio stream (Twilio will then proceed to fallback Dial if your TwiML has it)
      if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
    });

  } catch (err) {
    console.error("Setup error:", err);
    twilioWs.close(1011, "Server setup failed");
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
    return;
  }

  twilioWs.on("message", (buf) => {
    const msg = safeJsonParse(buf.toString());
    if (!msg) return;

    if (msg.event === "start") {
      streamSid = msg?.start?.streamSid || msg?.streamSid || streamSid;
      callSid = msg?.start?.callSid || msg?.start?.callSid || callSid;

      // Nothing else needed; OpenAI will greet once it receives audio or based on its instructions.
      return;
    }

    if (msg.event === "media") {
      // Twilio sends base64 μ-law chunks in msg.media.payload :contentReference[oaicite:8]{index=8}
      const payload = msg?.media?.payload;
      if (!payload || !openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;

      // Append audio to OpenAI input buffer (base64). :contentReference[oaicite:9]{index=9}
      const append = {
        type: "input_audio_buffer.append",
        audio: payload
      };
      openaiWs.send(JSON.stringify(append));
      return;
    }

    if (msg.event === "stop") {
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
      if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
    }
  });

  twilioWs.on("close", () => {
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });
});

server.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`Voice gateway listening on :${PORT}`);
  console.log(`WebSocket path: ws(s)://<host>/twilio?company_id=<uuid>&token=<optional>`);
});

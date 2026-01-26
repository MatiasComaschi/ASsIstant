// Minimal OpenAI Realtime WebSocket test
// Usage: node openai_realtime_test.js
import WebSocket from "ws";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) throw new Error("Set OPENAI_API_KEY in your environment");

const url = "wss://api.openai.com/v1/realtime?model=gpt-realtime";
const headers = { Authorization: `Bearer ${OPENAI_API_KEY}` };

console.log("Connecting to:", url);
console.log("Headers:", headers);

const ws = new WebSocket(url, "realtime", { headers });


ws.on("open", () => {
  console.log("WS OPEN");
});

ws.on("message", (data) => {
  let evt;
  try {
    evt = JSON.parse(data);
  } catch {
    console.log("Non-JSON message:", data);
    return;
  }
  console.log("EVENT:", evt.type, JSON.stringify(evt));
  if (evt.type === "session.created") {
    const sessionUpdate = {
      type: "session.update",
      session: {
        type: "realtime",
        instructions: "You are a test agent."
      }
    };
    console.log("SENDING:", JSON.stringify(sessionUpdate));
    ws.send(JSON.stringify(sessionUpdate));
  }
  if (evt.type === "session.updated") {
    console.log("SUCCESS: session.updated received. Test passed.");
    ws.close();
  }
  if (evt.type === "error") {
    console.log("ERROR PAYLOAD:", JSON.stringify(evt));
    ws.close();
  }
});

ws.on("error", (e) => console.log("WS ERROR", e?.message || e));
ws.on("close", (c, r) => console.log("WS CLOSE", c, r?.toString?.() || r));

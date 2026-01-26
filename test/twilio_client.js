import WebSocket from 'ws';

const url = 'ws://localhost:3000/twilio?company_id=test-company';
const ws = new WebSocket(url);

ws.on('open', () => {
  console.log('CLIENT: connected');
  // send a start event with customParameters
  const start = { event: 'start', start: { streamSid: 'STREAM123', callSid: 'CALL123', customParameters: { company_id: 'test-company', token: 'test-token' } }, start_time: Date.now() };
  ws.send(JSON.stringify(start));

  // send several media frames quickly to exercise buffering
  const sample = Buffer.from('pcm-frame').toString('base64');
  for (let i = 0; i < 6; i++) {
    const media = { event: 'media', streamSid: 'STREAM123', media: { payload: sample } };
    ws.send(JSON.stringify(media));
  }

  // wait a bit then stop
  setTimeout(() => {
    ws.send(JSON.stringify({ event: 'stop' }));
    ws.close();
  }, 3000);
});

ws.on('message', (m) => console.log('CLIENT RECV:', m.toString()));
ws.on('close', () => console.log('CLIENT: closed'));
ws.on('error', (e) => console.error('CLIENT ERR', e));

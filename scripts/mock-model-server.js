const http = require('http');

const port = Number(process.env.PORT || 8787);

const models = {
  data: [
    { id: 'gpt-5-codex', object: 'model' },
    { id: 'gpt-5.1', object: 'model' },
    { id: 'claude-sonnet-4-20250514', display_name: 'Claude Sonnet 4' },
    { id: 'claude-opus-4-20250514', display_name: 'Claude Opus 4' },
    { id: 'deepseek-r1', object: 'model' }
  ]
};

const server = http.createServer((req, res) => {
  if (req.url === '/v1/models' || req.url === '/models') {
    res.writeHead(200, {
      'content-type': 'application/json'
    });
    res.end(JSON.stringify(models));
    return;
  }

  if (req.url === '/user/balance') {
    res.writeHead(200, {
      'content-type': 'application/json'
    });
    res.end(JSON.stringify({
      balance: 12.5,
      used_quota: 7.5,
      total_quota: 20
    }));
    return;
  }

  if (req.method === 'POST' && req.url === '/v1/messages') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_mock',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'OK' }],
      model: 'claude-sonnet-4-20250514',
      usage: { input_tokens: 1, output_tokens: 1 }
    }));
    return;
  }

  if (req.method === 'POST' && req.url === '/v1/responses') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'resp_mock',
      object: 'response',
      status: 'completed',
      model: 'gpt-5-codex',
      output: []
    }));
    return;
  }

  res.writeHead(404, {
    'content-type': 'application/json'
  });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(port, () => {
  console.log(`Mock model server listening on http://localhost:${port}`);
});

/**
 * ====================================================================================
 * ###   askaiquestions-2api (Bun Edition)   ###
 * ====================================================================================
 */

const PORT = process.env.PORT || 3000;

// Cấu hình runtime từ biến môi trường
const CONFIG = {
  PROJECT_NAME: "askaiquestions-2api-bun",
  PROJECT_VERSION: "2.0.0",
  API_MASTER_KEY: process.env.API_MASTER_KEY || "default-unsafe-key",
  UPSTREAM_URL: process.env.UPSTREAM_URL || "https://pjfuothbq9.execute-api.us-east-1.amazonaws.com/get-summary",
  DEFAULT_MODEL: "askai-default-model",
  KNOWN_MODELS: ["askai-default-model"],
  PSEUDO_STREAM_CHUNK_SIZE: parseInt(process.env.PSEUDO_STREAM_CHUNK_SIZE || "2"),
  PSEUDO_STREAM_DELAY_MS: parseInt(process.env.PSEUDO_STREAM_DELAY_MS || "2"),
};

console.log(`🚀 Service starting on port ${PORT}...`);

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    try {
      // Chỉ xử lý các route API /v1/
      if (url.pathname.startsWith('/v1/')) {
        return await handleApiProxy(req);
      }

      // Root check (Health check đơn giản thay vì UI)
      if (url.pathname === '/') {
        return new Response(JSON.stringify({
          status: "ok",
          service: CONFIG.PROJECT_NAME,
          version: CONFIG.PROJECT_VERSION
        }), {
          headers: { "Content-Type": "application/json" }
        });
      }

      // 404 cho các route khác
      return errorResponse(`Path not found: ${url.pathname}`, 404, 'not_found');

    } catch (error) {
      console.error(`[Global Error] ${error.message}`, error.stack);
      return errorResponse(`Internal Server Error: ${error.message}`, 500, 'internal_server_error');
    }
  },
});

/**
 * Xử lý logic Proxy chính
 */
async function handleApiProxy(request) {
  const url = new URL(request.url);
  const requestId = crypto.randomUUID();
  const responseHeaders = new Headers({
    'Content-Type': 'application/json',
    'X-Request-ID': requestId,
    'Access-Control-Allow-Origin': '*', // CORS friendly cho API
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });

  // Handle Preflight (CORS)
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: responseHeaders });
  }

  // 1. Authentication
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.substring(7) !== CONFIG.API_MASTER_KEY) {
    return errorResponse('Unauthorized', 401, 'invalid_api_key', responseHeaders);
  }

  // 2. Routing
  // GET /v1/models
  if (url.pathname === '/v1/models' && request.method === 'GET') {
    return handleModels(responseHeaders);
  }

  // POST /v1/chat/completions
  if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
    return handleChatCompletions(request, requestId, responseHeaders);
  }

  return errorResponse(`Method ${request.method} not allowed for ${url.pathname}`, 405, 'method_not_allowed', responseHeaders);
}

/**
 * Trả về danh sách models (Stateless, removed Cache API)
 */
function handleModels(baseHeaders) {
  const modelData = {
    object: "list",
    data: CONFIG.KNOWN_MODELS.map(name => ({
      id: name,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "askai-project"
    }))
  };

  return new Response(JSON.stringify(modelData), { headers: baseHeaders });
}

/**
 * Xử lý Chat Completions & Streaming
 */
async function handleChatCompletions(request, requestId, baseHeaders) {
  let requestData;
  try {
    requestData = await request.json();
  } catch (e) {
    return errorResponse('Invalid JSON body', 400, 'invalid_request_error', baseHeaders);
  }

  const isStream = requestData.stream || false;
  const model = requestData.model || CONFIG.DEFAULT_MODEL;

  try {
    // Payload upstream
    const upstreamPayload = {
      website: "ask-ai-questions",
      messages: requestData.messages || []
    };

    if (upstreamPayload.messages.length === 0) {
      return errorResponse("Missing 'messages' field", 400, 'invalid_request_error', baseHeaders);
    }

    const upstreamHeaders = {
      "accept": "*/*",
      "content-type": "application/json",
      "origin": "https://askaiquestions.net",
      "referer": "https://askaiquestions.net/",
      "user-agent": "Mozilla/5.0 (compatible; Bun/1.0; +https://bun.sh)",
      "X-Request-ID": requestId
    };

    // Fetch Upstream
    const upstreamResponse = await fetch(CONFIG.UPSTREAM_URL, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(upstreamPayload)
    });

    if (!upstreamResponse.ok) {
      const errorText = await upstreamResponse.text();
      console.error(`[Upstream Error] ${upstreamResponse.status}: ${errorText}`);
      return errorResponse(`Upstream error: ${errorText}`, 502, `upstream_${upstreamResponse.status}`, baseHeaders);
    }

    const upstreamData = await upstreamResponse.json();
    const summary = upstreamData.summary;

    if (typeof summary !== 'string') {
      throw new Error("Upstream response missing 'summary' field.");
    }

    // Response Handling
    if (isStream) {
      const stream = createPseudoStream(summary, requestId, model);
      baseHeaders.set('Content-Type', 'text/event-stream');
      baseHeaders.set('Cache-Control', 'no-cache');
      baseHeaders.set('Connection', 'keep-alive');
      return new Response(stream, { headers: baseHeaders });
    } else {
      const completionData = {
        id: requestId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{
          index: 0,
          message: { role: "assistant", content: summary },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
      return new Response(JSON.stringify(completionData), { headers: baseHeaders });
    }

  } catch (error) {
    console.error(`[Chat Error] ${error.message}`);
    return errorResponse(`Processing failed: ${error.message}`, 502, 'api_error', baseHeaders);
  }
}

/**
 * Giả lập streaming (Pseudo-stream)
 */
function createPseudoStream(fullText, requestId, model) {
  const encoder = new TextEncoder();
  
  // Bun hỗ trợ Direct ReadableStream return
  return new ReadableStream({
    async start(controller) {
      try {
        const chunkSize = CONFIG.PSEUDO_STREAM_CHUNK_SIZE;
        const delay = CONFIG.PSEUDO_STREAM_DELAY_MS;

        for (let i = 0; i < fullText.length; i += chunkSize) {
          const contentChunk = fullText.substring(i, i + chunkSize);
          const chunk = {
            id: requestId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{ index: 0, delta: { content: contentChunk }, finish_reason: null }]
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          if (delay > 0) {
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }

        // Final chunk
        const finalChunk = {
          id: requestId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));

      } catch (e) {
        console.error(`[Stream Error]: ${e}`);
        const errorChunk = {
            id: requestId,
            object: "chat.completion.chunk",
            model: model,
            choices: [{ index: 0, delta: { content: `\n[Stream Error]` }, finish_reason: "stop" }]
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`));
      } finally {
        controller.close();
      }
    }
  });
}

/**
 * Helper tạo phản hồi lỗi chuẩn
 */
function errorResponse(message, status, code, headers = new Headers()) {
  headers.set('Content-Type', 'application/json');
  return new Response(
    JSON.stringify({
      error: {
        message: message,
        type: 'api_error',
        code: code
      }
    }),
    { status, headers }
  );
}

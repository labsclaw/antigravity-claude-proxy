function textFromContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .map(block => {
            if (typeof block === 'string') return block;
            if (block?.type === 'text' || block?.type === 'input_text') return block.text || '';
            return '';
        })
        .filter(Boolean)
        .join('\n');
}

function convertTools(tools) {
    if (!Array.isArray(tools)) return undefined;
    const converted = tools
        .filter(tool => tool?.type === 'function' && tool.function?.name)
        .map(tool => ({
            name: tool.function.name,
            description: tool.function.description,
            input_schema: tool.function.parameters || { type: 'object', properties: {} }
        }));
    return converted.length ? converted : undefined;
}

function convertToolChoice(toolChoice) {
    if (!toolChoice) return undefined;
    if (toolChoice === 'auto') return { type: 'auto' };
    if (toolChoice === 'required') return { type: 'any' };
    if (toolChoice === 'none') return undefined;
    if (toolChoice?.type === 'function' && toolChoice.function?.name) {
        return { type: 'tool', name: toolChoice.function.name };
    }
    return undefined;
}

export function openAIToAnthropicRequest(body = {}) {
    const systemParts = [];
    const messages = [];

    for (const message of body.messages || []) {
        if (message.role === 'system' || message.role === 'developer') {
            const text = textFromContent(message.content);
            if (text) systemParts.push(text);
            continue;
        }

        if (message.role === 'tool') {
            messages.push({
                role: 'user',
                content: `Tool result (${message.tool_call_id || 'unknown'}): ${textFromContent(message.content)}`
            });
            continue;
        }

        const role = message.role === 'assistant' ? 'assistant' : 'user';
        let content = textFromContent(message.content);
        if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
            const calls = message.tool_calls.map(call => ({
                name: call.function?.name,
                arguments: call.function?.arguments
            }));
            content = [content, `Tool calls: ${JSON.stringify(calls)}`].filter(Boolean).join('\n');
        }
        messages.push({ role, content });
    }

    return {
        model: body.model,
        messages,
        system: systemParts.length ? systemParts.join('\n\n') : undefined,
        max_tokens: body.max_tokens || body.max_completion_tokens || 4096,
        stream: Boolean(body.stream),
        temperature: body.temperature,
        top_p: body.top_p,
        tools: convertTools(body.tools),
        tool_choice: convertToolChoice(body.tool_choice),
        metadata: body.metadata
    };
}

function finishReason(stopReason) {
    if (stopReason === 'max_tokens') return 'length';
    if (stopReason === 'tool_use') return 'tool_calls';
    return 'stop';
}

export function anthropicToOpenAIResponse(response, requestedModel) {
    const text = Array.isArray(response?.content)
        ? response.content.filter(block => block?.type === 'text').map(block => block.text || '').join('')
        : '';
    const promptTokens = response?.usage?.input_tokens || 0;
    const completionTokens = response?.usage?.output_tokens || 0;

    return {
        id: String(response?.id || `msg_${Date.now()}`).replace(/^msg_/, 'chatcmpl_'),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: response?.model || requestedModel,
        choices: [{
            index: 0,
            message: { role: 'assistant', content: text },
            finish_reason: finishReason(response?.stop_reason)
        }],
        usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens
        }
    };
}

export function anthropicEventToOpenAIChunks(event, { id, model, created }) {
    const base = { id, object: 'chat.completion.chunk', created, model };
    if (event?.type === 'message_start') {
        return [{ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }];
    }
    if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        return [{ ...base, choices: [{ index: 0, delta: { content: event.delta.text || '' }, finish_reason: null }] }];
    }
    if (event?.type === 'message_delta') {
        return [{ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason(event.delta?.stop_reason) }] }];
    }
    return [];
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    openAIToAnthropicRequest,
    anthropicToOpenAIResponse,
    anthropicEventToOpenAIChunks
} from '../src/format/openai-grok-compat.js';

test('converts OpenAI chat input to Anthropic request shape', () => {
    const request = openAIToAnthropicRequest({
        model: 'grok-4.5-build-free',
        messages: [
            { role: 'system', content: 'Be concise.' },
            { role: 'user', content: 'Hello' }
        ],
        max_tokens: 32,
        stream: false
    });

    assert.equal(request.model, 'grok-4.5-build-free');
    assert.equal(request.system, 'Be concise.');
    assert.deepEqual(request.messages, [{ role: 'user', content: 'Hello' }]);
    assert.equal(request.max_tokens, 32);
    assert.equal(request.stream, false);
});

test('converts Anthropic response to OpenAI chat completion', () => {
    const response = anthropicToOpenAIResponse({
        id: 'msg_123',
        model: 'grok-4.5-build-free',
        content: [{ type: 'text', text: 'Hello back' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 4, output_tokens: 2 }
    }, 'grok-4.5-build-free');

    assert.equal(response.id, 'chatcmpl_123');
    assert.equal(response.object, 'chat.completion');
    assert.equal(response.choices[0].message.content, 'Hello back');
    assert.equal(response.choices[0].finish_reason, 'stop');
    assert.deepEqual(response.usage, { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 });
});

test('converts Anthropic text stream events to OpenAI chunks', () => {
    const context = { id: 'chatcmpl_test', model: 'grok-4.5-build-free', created: 1 };
    const start = anthropicEventToOpenAIChunks({ type: 'message_start' }, context);
    const text = anthropicEventToOpenAIChunks({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Hi' }
    }, context);
    const finish = anthropicEventToOpenAIChunks({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' }
    }, context);

    assert.equal(start[0].choices[0].delta.role, 'assistant');
    assert.equal(text[0].choices[0].delta.content, 'Hi');
    assert.equal(finish[0].choices[0].finish_reason, 'stop');
});

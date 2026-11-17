import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCloudCodeRequest } from '../src/cloudcode/request-builder.js';

const build = (extra = {}) => buildCloudCodeRequest({
    model: 'gemini-4-hydrogen-sonar', max_tokens: 2048,
    messages: [{ role: 'user', content: 'Return OK' }], ...extra
}, 'test-project', 'test@example.test', 'fixed-affinity');

test('caller instructions survive in the first user turn, not upstream systemInstruction', () => {
    const instruction = 'Use SSC for memory lookup. Never reveal private credentials.';
    const p = build({ system: instruction });
    assert.ok(!JSON.stringify(p.request.systemInstruction).includes(instruction));
    assert.equal(p.request.contents[0].role, 'user');
    assert.equal(p.request.contents[0].parts[0].text,
        `<system-instructions>\n${instruction}\n</system-instructions>`);
    assert.ok(JSON.stringify(p.request.contents).includes('Return OK'));
});

test('multiple caller system parts retain order and full content', () => {
    const p = build({ system: [{ type: 'text', text: 'Rule one' }, { type: 'text', text: 'Rule two' }] });
    assert.equal(p.request.contents[0].parts[0].text,
        '<system-instructions>\nRule one\n\nRule two\n</system-instructions>');
});

test('no caller system leaves user content unchanged', () => {
    const p = build();
    assert.equal(p.request.contents[0].parts[0].text, 'Return OK');
});

test('assistant-first history gets a separate user instruction turn', () => {
    const p = build({ system: 'Keep these rules', messages: [{ role: 'assistant', content: 'Prior answer' }, { role: 'user', content: 'Next' }] });
    assert.equal(p.request.contents[0].role, 'user');
    assert.match(p.request.contents[0].parts[0].text, /Keep these rules/);
    assert.ok(JSON.stringify(p.request.contents).includes('Prior answer'));
});

test('tool-result part is not merged into an instruction block', () => {
    const p = build({ system: 'Keep rules', messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'Tool output' }] }] });
    assert.equal(p.request.contents[0].parts[0].text, '<system-instructions>\nKeep rules\n</system-instructions>');
    assert.ok(p.request.contents[1].parts[0].functionResponse);
});

test('existing session-affinity parameter remains supported', () => {
    const a = build({ system: 'First rules' });
    const b = build({ system: 'Second rules' });
    assert.equal(a.request.sessionId, b.request.sessionId);
    assert.equal(a.model, 'gemini-4-hydrogen-sonar');
});

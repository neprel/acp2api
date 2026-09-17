import os

from openai import OpenAI


client = OpenAI(
    api_key="offline-test-key",
    base_url=os.environ["ACP2API_TEST_BASE_URL"],
    max_retries=0,
    timeout=10,
)

completion = client.chat.completions.create(
    model="fake",
    messages=[{"role": "user", "content": "python sdk chat"}],
)
assert completion.choices[0].message.content == "[fast] python sdk chat"

chat_text = ""
chat_finish_reason = None
for chunk in client.chat.completions.create(
    model="fake",
    messages=[{"role": "user", "content": "python sdk chat stream"}],
    stream=True,
):
    chat_text += chunk.choices[0].delta.content or ""
    chat_finish_reason = chunk.choices[0].finish_reason or chat_finish_reason
assert chat_text == "[fast] python sdk chat stream"
assert chat_finish_reason == "stop"

response = client.responses.create(model="fake", input="python sdk response")
assert response.output_text == "[fast] python sdk response"
assert response.status == "completed"

response_types = []
response_text = ""
with client.responses.stream(model="fake", input="python sdk response stream") as stream:
    for event in stream:
        response_types.append(event.type)
        if event.type == "response.output_text.delta":
            response_text += event.delta
    streamed_response = stream.get_final_response()
assert response_text == "[fast] python sdk response stream"
assert streamed_response.output_text == response_text
assert streamed_response.status == "completed"
assert "response.output_text.delta" in response_types
assert response_types[-1] == "response.completed"

tools = [{
    "type": "function",
    "name": "read_file",
    "description": "Read one file",
    "parameters": {
        "type": "object",
        "properties": {"path": {"type": "string"}},
        "required": ["path"],
    },
}]
call_response = client.responses.create(
    model="fake",
    input='USETOOL read_file {"path":"README.md"}',
    tools=tools,
)
call = next(item for item in call_response.output if item.type == "function_call")
assert call.name == "read_file"
assert call.arguments == '{"path":"README.md"}'

completed = client.responses.create(
    model="fake",
    previous_response_id=call_response.id,
    input=[{
        "type": "function_call_output",
        "call_id": call.call_id,
        "output": "the Python SDK supplied this result",
    }],
    tools=tools,
)
assert "RESULT:the Python SDK supplied this result" in completed.output_text

print("Python OpenAI SDK: Chat, Responses streaming, and tool continuation passed")

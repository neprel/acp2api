"""pip install openai"""
import os

from openai import OpenAI

model = os.getenv("ACP2API_MODEL", "claude")
client = OpenAI(
    base_url=os.getenv("ACP2API_BASE_URL", "http://127.0.0.1:10021/v1"),
    api_key="local-not-used",
    timeout=15 * 60,
    max_retries=0,
)

print("Chat Completions stream:")
chat = client.chat.completions.create(
    model=model,
    stream=True,
    messages=[{"role": "user", "content": "Reply with one short greeting."}],
)
for chunk in chat:
    print(chunk.choices[0].delta.content or "", end="", flush=True)
print("\n\nResponses stream:")

with client.responses.stream(
    model=model, input="Remember the number 41 and reply noted."
) as stream:
    for event in stream:
        if event.type == "response.output_text.delta":
            print(event.delta, end="", flush=True)
    first = stream.get_final_response()
print()

# Continuation is linear: always use the latest successful stored response id.
second = client.responses.create(
    model=model,
    previous_response_id=first.id,
    input="What number did I ask you to remember?",
)
print("continued:", second.output_text)

tools = [{
    "type": "function",
    "name": "weather",
    "description": "Return weather for a city",
    "parameters": {
        "type": "object",
        "properties": {"city": {"type": "string"}},
        "required": ["city"],
    },
}]
call_response = client.responses.create(
    model=model,
    input=os.getenv("ACP2API_TOOL_PROMPT", "Use the weather tool to get weather for Oslo."),
    tools=tools,
)
call = next((item for item in call_response.output if item.type == "function_call"), None)
if call is None:
    raise RuntimeError("agent did not call the weather tool")

completed = client.responses.create(
    model=model,
    previous_response_id=call_response.id,
    tools=tools,
    input=[{
        "type": "function_call_output",
        "call_id": call.call_id,
        "output": "clear, 12 C",
    }],
)
print("tool result:", completed.output_text)

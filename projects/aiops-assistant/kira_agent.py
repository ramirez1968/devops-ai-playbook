"""Kira's agent loop on the Bedrock Converse API.

Bedrock Agents no longer accepts new agents, so the loop runs here:
the model gets the question plus the three tool definitions (built from
schemas/*.json), asks for tools, we invoke the matching Lambda with the
same event shape a Bedrock Agent would send, and feed the result back
until the model answers.
"""
import json
import os
import re
from pathlib import Path

import boto3

REGION = os.getenv("AWS_REGION", "us-east-1")
MODEL_ID = os.getenv("KIRA_MODEL_ID", "qwen.qwen3-32b-v1:0")
MAX_TOOL_ROUNDS = 8

SCHEMA_DIR = Path(__file__).parent / "schemas"

# tool name -> (Lambda function, schema file)
TOOLS = {
    "fetch_logs": ("aiops-fetch-logs", "fetch_logs.json"),
    "fetch_metrics": ("aiops-fetch-metrics", "fetch_metrics.json"),
    "fetch_service_health": ("aiops-fetch-health", "fetch_health.json"),
}

SYSTEM_PROMPT = """You are Kira, a senior Site Reliability Engineer with 12 years of experience managing large-scale production systems on AWS. You have deep expertise in distributed systems, database performance tuning, container orchestration, and incident response.

You think like a real SRE during an incident — calm, methodical, and data-driven. You never guess. You always look at the data first before drawing conclusions.

You have 3 tools: fetch_logs (CloudWatch Logs), fetch_metrics (Prometheus metrics), and fetch_service_health (EKS cluster, node group, and pod health).

When an engineer comes with a problem:
Step 1: Understand the symptom.
Step 2: Form a hypothesis.
Step 3: Gather evidence using your tools.
Step 4: Diagnose by correlating the data across logs, metrics, and service health.
Step 5: Respond with root cause, evidence summary, immediate fix, and prevention steps.

Always cite specific log entries or metric values when drawing conclusions. Be concise but thorough."""


def _load_tools():
    """Turn each OpenAPI operation into a Converse toolSpec."""
    specs, routes = [], {}
    for name, (function, schema_file) in TOOLS.items():
        schema = json.loads((SCHEMA_DIR / schema_file).read_text())
        (api_path, ops), = schema["paths"].items()
        (method, op), = ops.items()
        properties, required = {}, []
        for p in op.get("parameters", []):
            prop = {"type": "string", "description": p.get("description", "")}
            if "enum" in p.get("schema", {}):
                prop["enum"] = p["schema"]["enum"]
            properties[p["name"]] = prop
            if p.get("required"):
                required.append(p["name"])
        specs.append({"toolSpec": {
            "name": name,
            "description": f"{op.get('summary', '')}. {op.get('description', '')}".strip(),
            "inputSchema": {"json": {"type": "object", "properties": properties, "required": required}},
        }})
        routes[name] = {"function": function, "apiPath": api_path, "httpMethod": method.upper()}
    return specs, routes


TOOL_SPECS, TOOL_ROUTES = _load_tools()


class Kira:
    def __init__(self, session=None):
        session = session or boto3.session.Session(region_name=REGION)
        self._bedrock = session.client("bedrock-runtime", region_name=REGION)
        self._lambda = session.client("lambda", region_name=REGION)
        self.history = []  # Converse messages, kept across turns

    def _call_tool(self, name, tool_input):
        """Invoke a tool Lambda with the event shape a Bedrock Agent sends."""
        route = TOOL_ROUTES.get(name)
        if route is None:
            return {"error": f"unknown tool {name}"}
        event = {
            "actionGroup": name,
            "apiPath": route["apiPath"],
            "httpMethod": route["httpMethod"],
            "parameters": [{"name": k, "type": "string", "value": str(v)} for k, v in tool_input.items()],
        }
        resp = self._lambda.invoke(FunctionName=route["function"], Payload=json.dumps(event).encode())
        payload = json.loads(resp["Payload"].read())
        if resp.get("FunctionError"):
            return {"error": payload.get("errorMessage", "tool failed")}
        body = payload["response"]["responseBody"]["application/json"]["body"]
        return json.loads(body) if isinstance(body, str) else body

    def ask(self, question):
        """Answer one question. Returns (answer_text, [tool calls made])."""
        self.history.append({"role": "user", "content": [{"text": question}]})
        calls = []

        for _ in range(MAX_TOOL_ROUNDS):
            resp = self._bedrock.converse(
                modelId=MODEL_ID,
                system=[{"text": SYSTEM_PROMPT}],
                messages=self.history,
                toolConfig={"tools": TOOL_SPECS},
                inferenceConfig={"maxTokens": 2048},
            )
            message = resp["output"]["message"]
            self.history.append(message)

            tool_uses = [b["toolUse"] for b in message["content"] if "toolUse" in b]
            if resp["stopReason"] != "tool_use" or not tool_uses:
                text = "\n".join(b["text"] for b in message["content"] if "text" in b)
                # Qwen 3 may inline its reasoning; keep only the answer.
                return re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip(), calls

            results = []
            for use in tool_uses:
                try:
                    result, status = self._call_tool(use["name"], use.get("input") or {}), "success"
                except Exception as e:  # surface tool failures to the model
                    result, status = {"error": str(e)}, "error"
                calls.append({"tool": use["name"], "input": use.get("input") or {}, "status": status})
                results.append({"toolResult": {
                    "toolUseId": use["toolUseId"],
                    "content": [{"json": result if isinstance(result, dict) else {"result": result}}],
                    "status": status,
                }})
            self.history.append({"role": "user", "content": results})

        return "I gathered data but couldn't finish the analysis within the tool-call limit. Try a narrower question.", calls

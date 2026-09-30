# AIOps Assistant — Kira

An AI-powered SRE assistant on Amazon Bedrock. Kira diagnoses production incidents by querying CloudWatch Logs, Prometheus metrics, and EKS cluster health — then responds with root cause, evidence, and fix recommendations.

> **Why not a Bedrock Agent?** Kira was first built as a Bedrock Agent (`deploy.sh`). Bedrock Agents is now in maintenance mode and no longer accepts new agents, so the agent loop runs in `kira_agent.py` on the Bedrock **Converse API** instead. Same model, same prompt, same Lambda tools.

---

## Architecture

```
Streamlit UI (app.py)
      │
      ▼
kira_agent.py ── Converse API ──► Qwen 3 32B (Amazon Bedrock)
      │   the model asks for a tool → we invoke the Lambda → send the result back
      │
      ├── aiops-fetch-logs     → CloudWatch Logs (/eks/boutique/pods)
      ├── aiops-fetch-metrics  → Prometheus  ┐ via the EKS API service proxy,
      └── aiops-fetch-health   → EKS + Prometheus ┘ IAM-signed (Prometheus stays private)
```

The tool definitions the model sees are built from `schemas/*.json`, and the Lambdas receive the same event format a Bedrock Agent would send.

---

## Prerequisites

- The EKS stack from `projects/Infrastructure` applied (it creates the Lambdas too — see below)
- Bedrock model access for `qwen.qwen3-32b-v1:0` in your region
- AWS CLI configured (`aws configure`) with permission to call `bedrock:InvokeModel` and `lambda:InvokeFunction`
- Python 3.10+

---

## Step 1: Deploy the Tools (Terraform)

The tools are part of the infrastructure code in `projects/Infrastructure/kira.tf`:

| Resource | Purpose |
|----------|---------|
| `aiops-lambda-role` | Lambda basics, read CloudWatch Logs, describe this EKS cluster |
| EKS access entry + Role `kira-prometheus-proxy` | The Lambda role may only `get` the Prometheus service proxy — nothing else in the cluster |
| `aiops-fetch-logs`, `aiops-fetch-metrics`, `aiops-fetch-health` | The 3 tools (Python 3.12, 30s timeout) |

```bash
cd ../Infrastructure
terraform plan    # review
terraform apply
```

`fetch_metrics` and `fetch_health` share `lambda/common/eks_prometheus.py`, which calls Prometheus through the EKS API with the same IAM-signed token `aws eks get-token` produces. No LoadBalancer or public Prometheus is needed.

---

## Step 2: (Optional) Generate Sample Data

Populate CloudWatch Logs with realistic error scenarios to test Kira:

```bash
python3 scripts/generate_sample_data.py --region us-east-1
```

This writes 100 realistic log events (503 errors, OOM kills, connection pool exhaustion, etc.) to `/app/production`.

---

## Step 3: Run the Streamlit UI

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/streamlit run app.py
```

Open **http://localhost:8501**. Each answer has a **🔧 Tools used** section showing which tools Kira called and with what inputs.

Optional `.env` (copy `.env.example`):

```env
AWS_REGION=us-east-1
# KIRA_MODEL_ID=qwen.qwen3-32b-v1:0
# Omit these to use your AWS CLI profile / SSO / IAM role:
# AWS_ACCESS_KEY_ID=...
# AWS_SECRET_ACCESS_KEY=...
```

You can also ask from a terminal:

```bash
.venv/bin/python -c "from kira_agent import Kira; print(Kira().ask('Are all pods healthy?')[0])"
```

---

## Project Structure

```
aiops-assistant/
├── app.py                  # Streamlit chat UI
├── kira_agent.py           # Agent loop: Converse API + tool calls to the Lambdas
├── requirements.txt        # Python dependencies
├── .env.example            # Environment variable template
├── lambda/
│   ├── common/             # eks_prometheus.py — Prometheus via the EKS API
│   ├── fetch_logs/         # CloudWatch Logs query
│   ├── fetch_metrics/      # Prometheus metrics query
│   └── fetch_health/       # EKS cluster health check
├── schemas/                # OpenAPI schemas → the tool definitions Kira sees
├── scripts/
│   └── generate_sample_data.py  # Seed CloudWatch with test errors
└── deploy.sh, setup-iam.sh, aiops_all_lambda_code.py
                            # Legacy Bedrock Agent setup (no longer works; kept for reference)
```

---

## Sample Questions to Ask Kira

- Why are we seeing 503 errors in the last hour?
- Is CPU usage high across the boutique services?
- Are all pods healthy? Any restarts?
- What are the most frequent errors in the last 2 hours?

**Verify what Kira tells you.** It cites real log lines and metric values, but it can still connect them wrongly — for example, attributing old restarts from a replaced pod to the pod running now. Treat the answer as a starting point for your own check.

---

## Potential Issues

### `AccessDeniedException` calling the model
Model access for `qwen.qwen3-32b-v1:0` isn't enabled in your account/region. Check **AWS Console → Bedrock → Model access**.

### `fetch_metrics` / `fetch_health` return `Forbidden`
The Lambda role's access entry or the `kira-prometheus-proxy` Role is missing. Re-run `terraform apply` in `projects/Infrastructure` and check:

```bash
aws eks list-access-entries --cluster-name eks-cluster
kubectl get role,rolebinding kira-prometheus-proxy -n monitoring
```

### `fetch_logs` returns no results
Logs arrive in `/eks/boutique/pods` via Fluent Bit (`projects/Infrastructure/logging.tf`), which only ships new lines. Make sure it's running:

```bash
kubectl get pods -n amazon-cloudwatch
```

### AWS credentials not resolving in Streamlit
If `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are blank in `.env`, boto3 uses the default credential chain (`~/.aws/credentials`, environment variables, IAM role). Make sure your terminal has valid AWS credentials before starting Streamlit.

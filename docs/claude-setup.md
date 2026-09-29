# Claude Code Setup

This project uses [Claude Code](https://code.claude.com/docs) — Anthropic's AI coding assistant — as a hands-on tool throughout the DevOps workflow. This document covers how Claude is configured in this project: the `CLAUDE.md` instruction file and the MCP servers that extend its capabilities.

---

## What is Claude Code?

Claude Code is a CLI-based AI assistant that works directly in your terminal and IDE. It can read files, run commands, write code, interact with AWS, manage Kubernetes, and reason about infrastructure — all within your project context.

In this project, Claude Code is used to:
- Assist with Terraform and Kubernetes configuration
- Query EKS clusters and troubleshoot pods
- Interact with AWS services (ECR, EKS, Bedrock, pricing)
- Help write and deploy the AIOps assistant (Kira)

---

## CLAUDE.md — Project Instructions

`CLAUDE.md` is a file at the root of the project that Claude reads automatically at the start of every session. It sets rules and expectations for how Claude should behave within this specific project.

**Current `CLAUDE.md` for this project:**

```
You are operating in safe execution mode.

Before executing any command:
- Before taking any action, briefly explain what you're about to do in 1-2 simple sentences
- Use plain language, avoid jargon
- Say WHY, not just WHAT
- Then proceed with the action

Always prefer clear reasoning before action.
```

### What this does

This instructs Claude to explain its reasoning before taking any action — so you always know what's about to happen and why, rather than commands running silently. This is particularly useful when working with live AWS infrastructure where unintended actions can have real consequences.

### How to customise CLAUDE.md

You can add any project-specific rules. Common examples:

```markdown
# Always use the boutique namespace unless told otherwise
# Never run terraform apply without showing the plan first
# Prefer kubectl over raw AWS CLI for cluster operations
# Branch naming convention: feature/<name>, fix/<name>
```

CLAUDE.md supports nested files too — you can place a `CLAUDE.md` inside any subdirectory and Claude will read it when working in that directory.

---

## MCP Servers

MCP (Model Context Protocol) servers extend Claude's capabilities beyond the built-in tools. They run as background processes and expose additional tools that Claude can call — for AWS operations, Terraform, pricing lookups, and more.

### awslabs.eks-mcp-server

**What it does:** Gives Claude direct access to your EKS clusters and Kubernetes resources without needing `kubectl` installed or configured separately.

**Key capabilities:**
- List and inspect pods, deployments, services, and events across namespaces
- Apply Kubernetes YAML manifests to a cluster
- Stream pod logs and CloudWatch metrics
- Describe EKS cluster config, node groups, and VPC networking
- Troubleshoot using the EKS troubleshooting guide
- Generate application manifests for a given container image

**Example use in this project:**

> "Why is the order-service pod crashing?"

Claude will use this server to check pod events, read logs, and inspect the deployment spec — without you running any kubectl commands manually.

**Read-only by default:** Out of the box the server can only describe and list resources. Two opt-in flags unlock the rest:

| Flag | Unlocks |
|------|---------|
| `--allow-sensitive-data-access` | Pod logs, Kubernetes events, and Secrets |
| `--allow-write` | Applying manifests and creating, updating, or deleting resources |

This project's setup (Step 4) enables both so Claude can troubleshoot and deploy. Leave off `--allow-write` if you only want Claude to look, never change.

**Setup requirement:** Your AWS identity needs two things:
1. **IAM permissions** for the calls the server makes — for read-only use, actions such as `eks:DescribeCluster`, `eks:ListClusters`, `ec2:DescribeVpcs`, `cloudformation:DescribeStacks`, `cloudwatch:GetMetricData`, and `logs:StartQuery` / `logs:GetQueryResults`. (Note: `AmazonEKSClusterPolicy` is for the EKS cluster's *service role*, not for your user.)
2. **Access inside the cluster** — an [EKS access entry](https://docs.aws.amazon.com/eks/latest/userguide/access-entries.html) for your IAM user or role (e.g. `AmazonEKSViewPolicy` for read-only, `AmazonEKSClusterAdminPolicy` for write). Without it, the AWS calls succeed but Kubernetes denies every request.

---

### terraform (HashiCorp terraform-mcp-server)

**What it does:** Gives Claude live access to the Terraform Registry — provider docs, modules, and policies — so it works from current resource schemas instead of memory. Runs in Docker.

**Key capabilities:**
- Search provider resource documentation (AWS, AWSCC, Kubernetes, Helm, …)
- Search and inspect modules from the public Terraform Registry
- Search Sentinel/OPA policies
- Manage HCP Terraform / Terraform Enterprise workspaces and runs (optional — needs `TFE_TOKEN`)

**Example use in this project:**

> "What Terraform resource do I need to create an EKS node group?"

Claude will search the AWS provider docs and return the correct resource schema and example usage.

> "Run terraform plan in the Infrastructure directory"

This one doesn't go through the MCP server — the server doesn't run local Terraform. Claude runs `terraform plan` directly in its terminal (Terraform must be installed) and summarises what will be created, changed, or destroyed. The same goes for Checkov: if `checkov` is installed, Claude can run `checkov -d projects/Infrastructure` directly.

> **Why not `awslabs.terraform-mcp-server`?** Earlier versions of this setup used it, but AWS has withdrawn every version from PyPI in favour of HashiCorp's server — `uvx` can no longer install it.

---

### awslabs.aws-pricing-mcp-server

**What it does:** Gives Claude access to live AWS pricing data so it can estimate costs for services before you provision them.

**Key capabilities:**
- Look up pricing for any AWS service (EC2, EKS, Bedrock, Lambda, RDS, etc.)
- Filter by region, instance type, and other attributes
- Generate structured cost analysis reports
- Estimate Bedrock inference costs including Knowledge Base OCU minimums
- Retrieve bulk pricing data for historical analysis

**Example use in this project:**

> "How much will this EKS setup cost per month?"

Claude will query the pricing API for the node instance type, data transfer, and EKS cluster fee, then return a cost breakdown.

> "What does it cost to run the Bedrock Agent daily?"

Claude will look up the Qwen model pricing and factor in the Lambda invocations from the action groups.

---

### What about awslabs.core-mcp-server?

Earlier versions of this setup included `awslabs.core-mcp-server`, a proxy that routed requests to the other AWS servers. AWS has withdrawn every version from PyPI ("load individual MCPs"), so it can no longer be installed. It isn't needed: Claude Code talks to each server above directly.

---

## Setup Steps

### Step 1 — Install Claude Code

```bash
# macOS, Linux, WSL (recommended — auto-updates in the background)
curl -fsSL https://claude.ai/install.sh | bash

# or via npm (requires Node.js 22+, no auto-update)
npm install -g @anthropic-ai/claude-code
```

Verify:

```bash
claude --version
```

Then authenticate:

```bash
claude
```

This opens a browser to log in with your Anthropic account. Once authenticated, you can run `claude` from any directory to start a session.

---

### Step 2 — Configure AWS Credentials

The AWS MCP servers need valid credentials to access your account. If you haven't set this up:

```bash
aws configure
```

You'll be prompted for:
- **AWS Access Key ID** — from your IAM user or role
- **AWS Secret Access Key**
- **Default region** — use the same region as your EKS cluster (e.g. `us-east-1`)
- **Output format** — `json`

Verify it's working:

```bash
aws sts get-caller-identity
```

You should see your account ID, user ID, and ARN returned. If this fails, the AWS MCP servers will not connect.

> If you're using AWS SSO or named profiles, pass `-e AWS_PROFILE=<name>` when registering each server in Step 4.

---

### Step 3 — Install uv

`uv` is the Python package runner that launches the AWS MCP servers automatically.

```bash
# Linux / WSL / macOS
curl -LsSf https://astral.sh/uv/install.sh | sh

# or macOS with Homebrew
brew install uv
```

Verify:

```bash
uvx --version
```

---

### Step 4 — Configure MCP Servers

Register each server with `claude mcp add`. The `-s user` flag makes it available in every project on your machine:

```bash
claude mcp add terraform -s user \
  -- docker run -i --rm hashicorp/terraform-mcp-server

claude mcp add awslabs-aws-pricing-mcp-server -s user \
  -e AWS_REGION=us-east-1 -e FASTMCP_LOG_LEVEL=ERROR \
  -- uvx awslabs.aws-pricing-mcp-server@latest

claude mcp add awslabs-eks-mcp-server -s user \
  -e AWS_REGION=us-east-1 -e FASTMCP_LOG_LEVEL=ERROR \
  -- uvx awslabs.eks-mcp-server@latest --allow-write --allow-sensitive-data-access
```

> Replace `us-east-1` with your AWS region. Add `-e AWS_PROFILE=<name>` to any server if you use named profiles or SSO.
>
> Server names (right after `claude mcp add`) may only use letters, numbers, hyphens, and underscores — so it's `awslabs-eks-mcp-server`, even though the package name after `uvx` is `awslabs.eks-mcp-server`.

The Terraform server needs Docker running (`docker info` should succeed). The two AWS servers need `uv` (Step 3).

These commands write to `~/.claude.json`. Check the result anytime with `claude mcp list`, and remove a server with `claude mcp remove <name> -s user`.

> ⚠️ **Don't put MCP servers in `~/.claude/settings.json`.** Claude Code does not read an `mcpServers` block from that file — servers defined there are silently ignored. MCP servers live in `~/.claude.json` (user/local scope, managed by `claude mcp add`) or in a `.mcp.json` file at the project root (project scope, shareable via Git).

---

### Step 5 — Install the Terraform Skill

Skills are domain-specific knowledge packs that give Claude deeper context for specific tools. A skill is simply a folder containing a `SKILL.md` file — there is no `claude skills install` command. Install one in either of two ways:

- **As a personal skill:** copy the skill's folder to `~/.claude/skills/terraform-skill/` (so the file is at `~/.claude/skills/terraform-skill/SKILL.md`). It's then available in every project on your machine.
- **From a plugin marketplace:** inside a Claude Code session, run `/plugin`, browse the marketplace, and install a plugin that includes a Terraform skill.

This gives Claude richer context for Terraform module patterns, security scanning with Checkov, testing strategies, and CI/CD workflows — beyond what's in its base training.

Verify it installed — inside a Claude Code session, run:

```
/skills
```

You should see `terraform-skill` listed. Claude Code picks up new skill folders automatically, without a restart.

---

### Step 6 — Add CLAUDE.md to the Project

Create a `CLAUDE.md` file at the root of the repository (already present in this project). Claude reads this automatically at the start of every session.

The one used in this project puts Claude in safe execution mode — it must explain what it's doing and why before taking any action. This is especially important when working with live AWS infrastructure.

You can customise it with project-specific rules:

```markdown
# Always use the boutique namespace unless told otherwise
# Never run terraform apply without showing the plan first
# Branch naming: feature/<name>, fix/<name>
```

---

## Verifying the Setup

Start a Claude Code session:

```bash
claude
```

Check which MCP servers are connected:

```
/mcp
```

You should see all three servers listed as `connected`. If any show as `failed`:

| Problem | Fix |
|---------|-----|
| AWS server shows `failed` | Run `aws sts get-caller-identity` to verify credentials |
| No servers listed at all | They're probably in `~/.claude/settings.json`, which is ignored — re-register them with `claude mcp add` (Step 4) |
| Wrong region errors | `claude mcp remove <name> -s user`, then re-add it with the correct `-e AWS_REGION=...` |
| EKS server can't read logs or apply manifests | Re-add it with `--allow-sensitive-data-access` and/or `--allow-write` (Step 4) |
| `uvx: command not found` | Run `curl -LsSf https://astral.sh/uv/install.sh \| sh` (or `brew install uv` on macOS), then open a new terminal |
| Server times out on first use | Normal — `uvx` downloads the server on first run, retry after ~30s |

---

## How Claude Uses These Tools in This Project

| Task | MCP Server Used |
|------|----------------|
| Check pod logs / health | `eks-mcp-server` |
| Apply k8s manifests | `eks-mcp-server` |
| Run terraform plan/apply | Built-in terminal (`terraform` CLI) |
| Search provider docs | `terraform` (HashiCorp) |
| Estimate infrastructure cost | `aws-pricing-mcp-server` |
| Bedrock agent cost analysis | `aws-pricing-mcp-server` |
| Cluster and node group info | `eks-mcp-server` |

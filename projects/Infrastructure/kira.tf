# Stage 7: Kira's tools — 3 Lambdas the agent loop in
# projects/aiops-assistant/kira_agent.py invokes (Bedrock Converse API).
# Bedrock Agents no longer accepts new agents, so there is no agent resource.
#
# fetch_metrics and fetch_health reach Prometheus through the EKS API
# service proxy with IAM-signed requests, so Prometheus stays private.

locals {
  kira_src        = "${path.module}/../aiops-assistant"
  kira_k8s_group  = "kira-prometheus-readers"
  prometheus_svc  = "kube-prometheus-stack-prometheus"
  prometheus_port = 9090
  kira_build_dir  = "${path.module}/.terraform/kira-build"
  kira_account_id = data.aws_caller_identity.current.account_id

  kira_tools = {
    fetch_logs = {
      function   = "aiops-fetch-logs"
      source_dir = "fetch_logs"
      helper     = false
    }
    fetch_metrics = {
      function   = "aiops-fetch-metrics"
      source_dir = "fetch_metrics"
      helper     = true
    }
    fetch_service_health = {
      function   = "aiops-fetch-health"
      source_dir = "fetch_health"
      helper     = true
    }
  }
}

# ---------------------------------------------------------------------------
# Lambda execution role
# ---------------------------------------------------------------------------

resource "aws_iam_role" "kira_lambda" {
  name = "aiops-lambda-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "kira_lambda_basic" {
  role       = aws_iam_role.kira_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "kira_lambda_read" {
  name = "aiops-read-logs-and-eks"
  role = aws_iam_role.kira_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadLogs"
        Effect = "Allow"
        Action = [
          "logs:FilterLogEvents",
          "logs:StartQuery",
          "logs:GetQueryResults",
          "logs:StopQuery",
          "logs:DescribeLogGroups",
          "logs:DescribeLogStreams",
        ]
        Resource = "*"
      },
      {
        Sid    = "DescribeThisCluster"
        Effect = "Allow"
        Action = [
          "eks:DescribeCluster",
          "eks:ListNodegroups",
          "eks:DescribeNodegroup",
        ]
        Resource = [
          "arn:aws:eks:${var.region}:${local.kira_account_id}:cluster/${module.eks.cluster_name}",
          "arn:aws:eks:${var.region}:${local.kira_account_id}:nodegroup/${module.eks.cluster_name}/*/*",
        ]
      },
    ]
  })
}

# ---------------------------------------------------------------------------
# Cluster access: the Lambda role may only proxy to the Prometheus service
# ---------------------------------------------------------------------------

resource "aws_eks_access_entry" "kira_lambda" {
  cluster_name      = module.eks.cluster_name
  principal_arn     = aws_iam_role.kira_lambda.arn
  kubernetes_groups = [local.kira_k8s_group]
  type              = "STANDARD"
}

resource "kubernetes_role_v1" "kira_prometheus_proxy" {
  provider = kubernetes.eks

  metadata {
    name      = "kira-prometheus-proxy"
    namespace = "monitoring"
  }

  rule {
    api_groups = [""]
    resources  = ["services/proxy"]
    # The proxy request's resource name includes the port.
    resource_names = [
      local.prometheus_svc,
      "${local.prometheus_svc}:${local.prometheus_port}",
    ]
    verbs = ["get"]
  }
}

resource "kubernetes_role_binding_v1" "kira_prometheus_proxy" {
  provider = kubernetes.eks

  metadata {
    name      = "kira-prometheus-proxy"
    namespace = "monitoring"
  }

  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "Role"
    name      = kubernetes_role_v1.kira_prometheus_proxy.metadata[0].name
  }

  subject {
    kind      = "Group"
    name      = local.kira_k8s_group
    api_group = "rbac.authorization.k8s.io"
  }
}

# ---------------------------------------------------------------------------
# Lambda functions
# ---------------------------------------------------------------------------

data "archive_file" "kira_tool" {
  for_each = local.kira_tools

  type        = "zip"
  output_path = "${local.kira_build_dir}/${each.key}.zip"

  source {
    content  = file("${local.kira_src}/lambda/${each.value.source_dir}/lambda_function.py")
    filename = "lambda_function.py"
  }

  dynamic "source" {
    for_each = each.value.helper ? [1] : []
    content {
      content  = file("${local.kira_src}/lambda/common/eks_prometheus.py")
      filename = "eks_prometheus.py"
    }
  }
}

resource "aws_lambda_function" "kira_tool" {
  for_each = local.kira_tools

  function_name    = each.value.function
  role             = aws_iam_role.kira_lambda.arn
  runtime          = "python3.12"
  handler          = "lambda_function.lambda_handler"
  timeout          = 30
  filename         = data.archive_file.kira_tool[each.key].output_path
  source_code_hash = data.archive_file.kira_tool[each.key].output_base64sha256

  environment {
    variables = {
      CLUSTER_NAME       = module.eks.cluster_name
      LOG_GROUP_NAME     = aws_cloudwatch_log_group.boutique_pods.name
      PROMETHEUS_SERVICE = "monitoring/${local.prometheus_svc}:${local.prometheus_port}"
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.kira_lambda_basic,
    aws_iam_role_policy.kira_lambda_read,
  ]
}

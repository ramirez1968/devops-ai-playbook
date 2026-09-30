# Stage 6 logs: Fluent Bit ships boutique pod logs to CloudWatch, where
# Kira's fetch_logs tool reads them (default log group /eks/boutique/pods).

locals {
  fluent_bit_namespace       = "amazon-cloudwatch"
  fluent_bit_service_account = "aws-for-fluent-bit"
}

resource "aws_cloudwatch_log_group" "boutique_pods" {
  name              = "/eks/boutique/pods"
  retention_in_days = 7
}

# IRSA: only the Fluent Bit service account can assume this role.
data "aws_iam_policy_document" "fluent_bit_assume_role" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [module.eks.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${module.eks.oidc_issuer}:sub"
      values   = ["system:serviceaccount:${local.fluent_bit_namespace}:${local.fluent_bit_service_account}"]
    }
  }
}

resource "aws_iam_role" "fluent_bit" {
  name               = "${var.cluster_name}-fluent-bit-irsa"
  assume_role_policy = data.aws_iam_policy_document.fluent_bit_assume_role.json
}

resource "aws_iam_role_policy" "fluent_bit_logs" {
  name = "write-boutique-logs"
  role = aws_iam_role.fluent_bit.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "logs:CreateLogStream",
        "logs:DescribeLogStreams",
        "logs:PutLogEvents",
      ]
      Resource = [
        aws_cloudwatch_log_group.boutique_pods.arn,
        "${aws_cloudwatch_log_group.boutique_pods.arn}:*",
      ]
    }]
  })
}

resource "helm_release" "fluent_bit" {
  provider = helm.eks

  name             = "aws-for-fluent-bit"
  namespace        = local.fluent_bit_namespace
  create_namespace = true

  repository = "https://aws.github.io/eks-charts"
  chart      = "aws-for-fluent-bit"
  version    = "0.2.0"

  values = [
    yamlencode({
      serviceAccount = {
        create = true
        name   = local.fluent_bit_service_account
        annotations = {
          "eks.amazonaws.com/role-arn" = aws_iam_role.fluent_bit.arn
        }
      }

      # Only the boutique namespace — the app Kira investigates.
      input = {
        path = "/var/log/containers/*_boutique_*.log"
      }

      cloudWatchLogs = {
        enabled         = true
        region          = var.region
        logGroupName    = aws_cloudwatch_log_group.boutique_pods.name
        logStreamPrefix = "boutique-"
        autoCreateGroup = false
      }
    })
  ]

  depends_on = [aws_iam_role_policy.fluent_bit_logs]
}

# Step 4: AWS Load Balancer Controller. It watches Ingress resources and
# creates the ALB, listeners, and target groups for them.
#
# policies/aws-load-balancer-controller-iam-policy.json is the official
# policy for controller v3.5.0:
# https://github.com/kubernetes-sigs/aws-load-balancer-controller/blob/v3.5.0/docs/install/iam_policy.json

locals {
  lbc_namespace       = "kube-system"
  lbc_service_account = "aws-load-balancer-controller"
}

resource "aws_iam_policy" "lbc" {
  name   = "${var.cluster_name}-aws-load-balancer-controller"
  policy = file("${path.module}/policies/aws-load-balancer-controller-iam-policy.json")
}

data "aws_iam_policy_document" "lbc_assume_role" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [module.eks.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${module.eks.oidc_issuer}:sub"
      values   = ["system:serviceaccount:${local.lbc_namespace}:${local.lbc_service_account}"]
    }

    condition {
      test     = "StringEquals"
      variable = "${module.eks.oidc_issuer}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lbc" {
  name               = "${var.cluster_name}-aws-load-balancer-controller"
  assume_role_policy = data.aws_iam_policy_document.lbc_assume_role.json
}

resource "aws_iam_role_policy_attachment" "lbc" {
  role       = aws_iam_role.lbc.name
  policy_arn = aws_iam_policy.lbc.arn
}

resource "helm_release" "lbc" {
  provider = helm.eks

  name       = "aws-load-balancer-controller"
  namespace  = local.lbc_namespace
  repository = "https://aws.github.io/eks-charts"
  chart      = "aws-load-balancer-controller"
  version    = "3.5.0"

  values = [
    yamlencode({
      clusterName = module.eks.cluster_name
      region      = var.region
      vpcId       = module.vpc.vpc_id

      serviceAccount = {
        create = true
        name   = local.lbc_service_account
        annotations = {
          "eks.amazonaws.com/role-arn" = aws_iam_role.lbc.arn
        }
      }
    })
  ]

  depends_on = [aws_iam_role_policy_attachment.lbc]
}

# Only these addresses may reach the ALB (testing). The Ingress refers to
# this group by name, so the IPs themselves stay out of the public repo.
resource "aws_security_group" "alb_allowed" {
  name        = "boutique-alb-allowed"
  description = "Inbound HTTP to the boutique ALB from allow-listed addresses"
  vpc_id      = module.vpc.vpc_id

  ingress {
    description = "HTTP from allow-listed addresses"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = var.alb_allowed_cidrs
  }

  egress {
    description = "To targets in the VPC"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [var.vpc_cidr]
  }

  tags = {
    Name = "boutique-alb-allowed"
  }
}

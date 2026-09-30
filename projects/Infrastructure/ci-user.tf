# IAM user for GitHub Actions (Stage 3). It can only log in to ECR and
# push/pull images in this project's repositories.
#
# The access key is created by hand in the console, not here, so the
# secret never lands in Terraform state.

data "aws_caller_identity" "current" {}

resource "aws_iam_user" "github_ci" {
  name = "github-ci"
}

resource "aws_iam_user_policy" "github_ci_ecr_push" {
  name = "ecr-push"
  user = aws_iam_user.github_ci.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "EcrLogin"
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Sid    = "PushPullProjectRepos"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
          "ecr:PutImage",
        ]
        Resource = [
          for repo in var.repositories :
          "arn:aws:ecr:${var.region}:${data.aws_caller_identity.current.account_id}:repository/${repo}"
        ]
      },
    ]
  })
}

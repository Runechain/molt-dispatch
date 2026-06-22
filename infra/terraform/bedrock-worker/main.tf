# molt-dispatch Bedrock worker — AWS resources in us-east-1.
#
# Bedrock is NOT available in ca-west-1, so the Bedrock worker runs here and
# connects to the broker at https://play.runechaingame.com/grid (cross-region HTTP).
# The broker itself stays in ca-west-1.
#
# Apply this module AFTER the broker stack, once you have a broker API key stored
# in SSM Parameter Store (/molt/MOLT_API_KEY in us-east-1).

variable "account_id"         { type = string; default = "901889466248" }
variable "ecs_cluster_name"   { type = string; default = "molt-worker-cluster" }
variable "ecr_repo"           { type = string; default = "molt-broker" } # reuse broker image
variable "broker_url"         { type = string; default = "https://play.runechaingame.com/grid" }
variable "bedrock_model"      { type = string; default = "anthropic.claude-3-haiku-20240307-v1:0" }
variable "tags"               { type = map(string); default = { project = "molt-dispatch" } }

# --- Default VPC + subnets (auto-discovered; no manual vpc_id/subnet_ids needed) ---

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
  filter {
    name   = "defaultForAz"
    values = ["true"]
  }
}

# --- ECR (us-east-1) — the broker image reused as the worker image -----------
# The image is built once in ca-west-1 ECR. For cross-region pulls, either
# replicate the image to a us-east-1 ECR repo, or use cross-region ECR pull.
# Simplest for commissioning: build a second image here from the same source.

resource "aws_ecr_repository" "molt_worker" {
  name                 = "molt-bedrock-worker"
  image_tag_mutability = "MUTABLE"
  force_delete         = false
  tags                 = var.tags

  image_scanning_configuration { scan_on_push = true }
}

# --- CloudWatch log group (us-east-1) ----------------------------------------

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/ecs/molt-bedrock-worker"
  retention_in_days = 14
  tags              = var.tags
}

# --- ECS cluster for the worker ----------------------------------------------

resource "aws_ecs_cluster" "worker" {
  name = var.ecs_cluster_name
  tags = var.tags
}

# --- Worker SG: egress to broker (HTTPS 443) + Bedrock (HTTPS 443) ----------

resource "aws_security_group" "worker" {
  name        = "molt-bedrock-worker-sg"
  description = "molt Bedrock worker — outbound HTTPS to broker + Bedrock"
  vpc_id      = data.aws_vpc.default.id
  tags        = var.tags
}

resource "aws_vpc_security_group_egress_rule" "worker_https" {
  security_group_id = aws_security_group.worker.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

# --- SSM param: broker API key (create via `molt key create`, store manually) -

data "aws_ssm_parameter" "molt_api_key" {
  name = "/molt/MOLT_API_KEY"
}

# --- IAM task role: bedrock:InvokeModel + SSM read ---------------------------

resource "aws_iam_role" "worker_task" {
  name = "ecsTaskRoleMoltBedrockWorker"
  tags = var.tags

  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow"; Principal = { Service = "ecs-tasks.amazonaws.com" }; Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "worker_bedrock" {
  name = "molt-bedrock-invoke"
  role = aws_iam_role.worker_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
        Resource = "arn:aws:bedrock:us-east-1::foundation-model/*"
      },
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = "arn:aws:ssm:us-east-1:${var.account_id}:parameter/molt/*"
      }
    ]
  })
}

# --- ECS task definition + service -------------------------------------------

resource "aws_ecs_task_definition" "worker" {
  family                   = "molt-bedrock-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = "arn:aws:iam::${var.account_id}:role/ecsTaskExecutionRole"
  task_role_arn            = aws_iam_role.worker_task.arn
  tags                     = var.tags

  container_definitions = jsonencode([{
    name    = "molt-bedrock-worker"
    image   = "${aws_ecr_repository.molt_worker.repository_url}:latest"
    command = ["node", "bin/molt.mjs", "worker", "start", "--adapters", "bedrock", "--trust", "4"]

    environment = [
      { name = "MOLT_BROKER_URL",     value = var.broker_url },
      { name = "MOLT_BEDROCK_REGION", value = "us-east-1" },
      { name = "MOLT_BEDROCK_MODEL",  value = var.bedrock_model }
    ]

    secrets = [{ name = "MOLT_API_KEY", valueFrom = data.aws_ssm_parameter.molt_api_key.arn }]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = "/ecs/molt-bedrock-worker"
        "awslogs-region"        = "us-east-1"
        "awslogs-stream-prefix" = "ecs"
      }
    }

    healthCheck = {
      command     = ["CMD-SHELL", "node -e 'process.exit(0)'"]
      interval    = 60
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
  }])
}

resource "aws_ecs_service" "worker" {
  name            = "molt-bedrock-worker-service"
  cluster         = aws_ecs_cluster.worker.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = 1
  launch_type     = "FARGATE"
  tags            = var.tags

  network_configuration {
    subnets          = data.aws_subnets.default.ids
    security_groups  = [aws_security_group.worker.id]
    assign_public_ip = true
  }

  lifecycle {
    ignore_changes = [task_definition]  # updated by deploy-grid.yml
  }
}

output "worker_ecr_url"         { value = aws_ecr_repository.molt_worker.repository_url }
output "worker_task_role_arn"   { value = aws_iam_role.worker_task.arn }

# molt-dispatch broker — AWS resources in ca-west-1.
#
# SCOPE: owns EFS (SQLite persistence), broker SG + EFS SG, ECR repo,
#        ALB path-routing rule (/grid/*), target group, IAM task role,
#        and CloudWatch log group. Does NOT touch the ECS cluster, service,
#        or task definition (owned by .github/workflows/deploy-grid.yml).
#
# The ALB and its HTTPS listener are owned by the runechain terraform stack;
#  this stack reads them as data sources and adds one path-routing rule.

# --- Data: look up the existing ALB + HTTPS listener -------------------------

data "aws_lb" "runechain" {
  name = "runechain-alb"
}

data "aws_lb_listener" "https" {
  load_balancer_arn = data.aws_lb.runechain.arn
  port              = 443
}

data "aws_security_group" "alb" {
  name   = "runechain-alb-sg"
  vpc_id = var.vpc_id
}

# --- ECR repository -----------------------------------------------------------

resource "aws_ecr_repository" "molt_broker" {
  name                 = var.ecr_repository_name
  image_tag_mutability = "MUTABLE"
  force_delete         = false
  tags                 = var.tags

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "molt_broker" {
  repository = aws_ecr_repository.molt_broker.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 10 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}

# --- CloudWatch log group -----------------------------------------------------

resource "aws_cloudwatch_log_group" "broker" {
  name              = "/ecs/molt-broker"
  retention_in_days = 14
  tags              = var.tags
}

# --- EFS: durable SQLite storage (MOLT_DATA_DIR) ------------------------------

resource "aws_efs_file_system" "molt_data" {
  performance_mode = "generalPurpose"
  throughput_mode  = "bursting"
  encrypted        = true
  tags             = merge(var.tags, { Name = "molt-broker-data" })
}

resource "aws_efs_access_point" "molt_data" {
  file_system_id = aws_efs_file_system.molt_data.id

  posix_user {
    uid = 1000
    gid = 1000
  }
  root_directory {
    path = "/molt-data"
    creation_info {
      owner_uid   = 1000
      owner_gid   = 1000
      permissions = "755"
    }
  }
  tags = var.tags
}

# EFS SG: accepts NFS (2049) only from the broker task SG.
resource "aws_security_group" "efs" {
  name        = "molt-efs-sg"
  description = "molt-broker EFS - NFS from broker task only"
  vpc_id      = var.vpc_id
  tags        = var.tags
}

resource "aws_vpc_security_group_ingress_rule" "efs_nfs" {
  security_group_id            = aws_security_group.efs.id
  description                  = "nfs from broker"
  ip_protocol                  = "tcp"
  from_port                    = 2049
  to_port                      = 2049
  referenced_security_group_id = aws_security_group.broker.id
}

resource "aws_vpc_security_group_egress_rule" "efs_all" {
  security_group_id = aws_security_group.efs.id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_efs_mount_target" "molt_data" {
  for_each       = toset(var.subnet_ids)
  file_system_id = aws_efs_file_system.molt_data.id
  subnet_id      = each.value
  security_groups = [aws_security_group.efs.id]
}

# --- Broker task SG -----------------------------------------------------------

resource "aws_security_group" "broker" {
  name        = "molt-broker-sg"
  description = "molt-broker ECS task - accepts broker port from ALB only"
  vpc_id      = var.vpc_id
  tags        = var.tags
}

resource "aws_vpc_security_group_ingress_rule" "broker_from_alb" {
  security_group_id            = aws_security_group.broker.id
  description                  = "alb-to-broker"
  ip_protocol                  = "tcp"
  from_port                    = var.broker_port
  to_port                      = var.broker_port
  referenced_security_group_id = data.aws_security_group.alb.id
}

resource "aws_vpc_security_group_egress_rule" "broker_all" {
  security_group_id = aws_security_group.broker.id
  description       = "all outbound (ECR pull, EFS, Bedrock cross-region if needed)"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# --- ALB: path-routing rule for /grid and /grid/* ----------------------------

resource "aws_lb_target_group" "broker" {
  name        = "molt-broker-tg"
  port        = var.broker_port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"
  tags        = var.tags

  health_check {
    path                = "${var.broker_path_prefix}/health"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 30
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
  }

  deregistration_delay = 30
}

# Priority 10 — runs before the game's default action (lowest priority wins first).
resource "aws_lb_listener_rule" "broker_path" {
  listener_arn = data.aws_lb_listener.https.arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.broker.arn
  }

  condition {
    path_pattern {
      values = [var.broker_path_prefix, "${var.broker_path_prefix}/*"]
    }
  }

  tags = var.tags
}

# --- IAM: ECS task role for the broker ----------------------------------------
# Needs EFS client access. Does NOT need Bedrock — that's the worker's role.

resource "aws_iam_role" "broker_task" {
  name = "ecsTaskRoleMoltBroker"
  tags = var.tags

  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "broker_efs" {
  name = "molt-broker-efs"
  role = aws_iam_role.broker_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "elasticfilesystem:ClientMount",
        "elasticfilesystem:ClientWrite",
        "elasticfilesystem:ClientRootAccess"
      ]
      Resource = aws_efs_file_system.molt_data.arn
      Condition = {
        StringEquals = {
          "elasticfilesystem:AccessPointArn" = aws_efs_access_point.molt_data.arn
        }
      }
    }]
  })
}

# --- Outputs ------------------------------------------------------------------

output "ecr_repository_url" {
  value = aws_ecr_repository.molt_broker.repository_url
}

output "efs_file_system_id" {
  value = aws_efs_file_system.molt_data.id
}

output "efs_access_point_id" {
  value = aws_efs_access_point.molt_data.id
}

output "broker_target_group_arn" {
  value = aws_lb_target_group.broker.arn
}

output "broker_url" {
  value = "https://play.runechaingame.com${var.broker_path_prefix}"
}

output "broker_task_role_arn" {
  value = aws_iam_role.broker_task.arn
}

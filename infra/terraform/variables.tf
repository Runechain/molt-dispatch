# Mirrors the live ca-west-1 setup from the runechain stack.
# Override in terraform.tfvars for a different environment.

variable "region" {
  type    = string
  default = "ca-west-1"
}

variable "account_id" {
  type    = string
  default = "901889466248"
}

variable "vpc_id" {
  type    = string
  default = "vpc-05e82f4b084291854"
}

variable "subnet_ids" {
  description = "Public subnets across >=2 AZs (same as the runechain ALB)."
  type        = list(string)
  default     = [
    "subnet-0bceeb250ef0bf4db",  # ca-west-1a
    "subnet-08de4824a94138124",  # ca-west-1b
    "subnet-04906d678a142a10c",  # ca-west-1c
  ]
}

variable "ecs_cluster_name" {
  type    = string
  default = "runechain-cluster"
}

variable "broker_port" {
  type    = number
  default = 7077
}

variable "broker_path_prefix" {
  description = "ALB path prefix the broker sits behind. Must match MOLT_PATH_PREFIX in the task definition."
  type        = string
  default     = "/grid"
}

variable "ecr_repository_name" {
  type    = string
  default = "molt-broker"
}

variable "tags" {
  type    = map(string)
  default = { project = "molt-dispatch" }
}

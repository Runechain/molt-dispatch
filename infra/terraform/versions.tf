terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Recommended: remote state in the same S3 bucket as the runechain stack.
  # backend "s3" {
  #   bucket = "runechain-tfstate"
  #   key    = "molt-broker/terraform.tfstate"
  #   region = "ca-west-1"
  # }
}

provider "aws" {
  region = var.region
}

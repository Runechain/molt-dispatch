terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # backend "s3" {
  #   bucket = "runechain-tfstate"
  #   key    = "molt-bedrock-worker/terraform.tfstate"
  #   region = "us-east-1"
  # }
}

# Bedrock is NOT available in ca-west-1 — worker must live in us-east-1 or us-west-2.
provider "aws" {
  region = "us-east-1"
}

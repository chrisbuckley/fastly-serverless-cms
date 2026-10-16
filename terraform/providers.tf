terraform {
  required_version = ">= 1.5"

  required_providers {
    fastly = {
      source  = "fastly/fastly"
      version = "~> 9.2"
    }
  }
}

# API key is read from the FASTLY_API_KEY environment variable.
provider "fastly" {}

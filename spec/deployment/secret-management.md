# Secret Management

Personal: refresh token in Local Vault, Local Broker exchanges.
Enterprise: KMS/HSM, worker gets short-lived credential.
Runtime/Router/models CANNOT see long-term secrets.
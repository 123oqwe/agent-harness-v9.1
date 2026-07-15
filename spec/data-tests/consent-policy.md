# Data Testing Consent Policy

1. No production user data without explicit authorization
2. Synthetic data preferred
3. Public benchmarks with attribution
4. Consented staging: explicit opt-in, 90-day retention, pseudonymized
5. Production shadow: anonymized metrics only
6. Canary: real users opted into canary cohort

## Provider Tests
- Provider sandbox when available
- Dedicated staging tenant
- Capped spend
- Non-production recipients
- Deterministic cleanup
- Audit logs
- NEEDS_PROVIDER_VERIFICATION for untested behavior

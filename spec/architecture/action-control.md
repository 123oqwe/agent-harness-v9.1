# Action Control


![07-operation-state-machine.svg](diagrams/07-operation-state-machine.svg)

## Tool Execution Pipeline (12 steps)
1. Schema validation
2. Effect classification (EffectRisk)
3. Risk derivation (EffectRisk + Policy + Context -> DerivedRiskTier)
4. Policy evaluation (PEP)
5. Consent check
6. Capability issuance (Authorization Service signs)
7. PEP validation (verify token valid, not expired, not used)
8. Credential exchange (Secret Broker provides short-lived credential)
9. Sandbox/environment dispatch
10. Receipt capture
11. Postcondition verification
12. Audit (immutable audit event)

## v9 Corrections
- Policy enters BEFORE routing (not after)
- PEP at EVERY action (not just plan validation)
- Child Capability signed by Authorization Service (NOT parent)
- EffectRisk replaces static risk tiers
- Email compensation = unavailable (NOT retractable)
- Re-route creates new RunPlan revision + revokes old capabilities


## Implementation Notes

### Tool Execution Pipeline (12 steps)

```typescript
async function executeToolCall(call: ToolCall, ctx: ExecutionContext): Promise<ToolResult> {
  // 1. Schema validation
  validateInput(call.tool_name, call.args);
  // 2. Effect classification
  const effectRisk = extractEffectRisk(call.tool_name, call.args, ctx);
  // 3. Risk derivation
  const derivedRisk = deriveRiskTier(effectRisk, ctx.userPolicy, ctx.orgPolicy, ctx.context);
  // 4. Policy evaluation
  const policyDecision = policyEngine.evaluate(call, derivedRisk, ctx);
  if (!policyDecision.allowed) throw new PolicyDeniedError(policyDecision.reasons);
  // 5. Consent check
  const consentReq = deriveConsentRequirement(derivedRisk);
  if (consentReq.required) await requestHumanConsent(call, consentReq);
  // 6. Capability issuance
  const capability = await authorizationService.issueCapability(call, policyDecision, consentReq);
  // 7. PEP validation
  pep.validate(capability); // throws if expired, used, or invalid
  // 8. Credential exchange
  const credential = await secretBroker.exchange(capability.credential_scope);
  // 9. Sandbox dispatch
  const result = await sandbox.execute(call, credential, ctx.environment);
  // 10. Receipt capture
  const receipt = captureReceipt(result);
  // 11. Postcondition verification
  verifyPostconditions(call, result);
  // 12. Audit
  audit.log({ call, capability, result, receipt, timestamp: Date.now() });
  return result;
}
```

### EffectRisk Extraction
Each ToolSpec has a `risk_feature_extractor` field pointing to a function that returns EffectRisk.
Agent should implement extractors per tool during Phase 1.

### Risk Tier Derivation
```
EffectRisk + UserPolicy + OrgPolicy + Context → DerivedRiskTier (0-5)
```
- Tier 0-1: auto-approve
- Tier 2: session confirm
- Tier 3: session confirm + exact preview
- Tier 4: recent_password
- Tier 5: webauthn

Agent should tune tier thresholds during Phase 1 security testing.

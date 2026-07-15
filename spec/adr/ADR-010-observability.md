# ADR-010: Observability

## Status: ACCEPTED

## Rationale
OpenTelemetry is the SOTA vendor-neutral standard. Grafana stack (Prometheus+Loki+Tempo) is proven at scale. Local-first: traces stored locally, cloud gets desensitized metrics. Agent should verify OTel SDK integration in Phase 4.

## Decision
OpenTelemetry + Grafana stack (Prometheus + Loki + Tempo).

## Rationale
- OTel: vendor-neutral, structured metrics
- Grafana: unified dashboards
- Local-first: traces stored locally, cloud gets desensitized metrics only

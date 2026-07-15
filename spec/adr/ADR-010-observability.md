# ADR-010: Observability

## Decision
OpenTelemetry + Grafana stack (Prometheus + Loki + Tempo).

## Rationale
- OTel: vendor-neutral, structured metrics
- Grafana: unified dashboards
- Local-first: traces stored locally, cloud gets desensitized metrics only

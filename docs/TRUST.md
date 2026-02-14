# MemoryNode Trust & Security

**Trust entry point** — links to security, operations, and compliance documentation.

---

## Security & Compliance

| Document | Description |
|----------|-------------|
| [SECURITY.md](./SECURITY.md) | Auth, RLS, session design, no long-lived keys in browser, audit logging, secret rotation |
| [IDENTITY_TENANCY.md](./IDENTITY_TENANCY.md) | Identity model, workspace → API key scope, enforcement map |

---

## Operations & Reliability

| Document | Description |
|----------|-------------|
| [INCIDENT_PROCESS.md](./INCIDENT_PROCESS.md) | Severity taxonomy (S0–S3), postmortem template, error budget policy |
| [OBSERVABILITY.md](./OBSERVABILITY.md) | SLO definitions, golden metrics, health view |
| [ALERTS.md](./ALERTS.md) | Alert rules, triage playbooks |
| [OPERATIONS.md](./OPERATIONS.md) | Secrets inventory, rollback, incident checklist |

---

## Status & SLOs

- **Status page:** [status.memorynode.ai](https://status.memorynode.ai) (or your deployed status URL)
- **SLO targets:** See [OBSERVABILITY.md](./OBSERVABILITY.md) §4 and §4.1

---

## Data & Audit

| Document | Description |
|----------|-------------|
| [DATA_RETENTION.md](./DATA_RETENTION.md) | Data deletion, retention policy, audit trail (create if not present) |
| [TRUST_CHANGELOG.md](./TRUST_CHANGELOG.md) | Security and ops improvements by date |

*Note: DATA_RETENTION.md and TRUST_CHANGELOG.md are created as part of public proof artifacts. Until then, see SECURITY.md for data handling.*

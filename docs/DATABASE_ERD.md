# Magnet OS target database ERD

This is the conceptual normalized target. It is not yet the live schema.

```mermaid
erDiagram
  AUTH_USERS ||--|| PROFILES : has
  PROFILES ||--o{ ORGANIZATION_MEMBERS : joins
  ORGANIZATIONS ||--o{ ORGANIZATION_MEMBERS : contains
  ROLES ||--o{ ORGANIZATION_MEMBERS : assigned
  ROLES ||--o{ ROLE_CAPABILITIES : grants
  CAPABILITIES ||--o{ ROLE_CAPABILITIES : included
  ORGANIZATIONS ||--o{ ORGANIZATION_INVITATIONS : issues
  ROLES ||--o{ ORGANIZATION_INVITATIONS : intends
  ORGANIZATIONS ||--o{ CLIENTS : owns
  CLIENTS ||--o{ CLIENT_STAKEHOLDERS : has
  CLIENTS ||--o{ CLIENT_TEAM_MEMBERS : served_by
  ORGANIZATION_MEMBERS ||--o{ CLIENT_TEAM_MEMBERS : assigned
  CLIENTS ||--o{ PROJECTS : runs
  PROJECTS ||--o{ TASKS : contains
  PROJECTS ||--o{ DELIVERABLES : produces
  DELIVERABLES ||--o{ APPROVALS : reviewed_by
  CLIENTS ||--o{ REQUESTS : submits
  CLIENTS ||--o{ MEETINGS : holds
  MEETINGS ||--o{ DECISIONS : records
  CLIENTS ||--o{ REPORTS : receives
  ORGANIZATIONS ||--o{ AUDIT_EVENTS : records
  ORGANIZATIONS ||--o{ OUTBOX_MESSAGES : emits
  ORGANIZATIONS ||--o{ SUBSCRIPTIONS : subscribes
  PLANS ||--o{ SUBSCRIPTIONS : selected
  PLANS ||--o{ PLAN_ENTITLEMENTS : includes
  ENTITLEMENTS ||--o{ PLAN_ENTITLEMENTS : defined
```

All tenant business entities carry or enforce organization ownership. Sensitive employee/finance details are intentionally omitted from the broad ERD and belong in capability-protected one-to-one/child tables.

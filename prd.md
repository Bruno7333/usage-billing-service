# Product Requirements Document (PRD)

# Product Name

## Usage Metering & Subscription Billing Service

**Version:** 1.0
**Project Type:** Backend Infrastructure / SaaS Billing Platform
**Target Difficulty:** Medium
**Estimated Timeline:** 6 Weeks

---

# 1. Product Overview

## Problem Statement

SaaS applications need reliable systems to track customer usage, enforce subscription limits, calculate costs, and synchronize payments with billing providers.

Incorrect billing logic can result in:

* customers being overcharged
* lost revenue from missed usage
* inconsistent subscription states
* inaccurate invoices

This project will build a production-style billing infrastructure service that answers:

* How much has a customer used?
* What does their usage cost?
* Are they allowed to continue using the service?
* What subscription plan are they currently on?

---

# 2. Product Goal

Build a backend service capable of:

1. Recording customer usage accurately
2. Preventing duplicate usage charges through idempotency
3. Enforcing plan-based quotas
4. Calculating usage-based costs
5. Integrating Stripe subscriptions
6. Maintaining subscription state through secure webhooks

The system should demonstrate production-level backend reliability and correctness.

---

# 3. Target Users

## SaaS Customers

Customers using an application that charges based on:

* API calls
* AI token consumption
* other metered resources

## SaaS Developers

Developers integrating the billing service into their applications.

## Administrators

Operators monitoring:

* customer usage
* subscriptions
* revenue

---

# 4. Core Features

# 4.1 Tenant Management

The system must support multiple isolated customers (tenants).

Each tenant has:

* a subscription plan
* usage limits
* subscription status
* Stripe customer information

Example:

```
Tenant:
Acme AI

Plan:
Pro

Monthly API Calls:
100,000

Monthly Tokens:
10,000,000
```

---

# 4.2 Subscription Plans

The system supports two plans.

## Free Plan

Limits:

* 1,000 API calls/month
* 100,000 AI tokens/month

## Pro Plan

Limits:

* 100,000 API calls/month
* 10,000,000 AI tokens/month

Plans contain:

* name
* monthly price
* API quota
* token quota

---

# 4.3 Usage Metering

The system records every billable action.

Example:

```
Customer sends AI request

↓

Usage Event Created

↓

Monthly Usage Updated
```

Each usage event contains:

* tenant ID
* usage type
* quantity
* timestamp
* idempotency key

---

# 4.4 Idempotent Metering

The system must guarantee that retries never double-count usage.

Example:

Request:

```
POST /usage

Idempotency-Key:
abc123
```

First request:

```
Usage +1
```

Retry:

```
Same key detected

No new usage recorded
```

Requirement:

A single idempotency key must create exactly one usage event.

---

# 4.5 Quota Enforcement

Before accepting billable usage:

The system checks:

```
Current Usage + Requested Usage <= Plan Limit
```

If allowed:

```
200 OK
```

If exceeded:

```
429 Too Many Requests
```

Example response:

```json
{
  "error": "Monthly API quota exceeded",
  "usage": 1000,
  "limit": 1000
}
```

Future support:

```
402 Payment Required
```

for billing failures.

---

# 4.6 Cost Calculation

The system calculates monthly customer cost.

Supported usage:

* API calls
* AI tokens

Example:

```
Total Cost =
API Usage Cost
+
Token Usage Cost
```

AI token rules:

* Cached input tokens have reduced pricing
* Reasoning tokens count as output tokens
* Reasoning tokens must not be double-counted

Pricing values must be stored as fixed configuration constants.

---

# 4.7 Stripe Subscription Integration

The system integrates with Stripe Test Mode.

Customers can:

* create subscriptions
* upgrade plans
* cancel subscriptions

Subscription flow:

```
Customer

↓

Create Checkout Session

↓

Stripe Checkout

↓

Stripe Webhook

↓

Update Tenant Plan
```

---

# 4.8 Webhook Processing

Stripe webhook handling must:

* verify signatures
* reject forged requests
* prevent duplicate processing

Supported events:

```
checkout.session.completed

customer.subscription.updated

customer.subscription.deleted
```

Duplicate webhook:

```
Ignore
Return 200
```

Invalid webhook:

```
Reject
Return 400
```

---

# 5. Technical Requirements

## Database

PostgreSQL database containing:

### Tenants

```
id
name
plan_id
subscription_status
stripe_customer_id
stripe_subscription_id
```

---

### Plans

```
id
name
monthly_price
api_limit
token_limit
```

---

### Usage Events

```
id
tenant_id
usage_type
quantity
idempotency_key
created_at
```

---

### Subscriptions

```
id
tenant_id
stripe_subscription_id
status
created_at
updated_at
```

---

### Processed Webhooks

```
id
stripe_event_id
processed_at
```

---

# 6. API Requirements

## Record Usage

```
POST /usage/record
```

Purpose:

Records billable activity.

Requirements:

* requires authentication
* requires idempotency key
* validates quota
* records usage event

---

## Get Usage

```
GET /usage
```

Returns:

```json
{
  "apiCalls": 500,
  "tokens": 50000,
  "cost": 2.50
}
```

---

## Create Checkout Session

```
POST /billing/checkout
```

Creates Stripe subscription checkout.

---

## Stripe Webhook

```
POST /webhooks/stripe
```

Handles subscription updates.

---

# 7. Non-Functional Requirements

## Reliability

The system must:

* prevent duplicate billing
* maintain accurate usage records
* process webhooks safely

---

## Security

The system must:

* isolate tenant data
* validate all input
* verify Stripe signatures
* authenticate API requests

---

## Performance

Targets:

* quota checks under 100ms
* usage lookup under 200ms

---

# 8. Testing Requirements

The following tests must pass:

## Idempotency Test

Given:

Two requests with the same idempotency key

Expected:

One usage event.

---

## Quota Boundary Test

Given:

Customer reaches quota limit

Expected:

Next request receives 429.

---

## Cost Calculation Test

Given:

Known token usage

Expected:

Correct calculated cost.

---

## Webhook Security Test

Given:

Invalid Stripe signature

Expected:

Webhook rejected.

---

## Duplicate Webhook Test

Given:

Same Stripe event twice

Expected:

Only processed once.

---

# 9. Success Criteria

The project is complete when:

* Usage is recorded exactly once
* Quotas are enforced correctly
* Costs match expected calculations
* Stripe subscriptions update tenant status
* Webhooks are secure and idempotent
* Automated tests pass
* Architecture documentation exists

---

# 10. Future Enhancements

Possible extensions:

* overage billing
* invoices
* monthly statements
* usage dashboards
* usage alerts
* spending forecasts
* subscription proration
* nightly Stripe reconciliation jobs

---

# 11. Deliverables

Final submission includes:

* Backend application
* PostgreSQL schema
* Stripe test integration
* Automated test suite
* API documentation
* Architecture diagram
* README
* Demo showing:

  * quota enforcement
  * idempotent usage tracking
  * Stripe upgrade flow
  * webhook verification
  * usage cost calculation

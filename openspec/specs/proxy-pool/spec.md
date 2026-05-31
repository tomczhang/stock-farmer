## ADDED Requirements

### Requirement: Proxy pool initialization

The system SHALL initialize a proxy pool from an external provider URL configured via the `PROXY_PROVIDER_URL` environment variable.

The provider URL SHALL return a list of proxy addresses (one per line, format `ip:port` or `http://ip:port`).

If `PROXY_PROVIDER_URL` is not set, the system SHALL operate in direct-connect mode (no proxy) and log a warning.

#### Scenario: Provider URL configured
- **WHEN** `PROXY_PROVIDER_URL` is set and the provider returns 10 proxy addresses
- **THEN** system initializes the pool with 10 proxies, all marked as healthy

#### Scenario: Provider URL not configured
- **WHEN** `PROXY_PROVIDER_URL` is not set
- **THEN** system operates without proxies and logs a warning "No proxy provider configured, using direct connection"

#### Scenario: Provider URL unreachable
- **WHEN** `PROXY_PROVIDER_URL` is set but the provider is unreachable
- **THEN** system falls back to direct-connect mode and logs an error

### Requirement: Proxy selection with rotation

The system SHALL provide a `get_proxy() -> str | None` method that returns the next healthy proxy from the pool using round-robin rotation.

If no healthy proxies are available, the method SHALL return `None` (indicating direct connect).

#### Scenario: Normal rotation
- **WHEN** pool has 3 healthy proxies [A, B, C] and `get_proxy()` is called 4 times
- **THEN** system returns A, B, C, A in sequence

#### Scenario: Skip unhealthy proxy
- **WHEN** pool has 3 proxies [A, B, C] and B is marked unhealthy
- **THEN** `get_proxy()` returns A, C, A, C in sequence, skipping B

#### Scenario: All proxies unhealthy
- **WHEN** all proxies in the pool are marked unhealthy
- **THEN** `get_proxy()` returns `None`

### Requirement: Proxy health management

The system SHALL track each proxy's success and failure counts.

A proxy SHALL be marked unhealthy after 3 consecutive failures.

An unhealthy proxy SHALL be retried after a cooldown period of 120 seconds.

The caller SHALL report proxy usage results via `report_success(proxy)` and `report_failure(proxy)` methods.

#### Scenario: Proxy fails consecutively
- **WHEN** proxy A fails 3 times in a row via `report_failure(A)`
- **THEN** proxy A is marked unhealthy and excluded from rotation

#### Scenario: Proxy recovers after cooldown
- **WHEN** proxy A has been unhealthy for 120 seconds
- **THEN** proxy A is included in rotation again on the next `get_proxy()` call

#### Scenario: Success resets failure count
- **WHEN** proxy A has 2 consecutive failures and then `report_success(A)` is called
- **THEN** proxy A's failure count resets to 0 and it remains healthy

### Requirement: Proxy pool refresh

The system SHALL periodically refresh the proxy list from the provider URL.

The refresh interval SHALL default to 300 seconds (5 minutes) and be configurable via `PROXY_REFRESH_INTERVAL` environment variable.

#### Scenario: Periodic refresh
- **WHEN** 300 seconds have elapsed since the last refresh
- **THEN** system fetches a new proxy list from the provider URL and merges with the existing pool (adding new proxies, keeping health state of existing ones)

#### Scenario: Refresh adds new proxies
- **WHEN** refresh returns proxies [A, B, C, D] and current pool has [A, B] (C was removed, D is new)
- **THEN** pool becomes [A, B, D] with A and B retaining their health state and D marked as healthy

### Requirement: Proxy integration with adapters

Adapters that require proxy support (e.g., EastMoney push2his for K-line data) SHALL accept an optional `proxy: str | None` parameter in their HTTP requests.

The router SHALL call `proxy_pool.get_proxy()` before invoking such adapters and call `report_success/report_failure` after the request completes.

#### Scenario: K-line request with proxy
- **WHEN** router dispatches a 5-minute K-line request to EastMoney push2his adapter
- **THEN** router obtains a proxy from the pool, passes it to the adapter, and reports success/failure back to the pool

#### Scenario: K-line request without proxy (direct)
- **WHEN** proxy pool returns `None` (no proxies available)
- **THEN** adapter makes the request without a proxy (direct connection)

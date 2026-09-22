# Security Policy

## Scope

This is a portfolio project, not a production service — there is no hosted deployment
and no SLA. That said, the security-relevant behavior of the code itself (auth,
per-tenant isolation, rate limiting) is taken seriously and is documented, not
hand-waved.

## Reporting a vulnerability

If you find a security issue in this codebase (e.g. an auth bypass, a way to read or
affect another tenant's data, a way to defeat rate limiting), please **do not** open a
public GitHub issue. Instead, email **shivang.vakharia@devxlabs.ai** with:

- A description of the issue and its impact
- Steps to reproduce (a minimal `curl` example is ideal, given the HTTP surface)
- The affected file(s)/endpoint(s), if known

You should get an acknowledgment within a few days. There's no bug-bounty program —
this is a solo portfolio project — but genuine reports are appreciated and will be
credited (with permission) once fixed.

## Known, already-documented gaps

The following are **known and intentionally documented**, not undisclosed
vulnerabilities — no need to report these specifically (though feedback on the
tradeoff itself is welcome via a normal issue):

- **`GET /aggregates/:tenantId` is unauthenticated.** Any caller can query any
  tenant's usage totals. See [README § Known Limitations](README.md#known-limitations)
  and [`docs/DECISIONS.md`](docs/DECISIONS.md#known-confirmed-gaps--not-silent-omissions).
- **No durable event log.** A process restart drops all in-memory state; there is no
  persistence layer to secure or attack in the first place, but also no durability
  guarantee. See the same sections above.
- **The dedup window is bounded**, so a retry arriving after the window closes is
  billed again rather than deduplicated — a correctness tradeoff, not an auth issue,
  documented in [`docs/DECISIONS.md`](docs/DECISIONS.md#bounded-dedup-window).

If you find a way to exploit any of these beyond what's described above (e.g. reading
`GET /aggregates` was expected to leak only totals, but you've found a way to extract
more), that **is** worth a private report.

## Supported versions

This project has not yet reached a `1.0` release; there is a single actively developed
line (`main`). Security fixes land on `main`.

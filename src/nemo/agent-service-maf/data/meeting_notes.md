# Engineering All-Hands — 2026-03-25

## Announcements

- Q1 hiring target met: 3 new engineers starting April 1
- Office move to Building C scheduled for May 15
- Annual hackathon dates confirmed: June 10-12

## Project Updates

- **Phoenix Migration**: On track for April 30 deadline. DB schema review scheduled for April 2. Bob flagged CI flakiness — SRE team investigating.
- **Lighthouse Dashboard**: Shipped on time. Post-launch monitoring shows 40% faster page loads. Alice's team moving to Titan API v2 next.
- **Titan API v2**: Architecture proposal circulated. Review meeting April 5. Irene wants to adopt gRPC for internal services. Need to decide on backwards compatibility approach.

## Action Items

1. @bob — File CI flakiness ticket with SRE by March 28
2. @irene — Finalize gRPC vs REST decision doc by April 3
3. @carol — Share Q2 roadmap draft with leadership by April 1
4. @all — Submit hackathon team registration by May 30

## Risks

- Phoenix Migration has hard dependency chain: DB approval → data migration → API cutover. Any delay cascades.
- Two senior engineers (Eva, Hassan) have PTO overlap in April (2 weeks). Design capacity will be reduced.

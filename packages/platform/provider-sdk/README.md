# GOWM Provider SDK

The SDK implements the provider-protocol mechanics shared by controlled GOWM
provider bridges. It deliberately contains no provider-to-provider client and no
GIS engine. Operation handlers receive only their validated input, trusted scope
context, deadline signal, Gateway context, and logical snapshot context.

`ProviderHandlerContext.snapshots` separates caller constraints (`requested`)
from the resource versions already fixed by the Gateway (`effective`). Both
values are validated, hash-attested logical manifests and are never database
transaction identifiers. For compatibility with older Gateways, a request that
only carries `requestedSnapshot` exposes an independent structured clone as both
`requested` and `effective`. Handler mutation cannot affect the wire request or
alias the two context values. Snapshot context is included in provider
idempotency binding, so replaying an idempotency key against different logical
resources fails closed.

Public platform shapes are imported from the generated contract runtime. SDK
types describe only runtime behavior and do not redefine wire contracts.

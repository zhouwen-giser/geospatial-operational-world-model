# GOWM Provider SDK

The SDK implements the provider-protocol mechanics shared by controlled GOWM
provider bridges. It deliberately contains no provider-to-provider client and no
GIS engine. Operation handlers receive only their validated input, trusted scope
context, deadline signal, and an explicit resource budget.

Public platform shapes are imported from the generated contract runtime. SDK
types describe only runtime behavior and do not redefine wire contracts.

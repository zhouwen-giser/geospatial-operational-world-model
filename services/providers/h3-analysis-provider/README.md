# H3 analysis provider

`gowm.h3.analysis.bridge@0.2.0` exposes only aggregate, coverage, and flow. It
uses independent high-cost QoS with a 10 s default/30 s maximum timeout and
five-million-cell hard limit. v0.2 advertises synchronous execution only;
oversized work is rejected rather than falsely queued.

Every flow trajectory is a separately identified, gap-free sequence. The
bridge strips sequence identifiers before invoking the Toolkit API and never
joins two sequences, so an UNKNOWN MobilityDB gap cannot create a transition.

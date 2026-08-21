# drydock

`drydock` is the daemon-free execution vehicle used to construct and drive a RuntimeUnderTest.

It must not import a host daemon, server identity, or credential broker. `sea-trial` owns the shared judgments; drydock only supplies the vehicle. Files under `probes/` explore real native behavior and may inform a future contract, but they are not conformance cases.

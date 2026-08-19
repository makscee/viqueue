# ADR 0011: private-alpha trust boundaries

Status: accepted for private alpha

The private alpha deliberately has no IAM layer. Access and workflow identity are separate:

- The phone gateway's active paired browser devices, each proved on every API request, are the phone access boundary. Pairing identifies a browser profile, not a person; individual revocation ends that device's access.
- The board actor selector is trusted workflow identity for human attribution and inbox routing. Selecting an actor grants no network access and is not authentication.
- The core listener defaults to loopback. The phone gateway also listens on loopback; any approved private TLS/tailnet ingress must remain non-public. Funnel and public ingress are outside this boundary.
- Agent mutations are authorized by the current claim's complete `claim_id`, actor, generation, and claim token. Actor registration, assignment, and the board selector do not grant agent mutation authority.

These boundaries are accepted only for the private alpha. Do not expose the core listener or actor selector to untrusted clients, and do not reinterpret this decision as production authentication or authorization.

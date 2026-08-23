# Email draft responder trigger pack

This is the first-party example for the `triggerPack` manifest surface. It packages:

- the Gmail source/event declaration;
- the reusable plan template and its input schema;
- the inbound-message filter and default storm policy; and
- explicit snapshot-safe OAuth metadata (`secret`, `shareable:false`, `snapshotPolicy:strip`, and scopes).

It is a manifest-only plugin, not a code-tool `kind:"pack"`. Cupboard installation copies it
through the existing plugin installer and invalidates the plugin host so the descriptor becomes
discoverable. Installation never arms the binding; connect/instantiate/arm remain separate steps.

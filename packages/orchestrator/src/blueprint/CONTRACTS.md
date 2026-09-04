# Blueprint composition contracts

`identities-v1-2026-08-30` P-037 separates five concepts without creating a
second package, store, loader, or marketplace:

1. `IdentitySourceDocumentSchema` validates an authored identity layer. Source
   kind is orthogonal to runnable capability: a source may be both. Its fields
   are constrained to package metadata plus the vocabulary derived directly
   from `BlueprintSchema`; slot-specific authority remains enforced by the
   existing identity lint.
2. `RunnableBlueprintSchema` validates the inherited/defaulted executable
   configuration.
3. `ResolvedAgentSpecificationSchema` is the immutable, versioned compiler
   output contract. P-038 makes the composition compiler its sole producer.
4. `SessionActivationSchema` records desired, prepared, and applied
   specification/state revisions. P-040 supplies acknowledgement and recovery.
5. `ActorPrincipalSchema` keeps accountable actor, authenticated principal, and
   session attribution independent of the identity a session wears.

All five remain inside the existing blueprint package envelope and file → PG
projection path. `slots:` is still the identity declaration, but it is read from
the source document itself. Inherited slots never reclassify the root source.

## Version migration

Resolved specifications and session activations begin at schema version 1.
Changing a required field or its meaning requires a new schema version, a reader
for the previous version, and an explicit regeneration/migration of persisted
artifacts before the old reader is removed. Prompt-only and addressed-document
changes must produce a new specification revision even when blueprint YAML is
unchanged. Unknown schema versions fail closed; they are not coerced to v1.

## Finite compatibility adapters

- `BlueprintSchema` / `Blueprint` remain the historical resolved-runnable names.
  Remove them after every loader consumer accepts `RunnableBlueprint`, P-038 is
  the sole producer of `ResolvedAgentSpecification`, and the PG projection
  stores its schema/specification revisions.
- `LoadedBlueprint.blueprint` remains the historical result property. Remove it
  after all call sites consume the P-038 specification output and an LSP
  reference query reports no production consumers.
- `isIdentityDocument` remains the historical shape-only helper and is never
  used for new classification. Remove it when an LSP reference query finds no
  callers outside its compatibility test; new code uses the discriminated
  wrapper returned by `parseBlueprintSourceDocument`.

These are removal conditions, not permanent deprecation aliases. The alpha
implementation should delete each adapter as soon as its stated condition is
true.

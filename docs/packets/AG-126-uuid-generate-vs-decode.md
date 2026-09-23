# AG-126 — UUID generate and decode are two operations (DU-10)

## Branch

`claude/AG-126-uuid-operations` from the latest `origin/main`. Record the base SHA.

## Allowed files

```text
plugins/uuid/**
```

## Required reading

`docs/parity/DU-10.md` row 20, which found this; the DU-10 card in
`docs/DEVUTILS_REQUIREMENTS.md`; the **trigger.modes** and **options belong to
an operation** paragraphs in `docs/PLUGIN_HOST_IMPLEMENTATION.md`; and
`docs/WORKER_PROTOCOL.md`, including "Where an expected value comes from".

## Goal

`identity.uuid` is broken in the app today, and the cause is a packet-level
design problem the audit spotted from the manifest alone.

Reproduced in the built window:

```text
select UUID Generator      -> dcf33694-5861-4b48-8788-2ae7c47d9e47
type "hello" in the editor -> ● UUID must be canonical xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
                              (output: none)
```

One operation serves two modes through the `mode` option, and it declares
`trigger.modes: ["explicit", "inputChange", "heldRepeat"]`. Decode wants
`inputChange` — you type a UUID and it decodes. Generate must not have it:
the document is not its input, so typing feeds text to a port that only
decode should read, and the tool fails on a document the user is simply
writing in. (The `inputChange` was added by the integrator in #82 to keep
decode live; the mistake was adding it to an operation that also generates.)

Two modes with different inputs and different trigger policies are two
operations. Make them two.

## Requirements

- Two operations in place of one:
  - `identity.uuid.generate` — title `Generate`, **no document input**,
    `trigger.modes: ["explicit", "heldRepeat"]`, options `version`,
    `namespace`, `name`, `count`, `case`.
  - `identity.uuid.decode` — title `Decode`, one document input `uuid`
    (`required: true`, `contentKinds: ["text"]`, `maxBytes` as today),
    `trigger.modes: ["explicit", "inputChange"]`, options `case` only.
- The `mode` option disappears: the operation now carries that meaning, which
  is what makes the trigger policy expressible. The `uuid` **option** also
  goes; decode reads the document.
- The tool keeps id `identity.uuid`, title `UUID Generator`, its workspace and
  its generator kind, and lists both operation ids.
- Errors keep their codes. Decode of a non-canonical string stays
  `uuid.invalid`; generate with a missing name for v3/v5 stays as it is.
- README: state that generating never reads the document, and that the two
  operations exist because they are triggered differently.

## Checks

```text
node --experimental-strip-types --test plugins/uuid/test.mjs
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin identity.uuid --operation identity.uuid.generate --options '{"version":"v5","namespace":"dns","name":"example.com"}'
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin identity.uuid --operation identity.uuid.decode --input "input=cfbff0d1-9375-5685-968c-48ce8b15ae17"
pnpm --dir apps/desktop build
git diff --check
```

## Evidence

Both headless outputs; test and fixture counts; and the RFC check below,
quoted in your status.

**The oracle for v5 is RFC 4122, not this package.** v5 of the DNS namespace
and `example.com` is `cfbff0d1-9375-5685-968c-48ce8b15ae17` — SHA-1 over the
namespace bytes followed by the name, with the version and variant bits set.
Assert that exact value. A v4 UUID has no oracle: assert its shape, its
version and variant nibbles, and that two runs differ; do not pin a value.

## Out of scope

ULID, the shell (the integrator will confirm in the window that typing no
longer breaks the tool), and any change to how the generator draws entropy.
